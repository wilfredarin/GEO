/**
 * Phase 1: Ingestion, Validation, and Triage Engine (Refactored V2)
 * Execution Context: Host Sheet ("POI Verification Control Hub")
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
    var cFid = cRow[compMap["id"]]; // Updated matching column name
    if (!cFid) continue;
    
    // Track ID presence to catch missing downstream leftover items
    idsPresentInComparison[cFid] = true;
    
    var cAiWebsite = cRow[compMap["ai_website"]] || "";
    var cAiAddress = cRow[compMap["ai_address"]] || "";
    var cAiPhone = cRow[compMap["ai_phone"]] || "";
    var cAiHours = cRow[compMap["ai_operatinghours"]] || ""; // Updated matching column name
    var cAiLat = parseFloat(cRow[compMap["ai_lat"]]);
    var cAiLng = parseFloat(cRow[compMap["ai_lng"]]);
    
    // Upstream Pre-processed Validation Result Flags
    var resAddress = cRow[compMap["address_result"]] ? cRow[compMap["address_result"]].toString().toLowerCase().trim() : "";
    var resPhone = cRow[compMap["phone_result"]] ? cRow[compMap["phone_result"]].toString().toLowerCase().trim() : "";
    var resHours = cRow[compMap["hours_result"]] ? cRow[compMap["hours_result"]].toString().toLowerCase().trim() : "";
    var resWebsite = cRow[compMap["website_result"]] ? cRow[compMap["website_result"]].toString().toLowerCase().trim() : "";
    
    // Gate 1: AI Hallucination Check (ID missing from baseline snapshot)
    if (!mapfactsCache[cFid]) {
      humanReviewRows.push([cFid, "", cAiAddress, "", cAiPhone, "", "", cAiLat, cAiLng, "AI Hallucinated ID", 0, "Can't Fix", "", "", "", ""]);
      continue;
    }
    
    var mfData = mapfactsCache[cFid];
    
    // Gate 2: Proximity Match Review
    if (mfData.nbr_cnt > 0) {
      duplicateRows.push([cFid, mfData.address, cAiAddress, mfData.website, cAiWebsite, mfData.nbr_cnt, "Duplicate"]);
      continue;
    }
    
    // Gate 3a: Empty AI Payload Data Verification (Updated from AND to OR condition)
    if (!cAiAddress || !cAiPhone || !cAiWebsite || !cAiHours) {
      leftOverRows.push([cFid, mfData.address, mfData.website, mfData.phone, "Empty AI Payload", "Can't Fix", "", ""]);
      continue;
    }
    
    // Gate 3b: Missing Coordinate Integrity Scan
    if (isNaN(cAiLat) || isNaN(cAiLng) || !cAiLat || !cAiLng) {
      leftOverRows.push([cFid, mfData.address, mfData.website, mfData.phone, "Missing Coordinates", "Can't Fix", "", ""]);
      continue;
    }
    
    // Gate 4: Geospatial Displacement Check (Only measuring Proposed AI Coordinates)
    var drift = calculateHaversine(mfData.lat, mfData.lng, cAiLat, cAiLng);
    if (!isNaN(drift) && drift > 1.0) {
      humanReviewRows.push([cFid, mfData.address, cAiAddress, mfData.phone, cAiPhone, mfData.lat, mfData.lng, cAiLat, cAiLng, "Distance Drift > 1km", drift, "Can't Fix", "", "", "", ""]);
      continue;
    }
    
    // Gate 5: Proposed AI Phone Target Structure Validation (Isolated Function)
    if (cAiPhone && !isValidAiPhone(cAiPhone)) {
      humanReviewRows.push([cFid, mfData.address, cAiAddress, mfData.phone, cAiPhone, mfData.lat, mfData.lng, cAiLat, cAiLng, "Invalid Proposed AI Phone", drift || 0, "Can't Fix", "", "", "", ""]);
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
  writeTriageTab(ss, "Human_Review", ["ID", "Mapfacts_Address", "AI_Address", "Mapfacts_Phone", "AI_Phone", "Mapfacts_Lat", "Mapfacts_Lng", "AI_Lat", "AI_Lng", "Validation_Failure_Reason", "Calculated_Drift_KM", "QC_Action", "Fixed_Address", "Fixed_Phone", "Fixed_Website", "Fixed_Hours"], humanReviewRows, 12, ["Fixed", "Duplicate", "Spam", "Can't Fix"]);
  writeTriageTab(ss, "Duplicate_Review", ["ID", "Mapfacts_Address", "AI_Address", "Mapfacts_Website", "AI_Website", "nbr_cnt", "QC_Status"], duplicateRows, 7, ["Duplicate", "Not Duplicate", "Can't Decide"]);
  
  writeBugTab(ss, "Bugs_Address", ["ID", "AI_Website", "Address", "AI_Address", "raise_bug"], bugsAddress);
  writeBugTab(ss, "Bugs_Phone", ["ID", "AI_Website", "Address", "Mapfacts_Phone", "AI_Phone", "raise_bug"], bugsPhone);
  writeBugTab(ss, "Bugs_Hours", ["ID", "AI_Website", "Address", "Mapfacts_Operating_Hours", "AI_Operating_Hours", "raise_bug"], bugsHours);
  writeBugTab(ss, "Bugs_Website", ["ID", "AI_Website", "Address", "Mapfacts_Website", "raise_bug"], bugsWebsite);
  
  SpreadsheetApp.getUi().alert("Phase 1 Triage Generation Successfully Executed.");
}

/**
 * 10. MODULAR AI PHONE VALIDATION LOGIC ENGINE
 */
function isValidAiPhone(aiPhoneString) {
  if (!aiPhoneString) return true;
  var digits = aiPhoneString.toString().replace(/[^\d]/g, '');
  if (digits.length < 10 || digits.length > 15) {
    return false;
  }
  return true;
}

/**
 * Helper: Normalized Lowercase Header Ingestion Maps
 */
function getHeaderMap(headers) {
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    var name = headers[i].toString().toLowerCase().trim();
    map[name] = i;
  }
  return map;
}

/**
 * Helper: Reset and Initialize Clean Workspace Grids (Fixed Range Validation Reset)
 */
function createOrClearTab(ss, tabName, headers) {
  var sheet = ss.getSheetByName(tabName);
  if (sheet) {
    sheet.clear();
    sheet.getDataRange().clearDataValidations(); // Fixed from invalid sheet-level method call
  } else {
    sheet = ss.insertSheet(tabName);
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
  return sheet;
}

/**
 * Helper: Write rows and inject Dropdown Rules
 */
function writeTriageTab(ss, tabName, headers, data, dropdownColIndex, dropdownOptions) {
  var sheet = createOrClearTab(ss, tabName, headers);
  if (data.length === 0) return;
  
  sheet.getRange(2, 1, data.length, headers.length).setValues(data);
  var cellRange = sheet.getRange(2, dropdownColIndex, data.length, 1);
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(dropdownOptions).setAllowInvalid(false).build();
  cellRange.setDataValidation(rule);
}

/**
 * Helper: Write rows and inject interactive Checkboxes
 */
function writeBugTab(ss, tabName, headers, data) {
  var sheet = createOrClearTab(ss, tabName, headers);
  if (data.length === 0) return;
  
  sheet.getRange(2, 1, data.length, headers.length).setValues(data);
  var checkboxRange = sheet.getRange(2, headers.length, data.length, 1);
  checkboxRange.insertCheckboxes();
}

/**
 * Helper: Haversine Formula
 */
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