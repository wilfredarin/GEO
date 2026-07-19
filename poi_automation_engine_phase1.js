/**
 * Apps Script Automation Engine: POI Verification Control Hub
 * Phase 1 Pipeline & Isolated Workspace Exporter
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("🛰️ Data Pipeline Automation")
    .addItem("🐞 1. Run Ingestion & Triage Pipeline", "executePhase1Pipeline")
    .addItem("📁 2. Export Workspace for QC Team", "exportCleanQCSandbox")
    .addItem("⚙️ 3. Process Phase 2 & Compile GDE Shipping", "executePhase2Pipeline Placeholder")
    .addToUi();
}

/**
 * PHASE 1: INGESTION, ANALYSIS & INITIAL TRIAGE ROUTING
 */
function executePhase1Pipeline() {
  const ui = SpreadsheetApp.getUi();
  const masterSs = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. Fetch Configuration Parameters
  const configTab = masterSs.getSheetByName("Config");
  if (!configTab) {
    ui.alert("Configuration Error", "The baseline 'Config' tab could not be found. Please ensure it exists.", ui.ButtonSet.OK);
    return;
  }
  
  const mapfactsUrl = configTab.getRange("B1").getValue().toString().trim();
  if (!mapfactsUrl) {
    ui.alert("Configuration Error", "Cell B1 in the 'Config' tab must contain a valid external Mapfacts Sheet URL.", ui.ButtonSet.OK);
    return;
  }
  
  try {
    // 2. Ingest External Baseline Snapshot
    const externalSs = SpreadsheetApp.openByUrl(mapfactsUrl);
    const externalSheet = externalSs.getSheets()[0]; 
    const mapfactsData = externalSheet.getDataRange().getValues();
    
    let snapshotTab = masterSs.getSheetByName("Mapfacts_Snapshot");
    if (snapshotTab) masterSs.deleteSheet(snapshotTab);
    snapshotTab = masterSs.insertSheet("Mapfacts_Snapshot");
    snapshotTab.getRange(1, 1, mapfactsData.length, mapfactsData[0].length).setValues(mapfactsData);
    
    // 3. Extract and Map Headers Dynamic Array
    const headers = mapfactsData[0].map(h => h.toString().trim().toLowerCase());
    const idIdx = headers.indexOf("id");
    const addressIdx = headers.indexOf("address");
    const phoneIdx = headers.indexOf("phone");
    const websiteIdx = headers.indexOf("website");
    const hoursIdx = headers.indexOf("operating_hours");
    
    if (idIdx === -1) {
      ui.alert("Data Error", "The external Mapfacts dataset is missing a mandatory 'id' column header.", ui.ButtonSet.OK);
      return;
    }

    // Fetch the Comparison Agent output data from the local execution tab
    const agentTab = masterSs.getSheetByName("Comparison_Agent_Output");
    if (!agentTab) {
      ui.alert("Data Error", "Missing local tracking source tab 'Comparison_Agent_Output'.", ui.ButtonSet.OK);
      return;
    }
    const agentData = agentTab.getDataRange().getValues();
    const agentHeaders = agentData[0].map(h => h.toString().trim().toLowerCase());
    
    const aIdIdx = agentHeaders.indexOf("id");
    const aAddressIdx = agentHeaders.indexOf("ai_address");
    const aPhoneIdx = agentHeaders.indexOf("ai_phone");
    const aWebsiteIdx = agentHeaders.indexOf("ai_website");
    const aHoursIdx = agentHeaders.indexOf("ai_operatinghours");
    const distIdx = agentHeaders.indexOf("distance_km");
    
    // Core Evaluation Result Column Flags Setup
    const addressResIdx = agentHeaders.indexOf("address_result");
    const phoneResIdx = agentHeaders.indexOf("phone_result");
    const websiteResIdx = agentHeaders.indexOf("website_result");
    const hoursResIdx = agentHeaders.indexOf("hours_result");

    // Initialize/Wipe clean Triage Sheets
    const triageSheets = {
      address: setupTriageSheet(masterSs, "Bugs_Address", ["id", "address", "ai_address", "raise_bug"]),
      phone: setupTriageSheet(masterSs, "Bugs_Phone", ["id", "phone", "ai_phone", "raise_bug"]),
      website: setupTriageSheet(masterSs, "Bugs_Website", ["id", "website", "ai_website", "raise_bug"]),
      hours: setupTriageSheet(masterSs, "Bugs_Hours", ["id", "operating_hours", "ai_operatinghours", "raise_bug"]),
      human: setupTriageSheet(masterSs, "Human_Review", ["id", "address", "ai_address", "phone", "ai_phone", "website", "ai_website", "operating_hours", "ai_operatinghours", "distance_km", "fixed_address", "fixed_phone", "fixed_website", "fixed_operatinghours", "qc_action_status"]),
      duplicate: setupTriageSheet(masterSs, "Duplicate_Review", ["id", "address", "duplicate_check_status"]),
      leftover: setupTriageSheet(masterSs, "Left_Over", ["id", "address", "website", "triage_action_status", "qc_discovered_website"]),
      manual: setupTriageSheet(masterSs, "Manual_Bug_Tab", ["id", "address", "ai_address", "phone", "ai_phone", "website", "ai_website", "operating_hours", "ai_operatinghours", "address_result", "phone_result", "website_result", "hours_result", "overall_status"])
    };

    // Build operational comparison lookup map from baseline snapshot array
    const mapfactsMap = {};
    for (let i = 1; i < mapfactsData.length; i++) {
      const row = mapfactsData[i];
      if (row[idIdx]) mapfactsMap[row[idIdx].toString().trim()] = row;
    }

    const matchedMapfactsIds = new Set();

    // 4. Run Row Evaluation Loop Processing Strategy
    for (let j = 1; j < agentData.length; j++) {
      const agentRow = agentData[j];
      const currentId = agentRow[aIdIdx] ? agentRow[aIdIdx].toString().trim() : "";
      if (!currentId) continue;

      const baseRow = mapfactsMap[currentId];
      if (!baseRow) continue; // Captured as Left_Over later if omitted completely
      matchedMapfactsIds.add(currentId);

      const distance = distIdx !== -1 ? parseFloat(agentRow[distIdx]) : 0;
      
      // Extract target values gracefully
      const baseAddr = addressIdx !== -1 ? baseRow[addressIdx] : "";
      const aiAddr = aAddressIdx !== -1 ? agentRow[aAddressIdx] : "";
      const basePhone = phoneIdx !== -1 ? baseRow[phoneIdx] : "";
      const aiPhone = aPhoneIdx !== -1 ? agentRow[aPhoneIdx] : "";
      const baseWeb = websiteIdx !== -1 ? baseRow[websiteIdx] : "";
      const aiWeb = aWebsiteIdx !== -1 ? agentRow[aWebsiteIdx] : "";
      const baseHrs = hoursIdx !== -1 ? baseRow[hoursIdx] : "";
      const aiHrs = aHoursIdx !== -1 ? agentRow[aHoursIdx] : "";

      // Evaluation Mismatch Rules Check Logic
      const isAddrMismatch = addressResIdx !== -1 && agentRow[addressResIdx].toString().trim().toLowerCase() === "mismatch";
      const isPhoneMismatch = phoneResIdx !== -1 && agentRow[phoneResIdx].toString().trim().toLowerCase() === "mismatch";
      const isWebMismatch = websiteResIdx !== -1 && agentRow[websiteResIdx].toString().trim().toLowerCase() === "mismatch";
      const isHoursMismatch = hoursResIdx !== -1 && agentRow[hoursResIdx].toString().trim().toLowerCase() === "mismatch";

      // Context Validation: Critical Distance Threshold Gate Check
      if (distance > 1.0) {
        triageSheets.human.appendRow([currentId, baseAddr, aiAddr, basePhone, aiPhone, baseWeb, aiWeb, baseHrs, aiHrs, distance, "", "", "", "", "Pending Review"]);
        continue; 
      }

      // Route based on explicit data mismatch criteria rules
      if (isAddrMismatch) triageSheets.address.appendRow([currentId, baseAddr, aiAddr, true]);
      if (isPhoneMismatch) triageSheets.phone.appendRow([currentId, basePhone, aiPhone, true]);
      if (isWebMismatch) triageSheets.website.appendRow([currentId, baseWeb, aiWeb, true]);
      if (isHoursMismatch) triageSheets.hours.appendRow([currentId, baseHrs, aiHrs, true]);
    }

    // 5. Unmatched Record Capture Validation (Leftover & Duplicate Evaluation Checks)
    for (let k = 1; k < mapfactsData.length; k++) {
      const bRow = mapfactsData[k];
      const bId = bRow[idIdx] ? bRow[idIdx].toString().trim() : "";
      if (!bId || matchedMapfactsIds.has(bId)) continue;

      const bAddr = addressIdx !== -1 ? bRow[addressIdx] : "";
      const bWeb = websiteIdx !== -1 ? bRow[websiteIdx] : "";

      // Logic Rule: If baseline has no website string payload, route directly to Left_Over tracking sheet
      if (!bWeb) {
        triageSheets.leftover.appendRow([bId, bAddr, bWeb, "Pending Link Lookup", ""]);
      } else {
        triageSheets.duplicate.appendRow([bId, bAddr, "Pending Clean Double-Check"]);
      }
    }

    // 6. Inject Data Validation Dropdowns into Triage Sheets for Operations Stability
    applyDropdownToColumn(triageSheets.human, 15, ["Pending Review", "Verified OK", "Fixed", "Can't Fix"]);
    applyDropdownToColumn(triageSheets.duplicate, 3, ["Pending Clean Double-Check", "Clear - No Duplicate", "Duplicate", "Spam"]);
    applyDropdownToColumn(triageSheets.leftover, 4, ["Pending Link Lookup", "Found Website Link", "Spam", "Duplicate"]);
    
    // Inject Interactive Validation Matrix to the Manual Entry target tab
    applyDropdownToColumn(triageSheets.manual, 10, ["Match", "Mismatch"]);
    applyDropdownToColumn(triageSheets.manual, 11, ["Match", "Mismatch"]);
    applyDropdownToColumn(triageSheets.manual, 12, ["Match", "Mismatch"]);
    applyDropdownToColumn(triageSheets.manual, 13, ["Match", "Mismatch"]);
    applyDropdownToColumn(triageSheets.manual, 14, ["Pending Verification", "Complete"]);

    // Enforce Checkboxes for Automated Sparse Bug Tracking Tabs
    ["address", "phone", "website", "hours"].forEach(key => {
      const sheet = triageSheets[key];
      const lastRow = sheet.getLastRow();
      if (lastRow > 1) {
        sheet.getRange(2, 4, lastRow - 1, 1).setDataValidation(
          SpreadsheetApp.newDataValidation().requireCheckbox().build()
        );
      }
    });

    ui.alert("Pipeline Success", "Phase 1: Ingestion processing and triage allocation completed smoothly with zero compilation conflicts.", ui.ButtonSet.OK);

  } catch (error) {
    ui.alert("Execution Pipeline Error", "An error occurred during runtime execution:\n" + error.toString(), ui.ButtonSet.OK);
  }
}

