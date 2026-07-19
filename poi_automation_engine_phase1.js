/**
 * ============================================================================
 * CUSTOM UI MENU INITIALIZATION
 * ============================================================================
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Bugs Workspace")
    .addItem("🐞 1. Find Bugs & Build QC Sheets", "runPhase1Ingestion")
    .addItem("📁 2. Export File to QC Team", "createBugFile")
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
        nbr_cnt: parseInt(row[mfMap["nbr_cnt"]], 10) || 0,
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
      humanReviewRows.push([cFid, "", cAiAddress, "", cAiPhone, "", "", cAiLat, cAiLng, "AI Hallucinated ID", 0, "Pending Review", "", "", "", ""]);
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
      humanReviewRows.push([cFid, mfData.address, cAiAddress, mfData.phone, cAiPhone, mfData.lat, mfData.lng, cAiLat, cAiLng, "Distance Drift > 1km", drift, "Pending Review", "", "", "", ""]);
      continue;
    }
    
    // Gate 5: Proposed AI Phone Target Structure Validation
    if (cAiPhone && !isValidAiPhone(cAiPhone)) {
      humanReviewRows.push([cFid, mfData.address, cAiAddress, mfData.phone, cAiPhone, mfData.lat, mfData.lng, cAiLat, cAiLng, "Invalid Proposed AI Phone", drift || 0, "Pending Review", "", "", "", ""]);
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
  writeTriageTab(ss, "Human_Review", ["ID", "Mapfacts_Address", "AI_Address", "Mapfacts_Phone", "AI_Phone", "Mapfacts_Lat", "Mapfacts_Lng", "AI_Lat", "AI_Lng", "Validation_Failure_Reason", "Calculated_Drift_KM", "QC_Action", "Fixed_Address", "Fixed_Phone", "Fixed_Website", "Fixed_Hours"], humanReviewRows, 12, ["Pending Review", "Verified OK", "Fixed", "Spam", "Duplicate", "Can't Fix"]);
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
 * STEP 2: EXPORT WORKSPACE ENGINE
 * Clones local triage frames into a separate sandbox file for the QC team
 * ============================================================================
 */
function createBugFile() {
  var activeSs = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  
  var targets = [
    "Left_Over", "Human_Review", "Duplicate_Review", 
    "Bugs_Address", "Bugs_Phone", "Bugs_Hours", "Bugs_Website", 
    "Manual_Bug_Tab", "Mapfacts_Snapshot"
  ];
  
  // Create the isolated remote file
  var dateString = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  var remoteFile = SpreadsheetApp.create("QC_Data_Workspace_" + dateString);
  
  for (var i = 0; i < targets.length; i++) {
    var sourceSheet = activeSs.getSheetByName(targets[i]);
    if (sourceSheet) {
      var copiedSheet = sourceSheet.copyTo(remoteFile);
      copiedSheet.setName(targets[i]);
    }
  }
  
  // Clean up default sheet1
  var defaultSheet = remoteFile.getSheetByName("Sheet1");
  if (defaultSheet) remoteFile.deleteSheet(defaultSheet);
  
  var fileUrl = remoteFile.getUrl();
  
  // Put link back to Config tab for Phase 2 visibility tracking
  var configSheet = activeSs.getSheetByName("Config");
  if (configSheet) {
    configSheet.appendRow(["Last Exported QC Sheet Link", fileUrl]);
  }
  
  ui.alert("Success!\nQC Workspace spreadsheet generated successfully.\nLink: " + fileUrl);
}


