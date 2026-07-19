/**
 * ============================================================================
 * PHASE 2: SHIPPING & RECONCILIATION ENGINE (UPDATED V5 - FIXED LOGIC)
 * Processes remote human feedback, evaluates systemic mismatches dynamically,
 * enforces optimized data schemas, and applies GDE review dropdowns.
 * ============================================================================
 */
function runPhase2Reconciliation() {
  var hostSs = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  
  // 1. Solicit Remote Sheet URL via Prompt
  var response = ui.prompt("Execute Phase 2 Shipping", "Provide the URL of the QC Team sheet workspace:", ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  
  var remoteUrl = response.getResponseText().trim();
  if (!remoteUrl) {
    ui.alert("Error: URL cannot be blank.");
    return;
  }
  
  var remoteSs;
  try {
    remoteSs = SpreadsheetApp.openByUrl(remoteUrl);
  } catch(e) {
    ui.alert("Access Failure: Unable to interface with the provided URL. Verify permissions.");
    return;
  }
  
  // 2. Ingest Local Master Snapshots & Agent Matrices for dynamic mismatch evaluation
  var snapshotSheet = hostSs.getSheetByName("Mapfacts_Snapshot");
  var comparisonSheet = hostSs.getSheetByName("Comparison_Agent_Output");
  if (!snapshotSheet || !comparisonSheet) {
    ui.alert("Error: Missing local 'Mapfacts_Snapshot' or 'Comparison_Agent_Output' master records.");
    return;
  }
  
  var rawSnapshot = snapshotSheet.getDataRange().getValues();
  var snapHeaders = rawSnapshot[0];
  var snapMap = getHeaderMap(snapHeaders);
  
  var rawComparison = comparisonSheet.getDataRange().getValues();
  var compHeaders = rawComparison[0];
  var compMap = getHeaderMap(compHeaders);
  
  // Build a constant-time lookup map for the original automated Comparison Agent findings
  var compAgentCache = {};
  for (var c = 1; c < rawComparison.length; c++) {
    var cRow = rawComparison[c];
    var cId = cRow[compMap["id"]];
    if (cId) {
      compAgentCache[cId] = {
        ai_address: cRow[compMap["ai_address"]] || "",
        ai_phone: cRow[compMap["ai_phone"]] || "",
        ai_website: cRow[compMap["ai_website"]] || "",
        ai_hours: cRow[compMap["ai_operatinghours"]] || "",
        res_address: cRow[compMap["address_result"]] ? cRow[compMap["address_result"]].toString().toLowerCase().trim() : "",
        res_phone: cRow[compMap["phone_result"]] ? cRow[compMap["phone_result"]].toString().toLowerCase().trim() : "",
        res_website: cRow[compMap["website_result"]] ? cRow[compMap["website_result"]].toString().toLowerCase().trim() : "",
        res_hours: cRow[compMap["hours_result"]] ? cRow[compMap["hours_result"]].toString().toLowerCase().trim() : ""
      };
    }
  }
  
  // 3. Fetch remote data matrices into memory
  var remoteLeftOver = getRemoteData(remoteSs, "Left_Over");
  var remoteHumanReview = getRemoteData(remoteSs, "Human_Review");
  var remoteDuplicateReview = getRemoteData(remoteSs, "Duplicate_Review");
  
  var remoteBugsAddress = getRemoteData(remoteSs, "Bugs_Address");
  var remoteBugsPhone = getRemoteData(remoteSs, "Bugs_Phone");
  var remoteBugsHours = getRemoteData(remoteSs, "Bugs_Hours");
  var remoteBugsWebsite = getRemoteData(remoteSs, "Bugs_Website");
  var remoteManualBug = getRemoteData(remoteSs, "Manual_Bug_Tab");
  
  // 4. Instantiate High-Performance Object Resolution Maps
  var processedIds = {};            
  var processedHashes = {};         
  var finalSpamDuplicates = [];
  var reRunQueue = [];
  
  // Target parameter allocation buffers
  var baseAddressOverrides = {};
  var basePhoneOverrides = {};
  var baseHoursOverrides = {};
  var baseWebsiteOverrides = {};
  
  var evidenceSourceTracker = {};
  var updateSourceTracker = {};
  
  // ==========================================
  // PIPELINE PROCESS BLOCK 1: DROPS & RE-RUN ROUTING
  // ==========================================
  
  // Left_Over
  if (remoteLeftOver && remoteLeftOver.length > 1) {
    var loMap = getHeaderMap(remoteLeftOver[0]);
    for (var l = 1; l < remoteLeftOver.length; l++) {
      var loRow = remoteLeftOver[l];
      var loId = loRow[loMap["id"]];
      if (!loId) continue;
      var loAction = loRow[loMap["qc_action"]];
      
      if (loAction === "Spam" || loAction === "Duplicate") {
        finalSpamDuplicates.push([loId, loRow[loMap["mapfacts_address"]], "Left_Over", loAction]);
        processedIds[loId] = "dropped";
      } else if (loAction === "Found Website Link" && loRow[loMap["qc_discovered_website"]]) {
        var discoveredUrl = loRow[loMap["qc_discovered_website"]].toString().trim();
        reRunQueue.push([loId, discoveredUrl, "website", discoveredUrl]);
        processedIds[loId] = "rerun";
      }
    }
  }
  
  // Duplicate Review
  if (remoteDuplicateReview && remoteDuplicateReview.length > 1) {
    var dupMap = getHeaderMap(remoteDuplicateReview[0]);
    for (var d = 1; d < remoteDuplicateReview.length; d++) {
      var dupRow = remoteDuplicateReview[d];
      var dupId = dupRow[dupMap["id"]];
      if (!dupId) continue;
      var dupStatus = dupRow[dupMap["qc_status"]];
      
      if (dupStatus === "Duplicate" || dupStatus === "Spam") {
        finalSpamDuplicates.push([dupId, dupRow[dupMap["mapfacts_address"]], "Duplicate_Review", dupStatus]);
        processedIds[dupId] = "dropped";
      } else if (dupStatus === "Not Duplicate") {
        processedIds[dupId] = "evaluate_mismatch"; // Explicit evaluation anchor
      }
    }
  }
  
  // Human Review
  if (remoteHumanReview && remoteHumanReview.length > 1) {
    var hrMap = getHeaderMap(remoteHumanReview[0]);
    for (var h = 1; h < remoteHumanReview.length; h++) {
      var hrRow = remoteHumanReview[h];
      var hrId = hrRow[hrMap["id"]];
      if (!hrId || processedIds[hrId] === "dropped") continue;
      var hrAction = hrRow[hrMap["qc_action"]];
      
      if (hrAction === "Spam" || hrAction === "Duplicate") {
        finalSpamDuplicates.push([hrId, hrRow[hrMap["mapfacts_address"]], "Human_Review", hrAction]);
        processedIds[hrId] = "dropped";
        continue;
      }
      
      var fallbackAiWebsite = hrRow[hrMap["fixed_website"]] || "";
      if (hrAction === "Fixed") {
        var fixAddr = hrRow[hrMap["fixed_address"]] ? hrRow[hrMap["fixed_address"]].toString().trim() : "";
        var fixPhon = hrRow[hrMap["fixed_phone"]] ? hrRow[hrMap["fixed_phone"]].toString().trim() : "";
        var fixWebs = hrRow[hrMap["fixed_website"]] ? hrRow[hrMap["fixed_website"]].toString().trim() : "";
        var fixHour = hrRow[hrMap["fixed_hours"]] ? hrRow[hrMap["fixed_hours"]].toString().trim() : "";
        
        if (fixAddr || fixPhon || fixWebs || fixHour) {
          var targetWebsite = fixWebs || fallbackAiWebsite || "NA";
          if (fixAddr) reRunQueue.push([hrId, targetWebsite, "address", fixAddr]);
          if (fixPhon) reRunQueue.push([hrId, targetWebsite, "phone", fixPhon]);
          if (fixWebs) reRunQueue.push([hrId, targetWebsite, "website", fixWebs]);
          if (fixHour) reRunQueue.push([hrId, targetWebsite, "operating_hours", fixHour]);
          processedIds[hrId] = "rerun";
        } else {
          processedIds[hrId] = "evaluate_mismatch"; 
        }
      } else if (hrAction === "Verified OK") {
        processedIds[hrId] = "evaluate_mismatch";
      }
    }
  }
  
  // ==========================================
  // PIPELINE PROCESS BLOCK 2: HOOK TARGETED OVERRIDES
  // ==========================================
  
  function digestSparseBugTab(rawTab, targetCol, storageObj, updateSource) {
    if (!rawTab || rawTab.length <= 1) return;
    var bMap = getHeaderMap(rawTab[0]);
    for (var x = 1; x < rawTab.length; x++) {
      var bRow = rawTab[x];
      var bId = bRow[bMap["id"]];
      if (!bId || processedIds[bId] === "dropped" || processedIds[bId] === "rerun") continue;
      
      var isRaised = bRow[bMap["raise_bug"]];
      if (isRaised === true || isRaised === "TRUE" || isRaised === "true") {
        var targetValue = bRow[bMap[targetCol]] ? bRow[bMap[targetCol]].toString().trim() : "";
        if (targetValue !== "") {
          storageObj[bId] = targetValue;
          evidenceSourceTracker[bId] = bRow[bMap["ai_website"]] ? bRow[bMap["ai_website"]].toString().trim() : "";
          updateSourceTracker[bId] = updateSource;
        }
      }
    }
  }
  
  digestSparseBugTab(remoteBugsAddress, "ai_address", baseAddressOverrides, "Automated_Scrape");
  digestSparseBugTab(remoteBugsPhone, "ai_phone", basePhoneOverrides, "Automated_Scrape");
  digestSparseBugTab(remoteBugsHours, "ai_operating_hours", baseHoursOverrides, "Automated_Scrape");
  digestSparseBugTab(remoteBugsWebsite, "ai_website", baseWebsiteOverrides, "Automated_Scrape");
  
  // Manual Bug Tab Processing
  if (remoteManualBug && remoteManualBug.length > 1) {
    var mbMap = getHeaderMap(remoteManualBug[0]);
    for (var m = 1; m < remoteManualBug.length; m++) {
      var mbRow = remoteManualBug[m];
      var mbId = mbRow[mbMap["id"]];
      if (!mbId || processedIds[mbId] === "dropped" || processedIds[mbId] === "rerun") continue;
      
      var currentAiWebsite = mbRow[mbMap["ai_website"]] ? mbRow[mbMap["ai_website"]].toString().trim() : "";
      evidenceSourceTracker[mbId] = currentAiWebsite;
      updateSourceTracker[mbId] = "Human_Manual";
      
      var addrRes = mbRow[mbMap["address_result"]] ? mbRow[mbMap["address_result"]].toString().toLowerCase().trim() : "";
      var phonRes = mbRow[mbMap["phone_result"]] ? mbRow[mbMap["phone_result"]].toString().toLowerCase().trim() : "";
      var websRes = mbRow[mbMap["website_result"]] ? mbRow[mbMap["website_result"]].toString().toLowerCase().trim() : "";
      var hourRes = mbRow[mbMap["hours_result"]] ? mbRow[mbMap["hours_result"]].toString().toLowerCase().trim() : "";
      
      if (addrRes === "mismatch" && mbRow[mbMap["ai_address"]]) baseAddressOverrides[mbId] = mbRow[mbMap["ai_address"]].toString().trim();
      if (phonRes === "mismatch" && mbRow[mbMap["ai_phone"]])   basePhoneOverrides[mbId] = mbRow[mbMap["ai_phone"]].toString().trim();
      if (websRes === "mismatch" && mbRow[mbMap["ai_website"]]) baseWebsiteOverrides[mbId] = mbRow[mbMap["ai_website"]].toString().trim();
      if (hourRes === "mismatch" && mbRow[mbMap["ai_operating_hours"]]) baseHoursOverrides[mbId] = mbRow[mbMap["ai_operating_hours"]].toString().trim();
    }
  }
  
  // CRITICAL RESOLUTION LOGIC STEP: Process the remaining active 'evaluate_mismatch' IDs against automated agent findings
  for (var keyId in processedIds) {
    if (processedIds[keyId] === "evaluate_mismatch") {
      var agentRecord = compAgentCache[keyId];
      if (agentRecord) {
        evidenceSourceTracker[keyId] = agentRecord.ai_website || "NA";
        updateSourceTracker[keyId] = "Automated_Scrape_Resolved";
        
        // Dynamically harvest structural changes from agent history if they are missing from override buffers
        if (agentRecord.res_address === "mismatch" && !baseAddressOverrides[keyId]) baseAddressOverrides[keyId] = agentRecord.ai_address;
        if (agentRecord.res_phone === "mismatch" && !basePhoneOverrides[keyId])     basePhoneOverrides[keyId] = agentRecord.ai_phone;
        if (agentRecord.res_website === "mismatch" && !baseWebsiteOverrides[keyId]) baseWebsiteOverrides[keyId] = agentRecord.ai_website;
        if (agentRecord.res_hours === "mismatch" && !baseHoursOverrides[keyId])     baseHoursOverrides[keyId] = agentRecord.ai_hours;
      }
    }
  }
  
  // ==========================================
  // PIPELINE PROCESS BLOCK 3: ATOMIC DATA MATRIX COMPILATION
  // ==========================================
  
  var shipToGdeRows = [];
  var goldenDataRows = [];
  
  for (var k = 1; k < rawSnapshot.length; k++) {
    var snapRow = rawSnapshot[k];
    var sId = snapRow[snapMap["poi_fid"]];
    if (!sId || processedIds[sId] === "dropped") continue;
    
    var mfAddr = snapRow[snapMap["address"]] || "";
    var mfPhon = snapRow[snapMap["phone"]] || "";
    var mfWebs = snapRow[snapMap["website"]] || "";
    var mfHour = snapRow[snapMap["operating_hours"]] || "";
    
    var hasAddrUpd = baseAddressOverrides.hasOwnProperty(sId);
    var hasPhonUpd = basePhoneOverrides.hasOwnProperty(sId);
    var hasWebsUpd = baseWebsiteOverrides.hasOwnProperty(sId);
    var hasHourUpd = baseHoursOverrides.hasOwnProperty(sId);
    
    var aiAddrVal = hasAddrUpd ? baseAddressOverrides[sId] : "";
    var aiPhonVal = hasPhonUpd ? basePhoneOverrides[sId] : "";
    var aiWebsVal = hasWebsUpd ? baseWebsiteOverrides[sId] : "";
    var aiHourVal = hasHourUpd ? baseHoursOverrides[sId] : "";
    
    // 1. Compile modified records into custom ship_to_gde structural alignment rows
    if (hasAddrUpd || hasPhonUpd || hasWebsUpd || hasHourUpd) {
      shipToGdeRows.push([
        sId,
        evidenceSourceTracker[sId] || aiWebsVal || mfWebs || "NA",
        mfAddr,  aiAddrVal || "NA",
        mfPhon,  aiPhonVal || "NA",
        mfWebs,  aiWebsVal || "NA",
        mfHour,  aiHourVal || "NA",
        updateSourceTracker[sId] || "Automated_Scrape",
        "Accept" // Pre-filled default parameter value for the dropdown rule
      ]);
    }
    
    // 2. Compile custom formatted Golden Data matrix tracking record
    goldenDataRows.push([
      sId,
      mfAddr,  aiAddrVal || mfAddr,
      mfPhon,  aiPhonVal || mfPhon,
      mfWebs,  aiWebsVal || mfWebs,
      mfHour,  aiHourVal || mfHour
    ]);
  }
  
  // ==========================================
  // PIPELINE PROCESS BLOCK 4: TARGET SHEET OUTPUT AND INJECTIONS
  // ==========================================
  
  // Write ship_to_gde and inject custom dropdown controls down the final column boundary range
  var gdeHeaders = ["id", "source_evidence", "mapfacts_address", "proposed_address", "mapfacts_phone", "proposed_phone", "mapfacts_website", "proposed_website", "mapfacts_operating_hours", "proposed_operating_hours", "update_source", "gde_action"];
  injectRemoteTab(remoteSs, "ship_to_gde", gdeHeaders, shipToGdeRows);
  if (shipToGdeRows.length > 0) {
    var targetSheet = remoteSs.getSheetByName("ship_to_gde");
    var dropdownRule = SpreadsheetApp.newDataValidation().requireValueInList(["Accept", "Reject"]).setAllowInvalid(false).build();
    targetSheet.getRange(2, gdeHeaders.length, shipToGdeRows.length, 1).setDataValidation(dropdownRule);
  }
  
  // Render Golden Data using explicit core schemas
  var goldenHeaders = ["poi_fid", "mapfacts_address", "ai_address", "mapfacts_phone", "ai_phone", "mapfacts_website", "ai_website", "mapfacts_operating_hours", "ai_operating_hours"];
  injectRemoteTab(remoteSs, "Golden_Data", goldenHeaders, goldenDataRows);
  
  // Output diagnostic metrics tabs
  injectRemoteTab(remoteSs, "Final_Spam_Duplicates", ["id", "original_mapfacts_address", "source_tab", "classification"], finalSpamDuplicates);
  injectRemoteTab(remoteSs, "Re_Run_Agent", ["id", "ai_website", "target_attribute", "suggested_value"], reRunQueue);
  
  ui.alert("Phase 2 Complete!\nOutput channels populated successfully inside the remote QC workspace.");
}