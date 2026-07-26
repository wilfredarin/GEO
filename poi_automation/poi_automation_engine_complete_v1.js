/**
 * ============================================================================
 * CUSTOM UI MENU INITIALIZATION
 * ============================================================================
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Bugs Workspace")
    .addItem("🐞 1. Find Bugs & Build QC Sheets", "runPhase1Ingestion")
    .addItem("📁 2. Export File to QC Team", "exportWorkspaceToQC")
    .addItem("⚙️ 3. Compile GDE & Run Final Audit", "runPhase2Reconciliation")
    .addToUi();
}


/**
 * ============================================================================
 * PHASE 1: INGESTION, VALIDATION, AND TRIAGE ENGINE (UPDATED V3)
 * Execution Context: Host Sheet ("POI Verification Control Hub")
 * ============================================================================
 */


function runPhase1Ingestion() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. Ingest Configuration Coordinates
  var configSheet = ss.getSheetByName("Config");
  if (!configSheet) {
    SpreadsheetApp.getUi().alert("Error: A 'Config' tab must exist with external Mapfacts Sheet details.");
    return;
  }
  
  var configValues = configSheet.getDataRange().getValues();
  var externalUrl = "";
  var externalTabName = "";
  
  // Basic Config scanning for keys
  for (var r = 0; r < configValues.length; r++) {
    var key = configValues[r][0] ? configValues[r][0].toString().toLowerCase().trim() : "";
    if (key.indexOf("sheet link") > -1 || key.indexOf("url") > -1) {
      externalUrl = configValues[r][1];
    }
    if (key.indexOf("tab name") > -1) {
      externalTabName = configValues[r][1];
    }
  }
  
  if (!externalUrl || !externalTabName) {
    SpreadsheetApp.getUi().alert("Error: Could not locate 'Sheet Link' or 'Tab Name' values in the Config tab.");
    return;
  }
  
  // 2. Remote Fetch External Mapfacts Data
  var externalSourceSs, remoteSheet, rawMapfacts;
  try {
    externalSourceSs = SpreadsheetApp.openByUrl(externalUrl);
    remoteSheet = externalSourceSs.getSheetByName(externalTabName);
    rawMapfacts = remoteSheet.getDataRange().getValues();
  } catch(e) {
    SpreadsheetApp.getUi().alert("Remote Connection Failed: Check URL permissions and Tab name.\nDetails: " + e.message);
    return;
  }
  
  var mfHeaders = rawMapfacts[0];
  var mfMap = getHeaderMap(mfHeaders);
  
  // 3. Generate Local Verbatim Snapshot Copy
  var snapshotSheet = createOrClearTab(ss, "Mapfacts_Snapshot", mfHeaders);
  snapshotSheet.getRange(2, 1, rawMapfacts.length - 1, mfHeaders.length).setValues(rawMapfacts.slice(1));
  
  // 4. Ingest Local Comparison Agent Output
  var comparisonSheet = ss.getSheetByName("Comparison_Agent_Output");
  if (!comparisonSheet) {
    SpreadsheetApp.getUi().alert("Error: 'Comparison_Agent_Output' tab not found in host sheet.");
    return;
  }
  var rawComparison = comparisonSheet.getDataRange().getValues();
  var compHeaders = rawComparison[0];
  var compMap = getHeaderMap(compHeaders);
  
  // 5. Mapfacts Memory Cache Construction (O(M)) using updated 'poi_fid' mapping
  var mapfactsCache = {};
  for (var i = 1; i < rawMapfacts.length; i++) {
    var row = rawMapfacts[i];
    var fid = row[mfMap["poi_fid"]];
    if (fid) {
      mapfactsCache[fid] = {
        address: row[mfMap["address"]] || "",
        phone: row[mfMap["phone"]] || "",
        website: row[mfMap["website"]] || "",
        hours: row[mfMap["operating_hours"]] || "",
        lat: parseFloat(row[mfMap["lat"]]),
        lng: parseFloat(row[mfMap["lng"]]),
        nbr_cnt: parseInt(row[mfMap["nbr_count"]], 10) || 0,
        rawRow: row
      };
    }
  }
  
  // 6. Initialize Processing Arrays and Triage Tracking Maps
  var leftOverRows = [];
  var humanReviewRows = [];
  var duplicateRows = [];
  
  var bugsAddress = [];
  var bugsPhone = [];
  var bugsHours = [];
  var bugsWebsite = [];
  
  var idsPresentInComparison = {};
  
  // 7. Core Comparison Ingestion Pipeline Processing Loop (O(N))
  for (var j = 1; j < rawComparison.length; j++) {
    var cRow = rawComparison[j];
    var cFid = cRow[compMap["id"]]; 
    if (!cFid) continue;
    
    idsPresentInComparison[cFid] = true;
    
    var cAiWebsite = cRow[compMap["ai_website"]] || "";
    var cAiAddress = cRow[compMap["ai_address"]] || "";
    var cAiPhone = cRow[compMap["ai_phone"]] || "";
    var cAiHours = cRow[compMap["ai_operatinghours"]] || ""; 
    var cAiLat = parseFloat(cRow[compMap["ai_lat"]]);
    var cAiLng = parseFloat(cRow[compMap["ai_lng"]]);
    
    var resAddress = cRow[compMap["address_result"]] ? cRow[compMap["address_result"]].toString().toLowerCase().trim() : "";
    var resPhone = cRow[compMap["phone_result"]] ? cRow[compMap["phone_result"]].toString().toLowerCase().trim() : "";
    var resHours = cRow[compMap["hours_result"]] ? cRow[compMap["hours_result"]].toString().toLowerCase().trim() : "";
    var resWebsite = cRow[compMap["website_result"]] ? cRow[compMap["website_result"]].toString().toLowerCase().trim() : "";
    
    // Gate 1: AI Hallucination Check
    if (!mapfactsCache[cFid]) {
      humanReviewRows.push([cFid, "", cAiAddress, "", cAiPhone,  cAiWebsite, "AI Hallucinated ID", 0, "Pending Review", "", "", "", ""]);
      continue;
    }
    
    var mfData = mapfactsCache[cFid];
    
    // Gate 2: Proximity Match Review
    if (mfData.nbr_cnt > 0) {
      duplicateRows.push([cFid, mfData.address, cAiAddress, mfData.website, cAiWebsite, mfData.nbr_cnt, "Duplicate"]);
      continue;
    }
    
    // Gate 3a: Empty AI Payload Data Verification (OR condition)
    if (!cAiAddress || !cAiPhone || !cAiWebsite || !cAiHours) {
      leftOverRows.push([cFid, mfData.address, mfData.website, mfData.phone, "Empty AI Payload", "Can't Fix", "", ""]);
      continue;
    }
    
    // Gate 3b: Missing Coordinate Integrity Scan
    if (isNaN(cAiLat) || isNaN(cAiLng) || !cAiLat || !cAiLng) {
      leftOverRows.push([cFid, mfData.address, mfData.website, mfData.phone, "Missing Coordinates", "Can't Fix", "", ""]);
      continue;
    }
    
    // Gate 4: Geospatial Displacement Check
    var drift = calculateHaversine(mfData.lat, mfData.lng, cAiLat, cAiLng);
    if (!isNaN(drift) && drift > 1.0) {
      humanReviewRows.push([cFid, mfData.address, cAiAddress, mfData.phone, cAiPhone,cAiWebsite, "Distance Drift > 1km", drift, "Pending Review", "", "", "", ""]);
      continue;
    }
    
    // Gate 5: Proposed AI Phone Target Structure Validation
    if (cAiPhone && !isValidAiPhone(cAiPhone)) {
      humanReviewRows.push([cFid, mfData.address, cAiAddress, mfData.phone, cAiPhone, cAiWebsite, "Invalid Proposed AI Phone", drift || 0, "Pending Review", "", "", "", ""]);
      continue;
    }
    
    // Gate 6: Parse Structural Mismatches Flagged Upstream by Agent Output
    if (resAddress === "mismatch") {
      bugsAddress.push([cFid, cAiWebsite, mfData.address, cAiAddress, false]);
    }
    if (resPhone === "mismatch") {
      bugsPhone.push([cFid, cAiWebsite, mfData.address, mfData.phone, cAiPhone, false]);
    }
    if (resHours === "mismatch") {
      bugsHours.push([cFid, cAiWebsite, mfData.address, mfData.hours, cAiHours, false]);
    }
    if (resWebsite === "mismatch") {
      bugsWebsite.push([cFid, cAiWebsite, mfData.address, mfData.website, false]);
    }
  }
  
  // 8. Inverted Check: Find Mapfacts POIs Missing from Agent Output Completely
  for (var k = 1; k < rawMapfacts.length; k++) {
    var checkFid = rawMapfacts[k][mfMap["poi_fid"]];
    if (checkFid && !idsPresentInComparison[checkFid]) {
      var unassignedMf = mapfactsCache[checkFid];
      leftOverRows.push([checkFid, unassignedMf.address, unassignedMf.website, unassignedMf.phone, "Missing from Scraper Output", "Can't Fix", "", ""]);
    }
  }
  
  // 9. Render Destination Operations Tabs and Setup UI Component Controls
  writeTriageTab(ss, "Left_Over", ["ID", "Mapfacts_Address", "Mapfacts_Website", "Mapfacts_Phone", "Source_Status", "QC_Action", "QC_Discovered_Website", "Resolution_Notes"], leftOverRows, 6, ["Found Website Link", "Duplicate", "Spam", "Can't Fix"]);
  writeTriageTab(ss, "Human_Review", ["ID", "Mapfacts_Address", "AI_Address", "Mapfacts_Phone", "AI_Phone", "AI_Website", "Validation_Failure_Reason", "Calculated_Drift_KM", "QC_Action", "Fixed_Address", "Fixed_Phone", "Fixed_Website", "Fixed_Hours"], humanReviewRows, 9, ["Pending Review", "Verified OK", "Fixed", "Spam", "Duplicate", "Can't Fix"]);
  writeTriageTab(ss, "Duplicate_Review", ["ID", "Mapfacts_Address", "AI_Address", "Mapfacts_Website", "AI_Website", "nbr_cnt", "QC_Status"], duplicateRows, 7, ["Duplicate", "Not Duplicate", "Can't Decide"]);
  
  writeBugTab(ss, "Bugs_Address", ["ID", "AI_Website", "Address", "AI_Address", "raise_bug"], bugsAddress);
  writeBugTab(ss, "Bugs_Phone", ["ID", "AI_Website", "Address", "Mapfacts_Phone", "AI_Phone", "raise_bug"], bugsPhone);
  writeBugTab(ss, "Bugs_Hours", ["ID", "AI_Website", "Address", "Mapfacts_Operating_Hours", "AI_Operating_Hours", "raise_bug"], bugsHours);
  writeBugTab(ss, "Bugs_Website", ["ID", "AI_Website", "Address", "Mapfacts_Website", "raise_bug"], bugsWebsite);
  
  // 9b. Build the structural layout for Manual_Bug_Tab
  var manualHeaders = ["ID", "Address", "AI_Address", "Phone", "AI_Phone", "Website", "AI_Website", "Operating_Hours", "AI_Operating_Hours", "Address_Result", "Phone_Result", "Website_Result", "Hours_Result"];
  var manualSheet = createOrClearTab(ss, "Manual_Bug_Tab", manualHeaders);
  
  // Inject explicit dropdowns to the manual result logic columns (Rows 2 to 500)
  var manualRule = SpreadsheetApp.newDataValidation().requireValueInList(["Match", "Mismatch"]).setAllowInvalid(false).build();
  manualSheet.getRange(2, 10, 499, 4).setDataValidation(manualRule);
  
  SpreadsheetApp.getUi().alert("Phase 1 Triage Generation Successfully Executed locally.");
}