/**
 * ============================================================================
 * PHASE 2: SHIPPING & RECONCILIATION ENGINE
 * Reads remote human-modified sheets, applies overrides, builds GDE files
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
  
  // 2. Fetch and Cache remote inputs into global memory mapping structures
  var remoteLeftOver = getRemoteData(remoteSs, "Left_Over");
  var remoteHumanReview = getRemoteData(remoteSs, "Human_Review");
  var remoteDuplicateReview = getRemoteData(remoteSs, "Duplicate_Review");
  
  var remoteBugsAddress = getRemoteData(remoteSs, "Bugs_Address");
  var remoteBugsPhone = getRemoteData(remoteSs, "Bugs_Phone");
  var remoteBugsHours = getRemoteData(remoteSs, "Bugs_Hours");
  var remoteBugsWebsite = getRemoteData(remoteSs, "Bugs_Website");
  var remoteManualBug = getRemoteData(remoteSs, "Manual_Bug_Tab");
  
  // 3. Instantiate Object Resolution Maps
  var processedIds = {};
  var finalSpamDuplicates = [];
  var reRunQueue = [];
  
  // Helper storage dictionaries to compute final transformations
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
  if (remoteLeftOver) {
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
        reRunQueue.push([loId, "website", loRow[loMap["qc_discovered_website"]]]);
        processedIds[loId] = "rerun";
      }
    }
  }
  
  // Process Duplicate Review
  if (remoteDuplicateReview) {
    var dupMap = getHeaderMap(remoteDuplicateReview[0]);
    for (var d = 1; d < remoteDuplicateReview.length; d++) {
      var dupRow = remoteDuplicateReview[d];
      var dupId = dupRow[dupMap["id"]];
      if (!dupId) continue;
      
      var dupStatus = dupRow[dupMap["qc_status"]];
      if (dupStatus === "Duplicate" || dupStatus === "Spam") {
        finalSpamDuplicates.push([dupId, dupRow[dupMap["mapfacts_address"]], "Duplicate_Review", dupStatus]);
        processedIds[dupId] = "dropped";
      }
    }
  }
  
  // Process Human Review 
  if (remoteHumanReview) {
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
      
      if (hrAction === "Fixed") {
        var fixAddr = hrRow[hrMap["fixed_address"]];
        var fixPhon = hrRow[hrMap["fixed_phone"]];
        var fixWebs = hrRow[hrMap["fixed_website"]];
        var fixHour = hrRow[hrMap["fixed_hours"]];
        
        // If human fixes are written, route directly to the re-run queue matrix
        if (fixAddr || fixPhon || fixWebs || fixHour) {
          if (fixAddr) reRunQueue.push([hrId, "address", fixAddr]);
          if (fixPhon) reRunQueue.push([hrId, "phone", fixPhon]);
          if (fixWebs) reRunQueue.push([hrId, "website", fixWebs]);
          if (fixHour) reRunQueue.push([hrId, "operating_hours", fixHour]);
          processedIds[hrId] = "rerun";
        } else {
          // If empty, fall back to checking baseline mismatch logic values
          processedIds[hrId] = "evaluate_mismatch"; 
        }
      } else if (hrAction === "Verified OK") {
        processedIds[hrId] = "evaluate_mismatch";
      }
    }
  }
  
  // ==========================================
  // PIPELINE PROCESS BLOCK 2: BUG EXTRACTION & OVERRIDES
  // ==========================================
  
  // Helper to collect checked rows from sparse tabs
  function digestSparseBugTab(rawTab, addrCol, targetCol, storageObj, updateSource) {
    if (!rawTab) return;
    var bMap = getHeaderMap(rawTab[0]);
    for (var x = 1; x < rawTab.length; x++) {
      var bRow = rawTab[x];
      var bId = bRow[bMap["id"]];
      if (!bId || processedIds[bId] === "dropped" || processedIds[bId] === "rerun") continue;
      
      var isRaised = bRow[bMap["raise_bug"]];
      if (isRaised === true || isRaised === "TRUE") {
        storageObj[bId] = bRow[bMap[targetCol]];
        evidenceSourceTracker[bId] = bRow[bMap["ai_website"]] || "";
        updateSourceTracker[bId] = updateSource;
      }
    }
  }
  
  digestSparseBugTab(remoteBugsAddress, "address", "ai_address", baseAddressOverrides, "Automated_Scrape");
  digestSparseBugTab(remoteBugsPhone, "mapfacts_phone", "ai_phone", basePhoneOverrides, "Automated_Scrape");
  digestSparseBugTab(remoteBugsHours, "mapfacts_operating_hours", "ai_operating_hours", baseHoursOverrides, "Automated_Scrape");
  digestSparseBugTab(remoteBugsWebsite, "mapfacts_website", "ai_website", baseWebsiteOverrides, "Automated_Scrape"); // Website update target value is the scraped URL itself
  
  // Process Manual Bug Tab (Forces Overwrites / raise_bug = TRUE)
  if (remoteManualBug) {
    var mbMap = getHeaderMap(remoteManualBug[0]);
    for (var m = 1; m < remoteManualBug.length; m++) {
      var mbRow = remoteManualBug[m];
      var mbId = mbRow[mbMap["id"]];
      if (!mbId || processedIds[mbId] === "dropped" || processedIds[mbId] === "rerun") continue;
      
      evidenceSourceTracker[mbId] = mbRow[mbMap["ai_website"]] || "";
      updateSourceTracker[mbId] = "Human_Manual";
      
      if (mbRow[mbMap["address_result"]] === "Mismatch") baseAddressOverrides[mbId] = mbRow[mbMap["ai_address"]];
      if (mbRow[mbMap["phone_result"]] === "Mismatch") basePhoneOverrides[mbId] = mbRow[mbMap["ai_phone"]];
      if (mbRow[mbMap["website_result"]] === "Mismatch") baseWebsiteOverrides[mbId] = mbRow[mbMap["ai_website"]];
      if (mbRow[mbMap["hours_result"]] === "Mismatch") baseHoursOverrides[mbId] = mbRow[mbMap["ai_operating_hours"]];
    }
  }
  
  // ==========================================
  // PIPELINE PROCESS BLOCK 3: COMPILATION
  // ==========================================
  
  var shipToGdeRows = [];
  var goldenDataRows = [];
  
  // Loop through baseline snapshot to build final unified files
  for (var k = 1; k < rawSnapshot.length; k++) {
    var snapRow = rawSnapshot[k];
    var sId = snapRow[snapMap["poi_fid"]];
    if (!sId) continue;
    
    // Skip if dropped completely
    if (processedIds[sId] === "dropped") continue;
    
    // Check for updates
    var hasAddrUpd = baseAddressOverrides.hasOwnProperty(sId);
    var hasPhonUpd = basePhoneOverrides.hasOwnProperty(sId);
    var hasWebsUpd = baseWebsiteOverrides.hasOwnProperty(sId);
    var hasHourUpd = baseHoursOverrides.hasOwnProperty(sId);
    
    // 1. Compile ship_to_gde entry if changes exist
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
    
    // 2. Compile Golden_Data row payload (Deep clone baseline row values and merge updates)
    var workingGoldenRow = Array.apply(null, snapRow);
    if (hasAddrUpd) workingGoldenRow[snapMap["address"]] = baseAddressOverrides[sId];
    if (hasPhonUpd) workingGoldenRow[snapMap["phone"]] = basePhoneOverrides[sId];
    if (hasWebsUpd) workingGoldenRow[snapMap["website"]] = baseWebsiteOverrides[sId];
    if (hasHourUpd) workingGoldenRow[snapMap["operating_hours"]] = baseHoursOverrides[sId];
    
    goldenDataRows.push(workingGoldenRow);
  }
  
  // ==========================================
  // PIPELINE PROCESS BLOCK 4: REMOTE OUTPUT INJECTION
  // ==========================================
  
  injectRemoteTab(remoteSs, "ship_to_gde", ["id", "updated_address", "updated_phone", "updated_website", "updated_operatinghours", "evidence_source", "update_source"], shipToGdeRows);
  injectRemoteTab(remoteSs, "Golden_Data", snapHeaders, goldenDataRows);
  injectRemoteTab(remoteSs, "Final_Spam_Duplicates", ["id", "original_mapfacts_address", "source_tab", "classification"], finalSpamDuplicates);
  injectRemoteTab(remoteSs, "Re_Run_Agent", ["id", "target_attribute", "suggested_value"], reRunQueue);
  
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