**
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
  if (rawMapfacts.length > 1) {
    snapshotSheet.getRange(2, 1, rawMapfacts.length - 1, mfHeaders.length).setValues(rawMapfacts.slice(1));
  }
  
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
      humanReviewRows.push([cFid, "", cAiAddress, "", cAiPhone, cAiWebsite, "AI Hallucinated ID", 0, "Pending Review"]);
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
      leftOverRows.push([cFid, mfData.address, mfData.website, mfData.phone, mfData.hours, "Empty AI Payload", "Pending Review", "", ""]);
      continue;
    }
    
    // Gate 3b: Missing Coordinate Integrity Scan
    if (isNaN(cAiLat) || isNaN(cAiLng) || !cAiLat || !cAiLng) {
      leftOverRows.push([cFid, mfData.address, mfData.website, mfData.phone, mfData.hours, "Missing Coordinates", "Pending Review", "", ""]);
      continue;
    }
    
    // Gate 4: Geospatial Displacement Check
    var drift = calculateHaversine(mfData.lat, mfData.lng, cAiLat, cAiLng);
    if (!isNaN(drift) && drift > 1.0) {
      humanReviewRows.push([cFid, mfData.address, cAiAddress, mfData.phone, cAiPhone, cAiWebsite, "Distance Drift > 1km", drift, "Pending Review"]);
      continue;
    }
    
    // Gate 5: Proposed AI Phone Target Structure Validation
    if (cAiPhone && !isValidAiPhone(cAiPhone)) {
      humanReviewRows.push([cFid, mfData.address, cAiAddress, mfData.phone, cAiPhone, cAiWebsite, "Invalid Proposed AI Phone", drift || 0, "Pending Review"]);
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
      leftOverRows.push([checkFid, unassignedMf.address, unassignedMf.website, unassignedMf.phone, unassignedMf.hours, "Missing from Scraper Output", "Pending Review", "", ""]);
    }
  }
  
  // 9. Render Destination Operations Tabs and Setup UI Component Controls
  writeTriageTab(ss, "Left_Over", ["ID", "Address", "Website", "Phone", "operating_hours", "Source_Status", "QC_Action", "QC_Discovered_Website", "Resolution_Notes"], leftOverRows, 7, ["Found Website Link", "Duplicate", "Spam", "Can't Fix", "Fixed Manual Tab", "Pending Review"]);
  writeTriageTab(ss, "Human_Review", ["ID", "Mapfacts_Address", "AI_Address", "Mapfacts_Phone", "AI_Phone", "AI_Website", "Validation_Failure_Reason", "Calculated_Drift_KM", "QC_Action"], humanReviewRows, 9, ["Pending Review", "Verified OK", "Fixed Manual Tab", "Spam", "Duplicate", "Can't Fix"]);
  writeTriageTab(ss, "Duplicate_Review", ["ID", "Mapfacts_Address", "AI_Address", "Mapfacts_Website", "AI_Website", "nbr_cnt", "QC_Status"], duplicateRows, 7, ["Duplicate", "Not Duplicate", "Can't Decide", "Pending Review"]);
  
  writeBugTab(ss, "Bugs_Address", ["ID", "AI_Website", "Address", "AI_Address", "raise_bug"], bugsAddress);
  writeBugTab(ss, "Bugs_Phone", ["ID", "AI_Website", "Address", "Mapfacts_Phone", "AI_Phone", "raise_bug"], bugsPhone);
  writeBugTab(ss, "Bugs_Hours", ["ID", "AI_Website", "Address", "Mapfacts_Operating_Hours", "AI_Operating_Hours", "raise_bug"], bugsHours);
  writeBugTab(ss, "Bugs_Website", ["ID", "AI_Website", "Address", "Mapfacts_Website", "raise_bug"], bugsWebsite);
  
  // 9b. Build the structural layout for Manual_Bug_Tab
  var manualHeaders = ["ID", "Address", "Website", "Phone", "Operating_Hours", "AI_Address", "AI_Phone", "AI_Website", "AI_Operating_Hours", "Address_Result", "Phone_Result", "Website_Result", "Hours_Result"];
  var manualSheet = createOrClearTab(ss, "Manual_Bug_Tab", manualHeaders);
  
  // Inject explicit dropdowns to the manual result logic columns (Rows 2 to 500)
  var manualRule = SpreadsheetApp.newDataValidation().requireValueInList(["Match", "Mismatch"]).setAllowInvalid(false).build();
  manualSheet.getRange(2, 10, 499, 4).setDataValidation(manualRule);
  
  SpreadsheetApp.getUi().alert("Phase 1 Triage Generation Successfully Executed locally.");
}


