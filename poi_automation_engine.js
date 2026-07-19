/**
 * Phase 1: Ingestion, Validation, and Triage Engine
 * Executes high-performance in-memory processing to route POI mismatches.
 */
function runPhase1Ingestion() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. Source Sheets Configuration (Adjust names to match your master sheet setup)
  var mapfactsSheet = ss.getSheetByName("Mapfacts_Master_Data");
  var comparisonSheet = ss.getSheetByName("Comparison_Agent_Output");
  
  if (!mapfactsSheet || !comparisonSheet) {
    SpreadsheetApp.getUi().alert("Error: Ensure 'Mapfacts_Master_Data' and 'Comparison_Agent_Output' tabs exist.");
    return;
  }
  
  // 2. Extract Data to Memory Arrays (One-time API Reads)
  var rawMapfacts = mapfactsSheet.getDataRange().getValues();
  var rawComparison = comparisonSheet.getDataRange().getValues();
  
  var mfHeaders = rawMapfacts[0];
  var compHeaders = rawComparison[0];
  
  // 3. Dynamic Header Mapping Engine
  var mfMap = getHeaderMap(mfHeaders);
  var compMap = getHeaderMap(compHeaders);
  
  // 4. O(M) Mapfacts Cache Building
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
  
  // Create Verbatim Snapshot Copy
  createOrClearTab(ss, "Mapfacts_Snapshot", mfHeaders).getRange(2, 1, rawMapfacts.length - 1, mfHeaders.length).setValues(rawMapfacts.slice(1));
  
  // 5. Initialize Memory Storage Buckets for Output Tabs
  var leftOverRows = [];
  var humanReviewRows = [];
  var duplicateRows = [];
  
  var bugsAddress = [];
  var bugsPhone = [];
  var bugsHours = [];
  var bugsWebsite = [];
  
  // 6. O(N) Processing Pipeline Loop
  for (var j = 1; j < rawComparison.length; j++) {
    var cRow = rawComparison[j];
    var cFid = cRow[compMap["poi_fid"]];
    var cAiWebsite = cRow[compMap["ai_website"]] || "";
    var cAiAddress = cRow[compMap["ai_address"]] || "";
    var cAiPhone = cRow[compMap["ai_phone"]] || "";
    var cAiHours = cRow[compMap["ai_operating_hours"]] || "";
    var cAiLat = parseFloat(cRow[compMap["ai_lat"]]);
    var cAiLng = parseFloat(cRow[compMap["ai_lng"]]);
    
    // Gate 1: Hallucination Check
    if (!mapfactsCache[cFid]) {
      humanReviewRows.push([cFid, "", cAiAddress, "", cAiPhone, "", "", cAiLat, cAiLng, "AI Hallucinated ID", 0, "Can't Fix", "", "", "", ""]);
      continue;
    }
    
    var mfData = mapfactsCache[cFid];
    
    // Gate 2: Proximity Check (nbr_cnt)
    if (mfData.nbr_cnt > 0) {
      duplicateRows.push([cFid, mfData.address, cAiAddress, mfData.website, cAiWebsite, mfData.nbr_cnt, "Duplicate"]);
      continue;
    }
    
    // Gate 3: Empty AI Data Check
    if (!cAiAddress && !cAiPhone && !cAiWebsite && !cAiHours) {
      leftOverRows.push([cFid, mfData.address, mfData.website, mfData.phone, "Empty AI Payload", "Can't Fix", "", ""]);
      continue;
    }
    
    // Gate 4: Geospatial Drift via Haversine
    var drift = calculateHaversine(mfData.lat, mfData.lng, cAiLat, cAiLng);
    if (!isNaN(drift) && drift > 1.0) {
      humanReviewRows.push([cFid, mfData.address, cAiAddress, mfData.phone, cAiPhone, mfData.lat, mfData.lng, cAiLat, cAiLng, "Distance Drift > 1km", drift, "Can't Fix", "", "", "", ""]);
      continue;
    }
    
    // Gate 5: Phone Length Check
    var cleanPhone = cAiPhone.replace(/[^\d]/g, '');
    if (cAiPhone && (cleanPhone.length < 10 || cleanPhone.length > 15)) {
      humanReviewRows.push([cFid, mfData.address, cAiAddress, mfData.phone, cAiPhone, mfData.lat, mfData.lng, cAiLat, cAiLng, "Invalid Phone Length", drift || 0, "Can't Fix", "", "", "", ""]);
      continue;
    }
    
    // Gate 6: Attribute Breakdown (Sparse Payloads with Mandatory Fields)
    var cleanMfPhone = mfData.phone.replace(/[^\d]/g, '');
    var cleanAiPhoneField = cAiPhone.replace(/[^\d]/g, '');
    
    if (mfData.address !== cAiAddress) {
      bugsAddress.push([cFid, cAiWebsite, mfData.address, cAiAddress, false]);
    }
    if (cleanMfPhone !== cleanAiPhoneField) {
      bugsPhone.push([cFid, cAiWebsite, mfData.address, mfData.phone, cAiPhone, false]);
    }
    if (mfData.hours !== cAiHours) {
      bugsHours.push([cFid, cAiWebsite, mfData.address, mfData.hours, cAiHours, false]);
    }
    if (mfData.website !== cAiWebsite) {
      bugsWebsite.push([cFid, cAiWebsite, mfData.address, mfData.website, false]);
    }
  }
  
  // 7. Render Tabs and Inject UI Validations (One-time API Write Blocks)
  writeTriageTab(ss, "Left_Over", ["ID", "Mapfacts_Address", "Mapfacts_Website", "Mapfacts_Phone", "Source_Status", "QC_Action", "QC_Discovered_Website", "Resolution_Notes"], leftOverRows, 6, ["Found Website Link", "Duplicate", "Spam", "Can't Fix"]);
  writeTriageTab(ss, "Human_Review", ["ID", "Mapfacts_Address", "AI_Address", "Mapfacts_Phone", "AI_Phone", "Mapfacts_Lat", "Mapfacts_Lng", "AI_Lat", "AI_Lng", "Validation_Failure_Reason", "Calculated_Drift_KM", "QC_Action", "Fixed_Address", "Fixed_Phone", "Fixed_Website", "Fixed_Hours"], humanReviewRows, 12, ["Fixed", "Duplicate", "Spam", "Can't Fix"]);
  writeTriageTab(ss, "Duplicate_Review", ["ID", "Mapfacts_Address", "AI_Address", "Mapfacts_Website", "AI_Website", "nbr_cnt", "QC_Status"], duplicateRows, 7, ["Duplicate", "Not Duplicate", "Can't Decide"]);
  
  writeBugTab(ss, "Bugs_Address", ["ID", "AI_Website", "Address", "AI_Address", "raise_bug"], bugsAddress);
  writeBugTab(ss, "Bugs_Phone", ["ID", "AI_Website", "Address", "Mapfacts_Phone", "AI_Phone", "raise_bug"], bugsPhone);
  writeBugTab(ss, "Bugs_Hours", ["ID", "AI_Website", "Address", "Mapfacts_Operating_Hours", "AI_Operating_Hours", "raise_bug"], bugsHours);
  writeBugTab(ss, "Bugs_Website", ["ID", "AI_Website", "Address", "Mapfacts_Website", "raise_bug"], bugsWebsite);
  
  // Display Completed Workspace Export Link
  var urlMessage = "Phase 1 Complete! Share this spreadsheet link with your QC team:\n\n" + ss.getUrl();
  SpreadsheetApp.getUi().alert(urlMessage);
}