/**
 * ============================================================================
 * EXPORT ENGINE: CLONE & SHARE WORKSPACE WITH QC TEAM
 * Creates an exact workspace duplicate, shares it with target stakeholders,
 * and renders an accessible visual interface component linking directly to it.
 * ============================================================================
 */
function exportWorkspaceToQC() {
  var ui = SpreadsheetApp.getUi();
  var currentSs = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. Prompt Confirmation to prevent accidental execution
  var confirm = ui.alert(
    "Export Confirmation", 
    "This will create a new, dedicated workspace clone for the QC Team and share it automatically. Do you want to proceed?", 
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  try {
    // 2. Generate timestamped structural filename
    var dateString = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd_HH-mm");
    var configSheet = currentSs.getSheetByName("Config");
    if (!configSheet) {
      SpreadsheetApp.getUi().alert("Error: A 'Config' tab must exist with external Mapfacts Sheet details.");
      return;
    }

    var configValues = configSheet.getDataRange().getValues();
    var tabName = configValues[1][1];
    var clonedName = "CKB "+ tabName + " Bug File";
    
    // 3. Make an end-to-end exact file system copy of the Spreadsheet
    var currentFile = DriveApp.getFileById(currentSs.getId());
    var clonedFile = currentFile.makeCopy(clonedName);
    var clonedSs = SpreadsheetApp.openById(clonedFile.getId());
    
    // 4. Clean up unnecessary Master data sheets from the QC Workspace if present
    // Adjust these names if you want to keep or drop additional backend tabs
    var internalMasterTabs = ["Config", "Prompts"];
    internalMasterTabs.forEach(function(tabName) {
      var targetTab = clonedSs.getSheetByName(tabName);
      if (targetTab) {
        clonedSs.deleteSheet(targetTab);
      }
    });
    
    // 5. Securely allocate access rights to target email addresses
    var targetReviewers = ["praveendinker@google.com", "sameerranjan@google.com"];
    targetReviewers.forEach(function(email) {
      clonedFile.addEditor(email);
    });
    
    // 6. Generate an interactive HTML Dialog containing the deep link shortcut
    var sheetUrl = clonedSs.getUrl();
    var htmlContent = 
      '<div style="font-family: \'Google Sans\', Roboto, Arial, sans-serif; padding: 15px; color: #3c4043;">' +
        '<h3 style="color: #1a73e8; margin-top: 0;">Workspace Created Successfully!</h3>' +
        '<p style="font-size: 13px; line-height: 1.5; color: #5f6368;">' +
          'An exact clone has been provisioned and shared with <b>QC Team</b> with editor access permissions.' +
        '</p>' +
        '<div style="margin: 25px 0 15px 0; text-align: center;">' +
          '<a href="' + sheetUrl + '" target="_blank" style="' +
            'background-color: #1a73e8; ' +
            'color: white; ' +
            'padding: 12px 24px; ' +
            'text-decoration: none; ' +
            'font-weight: 500; ' +
            'font-size: 14px; ' +
            'border-radius: 4px; ' +
            'box-shadow: 0 1px 3px rgba(60,64,67,0.3); ' +
            'display: inline-block;' +
          '">Open QC Workspace</a>' +
        '</div>' +
      '</div>';
      
    var htmlOutput = HtmlService.createHtmlOutput(htmlContent)
        .setWidth(450)
        .setHeight(200);
        
    ui.showModalDialog(htmlOutput, "Deployment Engine Status");
    
  } catch (error) {
    ui.alert("Export Architecture Failure: " + error.toString());
  }
}




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
  var snapshotSheet = remoteSs.getSheetByName("Mapfacts_Snapshot");
  var comparisonSheet = remoteSs.getSheetByName("Comparison_Agent_Output");
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
          if (fixAddr) baseAddressOverrides[hrId] = fixAddr;
          if (fixPhon) basePhoneOverrides[hrId] = fixPhon;
          if (fixWebs) baseWebsiteOverrides[hrId] = fixWebs;
          if (fixHour) baseHoursOverrides[hrId] = fixHour;
          updateSourceTracker[hrId] = "Human_Review_Fixed";
          processedIds[hrId] = "human_fixed";
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
      // if (addrRes === "mismatch" && mbRow[mbMap["ai_address"]]) ui.alert("mismatch in human");
      if (addrRes === "mismatch" && mbRow[mbMap["ai_address"]]) baseAddressOverrides[mbId] = mbRow[mbMap["ai_address"]].toString().trim();
      if (phonRes === "mismatch" && mbRow[mbMap["ai_phone"]])   basePhoneOverrides[mbId] = mbRow[mbMap["ai_phone"]].toString().trim();
      if (websRes === "mismatch" && mbRow[mbMap["ai_website"]]) baseWebsiteOverrides[mbId] = mbRow[mbMap["ai_website"]].toString().trim();
      if (hourRes === "mismatch" && mbRow[mbMap["ai_operating_hours"]]) baseHoursOverrides[mbId] = mbRow[mbMap["ai_operating_hours"]].toString().trim();
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
    // if(processedIds[sId] === "dropped"){console.log(sId)}
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
        "","","",""
    
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
  var gdeHeaders = ["id", "source_evidence", "mapfacts_address", "proposed_address", "mapfacts_phone", "proposed_phone", "mapfacts_website", "proposed_website", "mapfacts_operating_hours", "proposed_operating_hours", "update_source", "gde_verdict_phone_number_is_correct",  "gde_verdict_business_hours_is_correct",  "gde_verdict_website_is_correct", "gde_verdict_address_is_correct"];
  injectRemoteTab(remoteSs, "ship_to_gde", gdeHeaders, shipToGdeRows);
  if (shipToGdeRows.length > 0) {
    var targetSheet = remoteSs.getSheetByName("ship_to_gde");
    var dropdownRule = SpreadsheetApp.newDataValidation().requireValueInList(["Yes", "No","NA","Not Verified"]).setAllowInvalid(false).build();
    targetSheet.getRange(2, gdeHeaders.length-3, shipToGdeRows.length, 4).setDataValidation(dropdownRule);
  }
  
  // Render Golden Data using explicit core schemas
  var goldenHeaders = ["poi_fid", "mapfacts_address", "ai_address", "mapfacts_phone", "ai_phone", "mapfacts_website", "ai_website", "mapfacts_operating_hours", "ai_operating_hours"];
  injectRemoteTab(remoteSs, "Golden_Data", goldenHeaders, goldenDataRows);
  
  // Output diagnostic metrics tabs
  injectRemoteTab(remoteSs, "Final_Spam_Duplicates", ["id", "original_mapfacts_address", "source_tab", "classification"], finalSpamDuplicates);
  injectRemoteTab(remoteSs, "Re_Run_Agent", ["id", "ai_website", "target_attribute", "suggested_value"], reRunQueue);
  
  ui.alert("Phase 2 Complete!\nOutput channels populated successfully inside the remote QC workspace.");
}