/**
 * ============================================================================
 * EXPORT ENGINE: CLONE & SHARE WORKSPACE WITH QC TEAM
 * ============================================================================
 */
function exportWorkspaceToQC() {
  var ui = SpreadsheetApp.getUi();
  var currentSs = SpreadsheetApp.getActiveSpreadsheet();
  
  var confirm = ui.alert(
    "Export Confirmation", 
    "This will create a new, dedicated workspace clone for the QC Team and share it automatically. Do you want to proceed?", 
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  try {
    var configSheet = currentSs.getSheetByName("Config");
    if (!configSheet) {
      SpreadsheetApp.getUi().alert("Error: A 'Config' tab must exist with external Mapfacts Sheet details.");
      return;
    }

    var configValues = configSheet.getDataRange().getValues();
    var tabName = "";
    for (var r = 0; r < configValues.length; r++) {
      var key = configValues[r][0] ? configValues[r][0].toString().toLowerCase().trim() : "";
      if (key.indexOf("tab name") > -1) {
        tabName = configValues[r][1];
      }
    }
    
    var clonedName = "CKB " + (tabName || "Workspace") + " Bug File";
    
    var currentFile = DriveApp.getFileById(currentSs.getId());
    var clonedFile = currentFile.makeCopy(clonedName);
    var clonedSs = SpreadsheetApp.openById(clonedFile.getId());
    
    var internalMasterTabs = ["Config", "Prompts"];
    internalMasterTabs.forEach(function(tName) {
      var targetTab = clonedSs.getSheetByName(tName);
      if (targetTab) clonedSs.deleteSheet(targetTab);
    });
    
    var targetReviewers = ["praveendinker@google.com", "sameerranjan@google.com"];
    targetReviewers.forEach(function(email) {
      clonedFile.addEditor(email);
    });
    
    var sheetUrl = clonedSs.getUrl();
    var htmlContent = 
      '<div style="font-family: \'Google Sans\', Roboto, Arial, sans-serif; padding: 15px; color: #3c4043;">' +
        '<h3 style="color: #1a73e8; margin-top: 0;">Workspace Created Successfully!</h3>' +
        '<p style="font-size: 13px; line-height: 1.5; color: #5f6368;">' +
          'An exact clone has been provisioned and shared with <b>QC Team</b> with editor access permissions.' +
        '</p>' +
        '<div style="margin: 25px 0 15px 0; text-align: center;">' +
          '<a href="' + sheetUrl + '" target="_blank" style="' +
            'background-color: #1a73e8; color: white; padding: 12px 24px; ' +
            'text-decoration: none; font-weight: 500; font-size: 14px; border-radius: 4px; ' +
            'box-shadow: 0 1px 3px rgba(60,64,67,0.3); display: inline-block;' +
          '">Open QC Workspace</a>' +
        '</div>' +
      '</div>';
      
    var htmlOutput = HtmlService.createHtmlOutput(htmlContent).setWidth(450).setHeight(200);
    ui.showModalDialog(htmlOutput, "Deployment Engine Status");
    
  } catch (error) {
    ui.alert("Export Architecture Failure: " + error.toString());
  }
}


/**
 * ============================================================================
 * PHASE 2: SHIPPING & RECONCILIATION ENGINE
 * ============================================================================
 */
function runPhase2Reconciliation() {
  var hostSs = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  
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
  
  var remoteLeftOver = getRemoteData(remoteSs, "Left_Over");
  var remoteHumanReview = getRemoteData(remoteSs, "Human_Review");
  var remoteDuplicateReview = getRemoteData(remoteSs, "Duplicate_Review");
  
  var remoteBugsAddress = getRemoteData(remoteSs, "Bugs_Address");
  var remoteBugsPhone = getRemoteData(remoteSs, "Bugs_Phone");
  var remoteBugsHours = getRemoteData(remoteSs, "Bugs_Hours");
  var remoteBugsWebsite = getRemoteData(remoteSs, "Bugs_Website");
  var remoteManualBug = getRemoteData(remoteSs, "Manual_Bug_Tab");
  
  var processedIds = {};            
  var dropTracker = {}; // ID -> { sourceTab: string, reason: string }
  var finalSpamDuplicates = [];
  var reRunQueue = [];
  
  var baseAddressOverrides = {};
  var basePhoneOverrides = {};
  var baseHoursOverrides = {};
  var baseWebsiteOverrides = {};
  
  var evidenceSourceTracker = {};
  var updateSourceTracker = {};
  
  // ==========================================
  // PIPELINE PROCESS BLOCK 1: DROPS & RE-RUN ROUTING
  // ==========================================
  
  // 1. Left_Over Tab
  if (remoteLeftOver && remoteLeftOver.length > 1) {
    var loMap = getHeaderMap(remoteLeftOver[0]);
    for (var l = 1; l < remoteLeftOver.length; l++) {
      var loRow = remoteLeftOver[l];
      var loId = loRow[loMap["id"]];
      if (!loId) continue;
      var loAction = loRow[loMap["qc_action"]];
      
      if (loAction === "Spam" || loAction === "Duplicate" || loAction === "Pending Review" || loAction === "Can't Fix") {
        processedIds[loId] = "dropped";
        dropTracker[loId] = { sourceTab: "Left_Over", reason: loAction || "Unresolved" };
        if (loAction === "Spam" || loAction === "Duplicate") {
          finalSpamDuplicates.push([loId, loRow[loMap["address"]] || "", "Left_Over", loAction]);
        }
      }
    }
  }
  
  // 2. Duplicate Review Tab
  if (remoteDuplicateReview && remoteDuplicateReview.length > 1) {
    var dupMap = getHeaderMap(remoteDuplicateReview[0]);
    for (var d = 1; d < remoteDuplicateReview.length; d++) {
      var dupRow = remoteDuplicateReview[d];
      var dupId = dupRow[dupMap["id"]];
      if (!dupId) continue;
      var dupStatus = dupRow[dupMap["qc_status"]];
      
      if (dupStatus === "Duplicate" || dupStatus === "Spam" || dupStatus === "Pending Review" || dupStatus === "Can't Decide") {
        processedIds[dupId] = "dropped";
        dropTracker[dupId] = { sourceTab: "Duplicate_Review", reason: dupStatus || "Unresolved" };
        if (dupStatus === "Duplicate" || dupStatus === "Spam") {
          finalSpamDuplicates.push([dupId, dupRow[dupMap["mapfacts_address"]] || "", "Duplicate_Review", dupStatus]);
        }
      } else if (dupStatus === "Not Duplicate") {
        processedIds[dupId] = "evaluate_mismatch";
      }
    }
  }
  
  // 3. Human Review Tab
  if (remoteHumanReview && remoteHumanReview.length > 1) {
    var hrMap = getHeaderMap(remoteHumanReview[0]);
    for (var h = 1; h < remoteHumanReview.length; h++) {
      var hrRow = remoteHumanReview[h];
      var hrId = hrRow[hrMap["id"]];
      if (!hrId || processedIds[hrId] === "dropped") continue;
      var hrAction = hrRow[hrMap["qc_action"]];
      
      if (hrAction === "Spam" || hrAction === "Duplicate" || hrAction === "Pending Review" || hrAction === "Can't Fix") {
        processedIds[hrId] = "dropped";
        dropTracker[hrId] = { sourceTab: "Human_Review", reason: hrAction || "Unresolved" };
        if (hrAction === "Spam" || hrAction === "Duplicate") {
          finalSpamDuplicates.push([hrId, hrRow[hrMap["mapfacts_address"]] || "", "Human_Review", hrAction]);
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
  
  // Harvest automated agent findings for active 'evaluate_mismatch' IDs
  for (var keyId in processedIds) {
    if (processedIds[keyId] === "evaluate_mismatch") {
      var agentRecord = compAgentCache[keyId];
      if (agentRecord) {
        evidenceSourceTracker[keyId] = agentRecord.ai_website || "NA";
        updateSourceTracker[keyId] = "Automated_Scrape_Resolved";
        
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
      
      if (!mbId || processedIds[mbId] === "dropped") continue;
      
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
  // PIPELINE PROCESS BLOCK 3: ATOMIC DATA MATRIX COMPILATION
  // ==========================================
  
  var shipToGdeRows = [];
  var goldenDataRows = [];
  var nonGoldenDataRows = [];
  
  for (var k = 1; k < rawSnapshot.length; k++) {
    var snapRow = rawSnapshot[k];
    var sId = snapRow[snapMap["poi_fid"]];
    if (!sId) continue;

    var mfAddr = snapRow[snapMap["address"]] || "";
    var mfPhon = snapRow[snapMap["phone"]] || "";
    var mfWebs = snapRow[snapMap["website"]] || "";
    var mfHour = snapRow[snapMap["operating_hours"]] || "";
    
    // ROUTE TO NON_GOLDEN_DATA IF DROPPED
    if (processedIds[sId] === "dropped") {
      var dMeta = dropTracker[sId] || { sourceTab: "Unassigned", reason: "Excluded" };
      nonGoldenDataRows.push([
        sId,
        mfAddr,
        mfPhon,
        mfWebs,
        mfHour,
        dMeta.sourceTab,
        dMeta.reason
      ]);
      continue;
    }
    
    // ROUTE TO GOLDEN_DATA & SHIP_TO_GDE IF ACTIVE
    var hasAddrUpd = baseAddressOverrides.hasOwnProperty(sId);
    var hasPhonUpd = basePhoneOverrides.hasOwnProperty(sId);
    var hasWebsUpd = baseWebsiteOverrides.hasOwnProperty(sId);
    var hasHourUpd = baseHoursOverrides.hasOwnProperty(sId);
    
    var aiAddrVal = hasAddrUpd ? baseAddressOverrides[sId] : "";
    var aiPhonVal = hasPhonUpd ? basePhoneOverrides[sId] : "";
    var aiWebsVal = hasWebsUpd ? baseWebsiteOverrides[sId] : "";
    var aiHourVal = hasHourUpd ? baseHoursOverrides[sId] : "";
    
    if (hasAddrUpd || hasPhonUpd || hasWebsUpd || hasHourUpd) {
      shipToGdeRows.push([
        sId,
        evidenceSourceTracker[sId] || aiWebsVal || mfWebs || "NA",
        mfAddr,  aiAddrVal || "NA",
        mfPhon,  aiPhonVal || "NA",
        mfWebs,  aiWebsVal || "NA",
        mfHour,  aiHourVal || "NA",
        updateSourceTracker[sId] || "Automated_Scrape",
        "", "", "", "" // 4 GDE verdict columns (Total 15 columns)
      ]);
    }
    
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
  
  var gdeHeaders = [
    "id", "source_evidence", "mapfacts_address", "proposed_address", 
    "mapfacts_phone", "proposed_phone", "mapfacts_website", "proposed_website", 
    "mapfacts_operating_hours", "proposed_operating_hours", "update_source", 
    "gde_verdict_phone_number_is_correct", "gde_verdict_business_hours_is_correct", 
    "gde_verdict_website_is_correct", "gde_verdict_address_is_correct"
  ];
  injectRemoteTab(remoteSs, "ship_to_gde", gdeHeaders, shipToGdeRows);
  
  if (shipToGdeRows.length > 0) {
    var targetSheet = remoteSs.getSheetByName("ship_to_gde");
    var dropdownRule = SpreadsheetApp.newDataValidation().requireValueInList(["Yes", "No", "NA", "Not Verified"]).setAllowInvalid(false).build();
    targetSheet.getRange(2, gdeHeaders.length - 3, shipToGdeRows.length, 4).setDataValidation(dropdownRule);
  }
  
  var goldenHeaders = ["poi_fid", "mapfacts_address", "ai_address", "mapfacts_phone", "ai_phone", "mapfacts_website", "ai_website", "mapfacts_operating_hours", "ai_operating_hours"];
  injectRemoteTab(remoteSs, "Golden_Data", goldenHeaders, goldenDataRows);

  var nonGoldenHeaders = ["poi_fid", "mapfacts_address", "mapfacts_phone", "mapfacts_website", "mapfacts_operating_hours", "source_tab", "exclusion_reason"];
  injectRemoteTab(remoteSs, "non_golden_data", nonGoldenHeaders, nonGoldenDataRows);
  
  injectRemoteTab(remoteSs, "Final_Spam_Duplicates", ["id", "original_mapfacts_address", "source_tab", "classification"], finalSpamDuplicates);
  injectRemoteTab(remoteSs, "Re_Run_Agent", ["id", "ai_website", "target_attribute", "suggested_value"], reRunQueue);
  
  ui.alert("Phase 2 Complete!\nOutput channels populated successfully inside the remote QC workspace.\n\nSummary:\n- Golden Data: " + goldenDataRows.length + " POIs\n- Non-Golden Data: " + nonGoldenDataRows.length + " POIs");
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
  if (!headers) return map;
  for (var i = 0; i < headers.length; i++) {
    var name = headers[i] ? headers[i].toString().toLowerCase().trim() : "";
    if (name) map[name] = i;
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