/**
 * Generates string key index locations from header arrays dynamically.
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
 * Creates or resets standard data grids safely.
 */
function createOrClearTab(ss, tabName, headers) {
  var sheet = ss.getSheetByName(tabName);
  if (sheet) {
    sheet.clear();
    sheet.setDataValidation(null);
  } else {
    sheet = ss.insertSheet(tabName);
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
  return sheet;
}

/**
 * Writes triage rows and injects operational validation dropdown lists.
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
 * Writes sparse attribute bug rows and appends interactive UI checkboxes.
 */
function writeBugTab(ss, tabName, headers, data) {
  var sheet = createOrClearTab(ss, tabName, headers);
  if (data.length === 0) return;
  
  sheet.getRange(2, 1, data.length, headers.length).setValues(data);
  
  var checkboxRange = sheet.getRange(2, headers.length, data.length, 1);
  checkboxRange.insertCheckboxes();
}

/**
 * Calculates straight line spatial separation distance using the Haversine equation.
 */
function calculateHaversine(lat1, lng1, lat2, lng2) {
  if (isNaN(lat1) || isNaN(lng1) || isNaN(lat2) || isNaN(lng2)) return NaN;
  var R = 6371; // Earth's Radius in KM
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLng/2) * Math.sin(dLng/2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}
