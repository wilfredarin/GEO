/**
 * ============================================================================
 * PHASE 2: SHIPPING & RECONCILIATION ENGINE (UPDATED V4)
 * Reads remote human-modified sheets, applies overrides, builds GDE files.
 * Tracks idempotency, handles re-run requirements, and routes duplicates cleanly.
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
  
  // Get Snapshot data from host context
  var snapshotSheet = hostSs.getSheetByName("Mapfacts_Snapshot");
  if (!snapshotSheet) {
    ui.alert("Error: Missing local 'Mapfacts_Snapshot' master record.");
    return;
  }
  var rawSnapshot = snapshotSheet.getDataRange().getValues();
  var snapHeaders = rawSnapshot[0];
  var snapMap = getHeaderMap(snapHeaders);
  
  // 2. Fetch remote data matrices into memory
  var remoteLeftOver = getRemoteData(remoteSs, "Left_Over");
  var remoteHumanReview = getRemoteData(remoteSs, "Human_Review");
  var remoteDuplicateReview = getRemoteData(remoteSs, "Duplicate_Review");
  
  var remoteBugsAddress = getRemoteData(remoteSs, "Bugs_Address");
  var remoteBugsPhone = getRemoteData(remoteSs, "Bugs_Phone");
  var remoteBugsHours = getRemoteData(remoteSs, "Bugs_Hours");
  var remoteBugsWebsite = getRemoteData(remoteSs, "Bugs_Website");
  var remoteManualBug = getRemoteData(remoteSs, "Manual_Bug_Tab");
  
  // 3. Instantiate High-Performance Object Resolution Maps
  var processedIds = {};            // Tracks global drop/rerun system states
  var processedHashes = {};         // Idempotency registry to stop duplicate records
  var finalSpamDuplicates = [];
  var reRunQueue = [];
  
  // Isolated transitional memory buffers for constant-time O(1) overrides
  var baseAddressOverrides = {};
  var basePhoneOverrides = {};
  var baseHoursOverrides = {};
  var baseWebsiteOverrides = {};
  
  var evidenceSourceTracker = {};
  var updateSourceTracker = {};
  
  // ==========================================
  // PIPELINE PROCESS BLOCK 1: DROPS & RE-RUNS
  // ==========================================
  
  // Process Left_Over
  if (remoteLeftOver && remoteLeftOver.length > 1) {
    var loMap = getHeaderMap(remoteLeftOver[0]);
    for (var l = 1; l < remoteLeftOver.length; l++) {
      var loRow = remoteLeftOver[l];
      var loId = loRow[loMap["id"]];
      if (!loId) continue;
      
      var loAction = loRow[loMap["qc_action"]];
      var recordHash = "leftover:" + loId + ":" + loAction;
      if (processedHashes[recordHash]) continue;
      processedHashes[recordHash] = true;
      
      if (loAction === "Spam" || loAction === "Duplicate") {
        finalSpamDuplicates.push([loId, loRow[loMap["mapfacts_address"]], "Left_Over", loAction]);
        processedIds[loId] = "dropped";
      } else if (loAction === "Found Website Link" && loRow[loMap["qc_discovered_website"]]) {
        // Source tracking website for re-runs defaults to the discovered URL
        var discoveredUrl = loRow[loMap["qc_discovered_website"]].toString().trim();
        reRunQueue.push([loId, discoveredUrl, "website", discoveredUrl]);
        processedIds[loId] = "rerun";
      }
    }
  }
  
  // Process Duplicate Review
  if (remoteDuplicateReview && remoteDuplicateReview.length > 1) {
    var dupMap = getHeaderMap(remoteDuplicateReview[0]);
    for (var d = 1; d < remoteDuplicateReview.length; d++) {
      var dupRow = remoteDuplicateReview[d];
      var dupId = dupRow[dupMap["id"]];
      if (!dupId) continue;
      
      var dupStatus = dupRow[dupMap["qc_status"]];
      var recordHash = "duplicate:" + dupId + ":" + dupStatus;
      if (processedHashes[recordHash]) continue;
      processedHashes[recordHash] = true;
      
      if (dupStatus === "Duplicate" || dupStatus === "Spam") {
        finalSpamDuplicates.push([dupId, dupRow[dupMap["mapfacts_address"]], "Duplicate_Review", dupStatus]);
        processedIds[dupId] = "dropped";
      } else if (dupStatus === "Not Duplicate") {
        // CRITICAL FIX: Keep alive so it evaluates downstream for bugs instead of skipping
        processedIds[dupId] = "evaluate_mismatch";
      }
    }
  }
  
  // Process Human Review
  if (remoteHumanReview && remoteHumanReview.length > 1) {
    var hrMap = getHeaderMap(remoteHumanReview[0]);
    for (var h = 1; h < remoteHumanReview.length; h++) {
      var hrRow = remoteHumanReview[h];
      var hrId = hrRow[hrMap["id"]];
      if (!hrId || processedIds[hrId] === "dropped") continue;
      
      var hrAction = hrRow[hrMap["qc_action"]];
      var recordHash = "human:" + hrId + ":" + hrAction;
      if (processedHashes[recordHash]) continue;
      processedHashes[recordHash] = true;
      
      if (hrAction === "Spam" || hrAction === "Duplicate") {
        finalSpamDuplicates.push([hrId, hrRow[hrMap["mapfacts_address"]], "Human_Review", hrAction]);
        processedIds[hrId] = "dropped";
        continue;
      }
      
      var fallbackAiWebsite = hrRow[hrMap["fixed_website"]] || ""; // Fallback extraction context
      
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
        // CRITICAL FIX: Directly evaluate for structural bugs downstream
        processedIds[hrId] = "evaluate_mismatch";
      }
    }
  }
  
  // ==========================================
  // PIPELINE PROCESS BLOCK 2: TARGETED OVERRIDES
  // ==========================================
  
  function digestSparseBugTab(rawTab, targetCol, storageObj, updateSource) {
    if (!rawTab || rawTab.length <= 1) return;
    var bMap = getHeaderMap(rawTab[0]);
    
    for (var x = 1; x < rawTab.length; x++) {
      var bRow = rawTab[x];
      var bId = bRow[bMap["id"]];
      
      // Allow through if explicitly routed for evaluation
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
  
  // Process Manual Bug Tab
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
  
  // ==========================================
  // PIPELINE PROCESS BLOCK 3: ATOMIC COMPILATION
  // ==========================================
  
  var shipToGdeRows = [];
  var goldenDataRows = [];
  
  for (var k = 1; k < rawSnapshot.length; k++) {
    var snapRow = rawSnapshot[k];
    var sId = snapRow[snapMap["poi_fid"]];
    if (!sId) continue;
    
    if (processedIds[sId] === "dropped") continue;
    
    var hasAddrUpd = baseAddressOverrides.hasOwnProperty(sId);
    var hasPhonUpd = basePhoneOverrides.hasOwnProperty(sId);
    var hasWebsUpd = baseWebsiteOverrides.hasOwnProperty(sId);
    var hasHourUpd = baseHoursOverrides.hasOwnProperty(sId);
    
    if (hasAddrUpd || hasPhonUpd || hasWebsUpd || hasHourUpd) {
      shipToGdeRows.push([
        sId,
        hasAddrUpd ? baseAddressOverrides[sId] : "NA",
        hasPhonUpd ? basePhoneOverrides[sId] : "NA",
        hasWebsUpd ? baseWebsiteOverrides[sId] : "NA",
        hasHourUpd ? baseHoursOverrides[sId] : "NA",
        evidenceSourceTracker[sId] || "NA",
        updateSourceTracker[sId] || "Automated_Scrape"
      ]);
    }
    
    // Process Golden Data Matrix Entry Production
    var workingGoldenRow = snapRow.slice(0); 
    if (hasAddrUpd) workingGoldenRow[snapMap["address"]] = baseAddressOverrides[sId];
    if (hasPhonUpd) workingGoldenRow[snapMap["phone"]] = basePhoneOverrides[sId];
    if (hasWebsUpd) workingGoldenRow[snapMap["website"]] = baseWebsiteOverrides[sId];
    if (hasHourUpd) workingGoldenRow[snapMap["operating_hours"]] = baseHoursOverrides[sId];
    
    goldenDataRows.push(workingGoldenRow);
  }
  
  // ==========================================
  // PIPELINE PROCESS BLOCK 4: ATOMIC COMMIT
  // ==========================================
  
  injectRemoteTab(remoteSs, "ship_to_gde", ["id", "updated_address", "updated_phone", "updated_website", "updated_operatinghours", "evidence_source", "update_source"], shipToGdeRows);
  injectRemoteTab(remoteSs, "Golden_Data", snapHeaders, goldenDataRows);
  injectRemoteTab(remoteSs, "Final_Spam_Duplicates", ["id", "original_mapfacts_address", "source_tab", "classification"], finalSpamDuplicates);
  
  // CRITICAL FIX: Updated target array headers for the scraping worker pipeline dependencies
  injectRemoteTab(remoteSs, "Re_Run_Agent", ["id", "ai_website", "target_attribute", "suggested_value"], reRunQueue);
  
  Logger.log("Phase 2 Engine Reconciliation Successfully Committed. Items Processed: " + goldenDataRows.length);
  ui.alert("Phase 2 Complete!\nOutput channels populated successfully inside the remote QC workspace.");
}