/**
 * PHASE 1 HELPER MODULES: ISOLATED WORKSPACE EXPORTER
 */
function exportCleanQCSandbox() {
  const ui = SpreadsheetApp.getUi();
  const masterSs = SpreadsheetApp.getActiveSpreadsheet();
  
  const targetTabs = [
    "Bugs_Address", "Bugs_Phone", "Bugs_Website", "Bugs_Hours",
    "Human_Review", "Duplicate_Review", "Left_Over", "Manual_Bug_Tab"
  ];
  
  // Verify tabs were generated by Phase 1 before running export routine
  const missingTabs = targetTabs.filter(name => !masterSs.getSheetByName(name));
  if (missingTabs.length > 0) {
    ui.alert("Export Refused", "Cannot compile export profile. The following triage tabs are missing: " + missingTabs.join(", ") + "\n\nPlease run Phase 1 Pipeline execution blocks first.", ui.ButtonSet.OK);
    return;
  }
  
  // Prompt user for explicit configuration URL destination target
  const response = ui.prompt(
    "✈️ Export Data to Clean QC Workspace",
    "Please paste the exact URL string of the remote destination Google Sheet configured for the QC team operations workspace:",
    ui.ButtonSet.OK_CANCEL
  );
  
  if (response.getSelectedButton() !== ui.Button.OK) return;
  
  const remoteUrl = response.getResponseText().trim();
  if (!remoteUrl) {
    ui.alert("Input Error", "The provided target workspace destination URL string cannot be blank.", ui.ButtonSet.OK);
    return;
  }
  
  try {
    const remoteSs = SpreadsheetApp.openByUrl(remoteUrl);
    
    targetTabs.forEach(tabName => {
      const sourceSheet = masterSs.getSheetByName(tabName);
      const dataRange = sourceSheet.getDataRange();
      const values = dataRange.getValues();
      const validations = dataRange.getDataValidations();
      
      let remoteSheet = remoteSs.getSheetByName(tabName);
      if (remoteSheet) {
        remoteSheet.clear();
      } else {
        remoteSheet = remoteSs.insertSheet(tabName);
      }
      
      // Clone exact tracking array dimensions cleanly across execution boundaries
      remoteSheet.getRange(1, 1, values.length, values[0].length).setValues(values);
      
      // Mirror checkboxes and status lists validation setups down to target sheet
      remoteSheet.getRange(1, 1, validations.length, validations[0].length).setDataValidations(validations);
      
      // Apply clean formatting parameters for the QC team's readability
      remoteSheet.setFrozenRows(1);
      remoteSheet.getRange(1, 1, 1, values[0].length)
        .setBackground("#34495e")
        .setFontColor("#ffffff")
        .setFontWeight("bold");
      remoteSheet.autoResizeColumns(1, values[0].length);
    });
    
    // Drop the clean baseline default starting sheet on target workspace to declutter view
    const defaultSheet = remoteSs.getSheetByName("Sheet1");
    if (defaultSheet) remoteSs.deleteSheet(defaultSheet);
    
    ui.alert("Export Successful", "All triage verification tracking channels have been cleanly integrated into the designated remote operations sheet workspace.", ui.ButtonSet.OK);
    
  } catch (err) {
    ui.alert("Remote Pipeline Mapping Crash", "Connection failure trying to access the provided spreadsheet workspace:\n" + err.toString(), ui.ButtonSet.OK);
  }
}

/**
 * GENERIC PIPELINE COMPONENT UTILITIES
 */
function setupTriageSheet(spreadsheet, name, headerArray) {
  let sheet = spreadsheet.getSheetByName(name);
  if (sheet) spreadsheet.deleteSheet(sheet);
  sheet = spreadsheet.insertSheet(name);
  sheet.appendRow(headerArray);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headerArray.length)
    .setBackground("#2c3e50")
    .setFontColor("#ffffff")
    .setFontWeight("bold");
  return sheet;
}

function applyDropdownToColumn(sheet, columnIndex, optionsArray) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  
  const targetRange = sheet.getRange(2, columnIndex, lastRow - 1, 1);
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(optionsArray, true)
    .setAllowInvalid(false)
    .build();
    
  targetRange.setDataValidation(rule);
}

function executePhase2PipelinePlaceholder() {
  SpreadsheetApp.getUi().alert("Pipeline Notice", "Phase 1 sandbox states verified. Ready to initiate Phase 2 alignment compilation blocks once requested.", SpreadsheetApp.getUi().ButtonSet.OK);
}