/**
 * ============================================================================
 * UTILITY HELPERS
 * ============================================================================
 */
function getRemoteData(ss, name) {
  var sheet = ss.getSheetByName(name);
  return sheet ? sheet.getDataRange().getValues() : null;
}

function injectRemoteTab(ss, name, headers, data) {
  var sheet = ss.getSheetByName(name);
  if (sheet) {
    sheet.clear();
    sheet.getDataRange().clearDataValidations();
  } else {
    sheet = ss.insertSheet(name);
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
  if (data.length > 0) {
    sheet.getRange(2, 1, data.length, headers.length).setValues(data);
  }
}

function isValidAiPhone(aiPhoneString) {
  if (!aiPhoneString) return true;
  var digits = aiPhoneString.toString().replace(/[^\d]/g, '');
  return (digits.length >= 10 && digits.length <= 15);
}

function getHeaderMap(headers) {
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    var name = headers[i].toString().toLowerCase().trim();
    map[name] = i;
  }
  return map;
}

function createOrClearTab(ss, tabName, headers) {
  var sheet = ss.getSheetByName(tabName);
  if (sheet) {
    sheet.clear();
    sheet.getDataRange().clearDataValidations();
  } else {
    sheet = ss.insertSheet(tabName);
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
  return sheet;
}

function writeTriageTab(ss, tabName, headers, data, dropdownColIndex, dropdownOptions) {
  var sheet = createOrClearTab(ss, tabName, headers);
  if (data.length === 0) return;
  sheet.getRange(2, 1, data.length, headers.length).setValues(data);
  var cellRange = sheet.getRange(2, dropdownColIndex, data.length, 1);
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(dropdownOptions).setAllowInvalid(false).build();
  cellRange.setDataValidation(rule);
}

function writeBugTab(ss, tabName, headers, data) {
  var sheet = createOrClearTab(ss, tabName, headers);
  if (data.length === 0) return;
  sheet.getRange(2, 1, data.length, headers.length).setValues(data);
  var checkboxRange = sheet.getRange(2, headers.length, data.length, 1);
  checkboxRange.insertCheckboxes();
}

function calculateHaversine(lat1, lng1, lat2, lng2) {
  if (isNaN(lat1) || isNaN(lng1) || isNaN(lat2) || isNaN(lng2)) return NaN;
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLng/2) * Math.sin(dLng/2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}