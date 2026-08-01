function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Overlap Finder')
    .addItem('🔍 1. Match Data', 'matchNearestGeospatialFeatures')
    .addItem('📤 2. Export QC File', 'exportCleanQcFile')
    .addItem('📥 3. Process QC File', 'processQcFileFromUrl')
    .addToUi();
}

function matchNearestGeospatialFeatures() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const mapfactsSheet = ss.getSheetByName("Mapfacts");
  const aiSheet = ss.getSheetByName("AI");

  if (!mapfactsSheet || !aiSheet) {
    throw new Error("Please ensure both 'Mapfacts' and 'AI' sheets exist with data.");
  }

  const mapfactsData = getSheetData(mapfactsSheet);
  const aiData = getSheetData(aiSheet);

  let aiResults = [];
  for (let i = 0; i < aiData.length; i++) {
    let aiRow = aiData[i];
    if (!aiRow.lat || !aiRow.lng) continue;

    let matchObj = findClosestAndBestAddress(aiRow.lat, aiRow.lng, aiRow.address, mapfactsData, "poi_fid", "address");

    aiRow["nearest_1_id"] = matchObj.closestGeoId;
    aiRow["nearest_1_dist_m"] = matchObj.minDistance;
    aiRow["match_strength"] = getDistanceTier(matchObj.minDistance);
    aiRow["nearest_address_match_id"] = matchObj.bestAddressId;

    var scorePct = matchObj.maxAddressScore * 100;
    aiRow["address_match_score"] = scorePct.toFixed(1) + "%";

    aiRow["final_assigned_id"] = calculationFinalAssignedId(
      matchObj.closestGeoId,
      matchObj.bestAddressId,
      matchObj.minDistance,
      scorePct
    );

    aiResults.push(aiRow);
  }
  aiResults = flagDuplicateMatches(aiResults, "nearest_1_id", "nearest_1_dist_m", "match_strength");

  let mapfactResults = [];
  for (let j = 0; j < mapfactsData.length; j++) {
    let mfRow = mapfactsData[j];
    if (!mfRow.lat || !mfRow.lng) continue;

    let matchObj = findClosestAndBestAddress(mfRow.lat, mfRow.lng, mfRow.address, aiData, "store_code", "address");

    mfRow["nearest_ai_store_code"] = matchObj.closestGeoId;
    mfRow["nearest_ai_dist_m"] = matchObj.minDistance;
    mfRow["match_strength"] = getDistanceTier(matchObj.minDistance);
    mfRow["nearest_address_match_id"] = matchObj.bestAddressId;

    var scorePct = matchObj.maxAddressScore * 100;
    mfRow["address_match_score"] = scorePct.toFixed(1) + "%";
    mfRow["match_strength_address"] = getAddressMatchStrength(scorePct);

    let finalCode = calculationFinalAssignedId(
      matchObj.closestGeoId,
      matchObj.bestAddressId,
      matchObj.minDistance,
      scorePct
    );

    mfRow["final_assigned_store_code"] = finalCode;
    mfRow["maps_link_review"] = mfRow["maps_link"] || "";

    let websiteClosestGeo = "";
    let websiteClosestAddress = "";
    
    if (matchObj.closestGeoId) {
      let geoMatch = aiData.find(aiRow => String(aiRow["store_code"]).trim() === String(matchObj.closestGeoId).trim());
      if (geoMatch) websiteClosestGeo = geoMatch["website"] || "";
    }
    
    if (matchObj.bestAddressId) {
      let addrMatch = aiData.find(aiRow => String(aiRow["store_code"]).trim() === String(matchObj.bestAddressId).trim());
      if (addrMatch) websiteClosestAddress = addrMatch["website"] || "";
    }

    mfRow["ai_website_closest_geo"] = websiteClosestGeo;
    mfRow["ai_website_closest_address"] = websiteClosestAddress;

    mapfactResults.push(mfRow);
  }

  mapfactResults = smartDeduplicateMapfacts(mapfactResults);

  writeToNewSheet("AI_with_nearest_neighbors", aiResults);
  writeToNewSheet("mapfacts_with_ai_matches", mapfactResults);

  Logger.log("Phase 1 Match Matrix processing complete!");
}

function exportCleanQcFile() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  const mapfactsMatchedSheet = ss.getSheetByName("mapfacts_with_ai_matches");
  const originalAiSheet = ss.getSheetByName("AI");
  const originalMapfactsSheet = ss.getSheetByName("Mapfacts");

  if (!mapfactsMatchedSheet || !originalAiSheet || !originalMapfactsSheet) {
    throw new Error("Missing required sheets. Please run '1. Match Data' first.");
  }

  const promptResponse = ui.prompt(
    "📊 Naming Your QC Report",
    "Please enter the CKB Name to append to the export file:",
    ui.ButtonSet.OK_CANCEL
  );

  if (promptResponse.getSelectedButton() !== ui.Button.OK) {
    ui.alert("Operation cancelled.");
    return;
  }

  let ckbName = promptResponse.getResponseText().replace(/[/\\?%*:|"<>\s]/g, "_").trim();
  if (!ckbName) ckbName = "Unnamed_CKB";
  ckbName = ckbName.toLowerCase();
  const dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const reportName = "ckb_mapfacts_ai_mapping_" + ckbName +"_qc_file";
  const newReportFile = SpreadsheetApp.create(reportName);

  const mapfactsMatchedData = getSheetData(mapfactsMatchedSheet);
  const originalAiData = getSheetData(originalAiSheet);

  let overlapRows = [];
  let conflictRows = [];
  let humanReviewRows = [];
  let onlyMapfactsRows = [];
  let onlyAiRows = [];

  const seenStoreCodes = new Set();
  for (let j = 0; j < mapfactsMatchedData.length; j++) {
    let row = mapfactsMatchedData[j];
    let code = String(row["final_assigned_store_code"] || "").trim();

    if (code.startsWith("Conflict:")) {
      conflictRows.push(row);
    } else if (code === "Human_Review_Needed") {
      humanReviewRows.push(row);
    } else if (code === "No_Match_Found" || code === "") {
      onlyMapfactsRows.push(row);
    } else {
      overlapRows.push(row);
      seenStoreCodes.add(code);
    }
  }

  for (let k = 0; k < originalAiData.length; k++) {
    let aiRow = originalAiData[k];
    let aiStoreCode = String(aiRow["store_code"] || "").trim();
    if (aiStoreCode && !seenStoreCodes.has(aiStoreCode)) {
      onlyAiRows.push(aiRow);
    }
  }

  writeToSpecificSheet(newReportFile, "Overlap", overlapRows, originalAiData);
  writeToSpecificSheet(newReportFile, "Human Review Needed", humanReviewRows, null);
  writeToSpecificSheet(newReportFile, "Duplicate Conflicts", conflictRows, originalAiData);
  writeToSpecificSheet(newReportFile, "Only Mapfacts", onlyMapfactsRows, null);
  writeToSpecificSheet(newReportFile, "Only AI", onlyAiRows, null);

  // Generate comparison_agent_input tab
  writeComparisonAgentInputTab(newReportFile, overlapRows, originalAiData);

  const mapfactsMatchesCopied = mapfactsMatchedSheet.copyTo(newReportFile);
  mapfactsMatchesCopied.setName("mapfacts_with_ai_matches");

  const aiNeighborsCopied = ss.getSheetByName("AI_with_nearest_neighbors").copyTo(newReportFile);
  aiNeighborsCopied.setName("AI_with_nearest_neighbors");

  const rawMapfactsCopied = originalMapfactsSheet.copyTo(newReportFile);
  rawMapfactsCopied.setName("Original Mapfacts Data");

  const rawAiCopied = originalAiSheet.copyTo(newReportFile);
  rawAiCopied.setName("Original AI Data");

  let defaultSheet = newReportFile.getSheetByName("Sheet1");
  if (defaultSheet) newReportFile.deleteSheet(defaultSheet);

  const fileUrl = newReportFile.getUrl();
  const htmlOutput = HtmlService
    .createHtmlOutput('<p>QC File (<b>' + reportName + '</b>) created without scripts!</p><br><a href="' + fileUrl + '" target="_blank" style="font-weight:bold;color:#1a73e8;text-decoration:none;font-size:16px;padding:10px;border:1px solid #1a73e8;border-radius:4px;">👉 Click Here to Open QC File</a>')
    .setWidth(450)
    .setHeight(180);

  ui.showModelessDialog(htmlOutput, "Export Complete");
}

function processQcFileFromUrl() {
  const ui = SpreadsheetApp.getUi();
  const promptResponse = ui.prompt(
    "📥 Ingest QC File",
    "Paste the URL of the reviewed QC Spreadsheet:",
    ui.ButtonSet.OK_CANCEL
  );

  if (promptResponse.getSelectedButton() !== ui.Button.OK) {
    ui.alert("Operation cancelled.");
    return;
  }

  const fileUrl = promptResponse.getResponseText().trim();
  if (!fileUrl) {
    ui.alert("Invalid URL provided.");
    return;
  }

  let qcSpreadsheet;
  try {
    qcSpreadsheet = SpreadsheetApp.openByUrl(fileUrl);
  } catch (e) {
    ui.alert("Could not open spreadsheet from URL. Ensure you have access permissions.");
    return;
  }

  const mapfactsSheet = qcSpreadsheet.getSheetByName("mapfacts_with_ai_matches");
  const aiSheet = qcSpreadsheet.getSheetByName("Original AI Data") || qcSpreadsheet.getSheetByName("AI");

  if (!mapfactsSheet || !aiSheet) {
    ui.alert("Required sheets ('mapfacts_with_ai_matches' and 'Original AI Data') missing in QC file.");
    return;
  }

  const allMapfactsData = getSheetData(mapfactsSheet);
  const originalAiData = getSheetData(aiSheet);

  const codeCounts = {};
  for (let i = 0; i < allMapfactsData.length; i++) {
    let row = allMapfactsData[i];
    let code = String(row["final_assigned_store_code"] || "").trim();

    if (code !== "" && code !== "No_Match_Found" && code !== "Human_Review_Needed" && !code.startsWith("Conflict:") && !code.startsWith("QC Conflict:")) {
      codeCounts[code] = (codeCounts[code] || 0) + 1;
    }
  }

  let finalOverlapRows = [];
  let finalConflictRows = [];
  let finalOnlyMapfactsRows = [];
  let finalOnlyAiRows = [];

  const claimedStoreCodes = new Set();

  for (let i = 0; i < allMapfactsData.length; i++) {
    let row = allMapfactsData[i];
    let code = String(row["final_assigned_store_code"] || "").trim();

    if (code === "" || code === "No_Match_Found" || code === "Human_Review_Needed") {
      finalOnlyMapfactsRows.push(row);
    } else if (code.startsWith("Conflict:") || code.startsWith("QC Conflict:")) {
      finalConflictRows.push(row);
    } else if (codeCounts[code] > 1) {
      row["final_assigned_store_code"] = "QC Conflict: Duplicate Store Code " + code;
      finalConflictRows.push(row);
    } else {
      finalOverlapRows.push(row);
      claimedStoreCodes.add(code);
    }
  }

  for (let k = 0; k < originalAiData.length; k++) {
    let aiRow = originalAiData[k];
    let aiStoreCode = String(aiRow["store_code"] || "").trim();

    if (aiStoreCode && !claimedStoreCodes.has(aiStoreCode)) {
      finalOnlyAiRows.push(aiRow);
    }
  }

  overwriteSheetInFile(qcSpreadsheet, "Overlap", finalOverlapRows, originalAiData);
  overwriteSheetInFile(qcSpreadsheet, "Duplicate Conflicts", finalConflictRows, originalAiData);
  overwriteSheetInFile(qcSpreadsheet, "Only Mapfacts", finalOnlyMapfactsRows, null);
  overwriteSheetInFile(qcSpreadsheet, "Only AI", finalOnlyAiRows, null);

  // Update comparison_agent_input tab post-QC
  overwriteComparisonAgentInputTab(qcSpreadsheet, finalOverlapRows, originalAiData);

  let reviewSheet = qcSpreadsheet.getSheetByName("Human Review Needed");
  if (reviewSheet) {
    qcSpreadsheet.deleteSheet(reviewSheet);
  }

  ui.alert("Success! The QC spreadsheet tabs (Overlap, Duplicate Conflicts, Only Mapfacts, Only AI, comparison_agent_input) have been updated.");
}

function writeComparisonAgentInputTab(targetSpreadsheet, overlapRows, originalAiData) {
  let sheet = targetSpreadsheet.insertSheet("comparison_agent_input");

  const headers = [
    "poi_fid", "address", "phone", "website", "operating_hours", "lat", "lng",
    "ai_store_code", "ai_address", "ai_website", "ai_operating_hours", "ai_phone"
  ];

  if (!overlapRows || overlapRows.length === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return;
  }

  const aiLookupMap = {};
  if (originalAiData) {
    for (let k = 0; k < originalAiData.length; k++) {
      let aiRow = originalAiData[k];
      if (aiRow["store_code"]) {
        aiLookupMap[String(aiRow["store_code"]).trim()] = aiRow;
      }
    }
  }

  let matrix = [headers];

  for (let i = 0; i < overlapRows.length; i++) {
    let row = overlapRows[i];
    let matchedCode = String(row["final_assigned_store_code"] || "").trim();
    let matchedAiRow = aiLookupMap[matchedCode] || {};

    let poiFid = row["poi_fid"] !== undefined ? row["poi_fid"] : "";
    let mfAddress = row["address"] !== undefined ? row["address"] : "";
    let mfPhone = row["phone"] !== undefined ? row["phone"] : (row["Phone"] !== undefined ? row["Phone"] : "");
    let mfWebsite = row["website"] !== undefined ? row["website"] : (row["Website"] !== undefined ? row["Website"] : "");
    let mfOpHours = row["operating_hours"] !== undefined ? row["operating_hours"] : (row["opening_hours"] !== undefined ? row["opening_hours"] : "");
    let mfLat = row["lat"] !== undefined ? row["lat"] : "";
    let mfLng = row["lng"] !== undefined ? row["lng"] : "";

    let aiStoreCode = matchedAiRow["store_code"] !== undefined ? matchedAiRow["store_code"] : "";
    let aiAddress = matchedAiRow["address"] !== undefined ? matchedAiRow["address"] : "";
    let aiWebsite = matchedAiRow["Website"] !== undefined ? matchedAiRow["Website"] : (matchedAiRow["website"] !== undefined ? matchedAiRow["website"] : "");
    let aiOpHours = matchedAiRow["operating_hours"] !== undefined ? matchedAiRow["operating_hours"] : (matchedAiRow["opening_hours"] !== undefined ? matchedAiRow["opening_hours"] : "");
    let aiPhone = matchedAiRow["Phone"] !== undefined ? matchedAiRow["Phone"] : (matchedAiRow["phone"] !== undefined ? matchedAiRow["phone"] : "");

    matrix.push([
      poiFid, mfAddress, mfPhone, mfWebsite, mfOpHours, mfLat, mfLng,
      aiStoreCode, aiAddress, aiWebsite, aiOpHours, aiPhone
    ]);
  }

  sheet.getRange(1, 1, matrix.length, headers.length).setValues(matrix);
}

function overwriteComparisonAgentInputTab(targetSpreadsheet, overlapRows, originalAiData) {
  let sheet = targetSpreadsheet.getSheetByName("comparison_agent_input");
  if (sheet) {
    targetSpreadsheet.deleteSheet(sheet);
  }
  writeComparisonAgentInputTab(targetSpreadsheet, overlapRows, originalAiData);
}

function overwriteSheetInFile(targetSpreadsheet, targetSheetName, dataArray, originalAiData) {
  let sheet = targetSpreadsheet.getSheetByName(targetSheetName);
  if (sheet) {
    targetSpreadsheet.deleteSheet(sheet);
  }
  writeToSpecificSheet(targetSpreadsheet, targetSheetName, dataArray, originalAiData);
}

function calculationFinalAssignedId(geoId, addressId, distance, scorePct) {
  if (distance >= 2000 && scorePct < 40) {
    return "No_Match_Found";
  }

  if (distance > 10000) {
    return "No_Match_Found";
  }

  if (geoId === addressId && geoId !== null) {
    return geoId;
  }

  // if(distance<=10){
  //   return geoId;
  // }

  if (distance <= 50) {
    if (scorePct < 30) return "Human_Review_Needed";
    return geoId;
  }

  if (distance <= 500) {
    if (scorePct >= 40) return geoId;
    return "Human_Review_Needed";
  }

  if (distance > 500) {
    if (scorePct >= 50 && addressId !== null) return addressId;
    return "Human_Review_Needed";
  }

  return "Human_Review_Needed";
}

function findClosestAndBestAddress(sourceLat, sourceLng, sourceAddress, targetArray, idColumnName, addressColumnName) {
  let minDistance = Infinity;
  let closestGeoId = null;
  let maxAddressScore = -1;
  let bestAddressId = null;

  for (let i = 0; i < targetArray.length; i++) {
    let target = targetArray[i];
    if (!target.lat || !target.lng) continue;

    let distance = getHaversineDistance(sourceLat, sourceLng, target.lat, target.lng);

    if (distance < minDistance) {
      minDistance = distance;
      closestGeoId = target[idColumnName];
    }
    
  
    let addressScore = getTokenSimilarity(sourceAddress, target[addressColumnName]);
    if (addressScore > maxAddressScore) {
      maxAddressScore = addressScore;
      bestAddressId = target[idColumnName];
    }
    
  }

  return {
    closestGeoId: closestGeoId,
    minDistance: minDistance,
    bestAddressId: bestAddressId,
    maxAddressScore: maxAddressScore === -1 ? 0 : maxAddressScore
  };
}

function getTokenSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  let str1_normalized =  normalizeAddress(str1);
  let str2_normalized =  normalizeAddress(str2);
  let clean = function (s) {
    return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  };
  let tokens1 = clean(str1_normalized);
  let tokens2 = clean(str2_normalized);
  if (tokens1.length === 0 || tokens2.length === 0) return 0;

  let intersect = 0;
  let map = {};
  tokens1.forEach(function (t) { map[t] = (map[t] || 0) + 1; });
  tokens2.forEach(function (t) {
    if (map[t] > 0) {
      intersect++;
      map[t]--;
    }
  });

  return (2 * intersect) / (tokens1.length + tokens2.length);
}

function smartDeduplicateMapfacts(dataArray) {
  const storeAssignments = {};

  for (let i = 0; i < dataArray.length; i++) {
    let row = dataArray[i];
    let code = row["final_assigned_store_code"];
    
    if (!code || code === "Human_Review_Needed" || code === "No_Match_Found" || String(code).trim() === "") continue;

    let dist = parseFloat(row["nearest_ai_dist_m"]) || Infinity;
    let score = parseFloat(String(row["address_match_score"]).replace("%", "")) || 0;
    
    let geoId = String(row["nearest_ai_store_code"] || "").trim();
    let addrId = String(row["nearest_address_match_id"] || "").trim();
    let targetCode = String(code).trim();
    
    let hasAlignmentLock = (geoId === targetCode && addrId === targetCode);
    let compositeRank = score - (dist / 10);

    if (!(code in storeAssignments)) {
      storeAssignments[code] = { index: i, hasAlignmentLock: hasAlignmentLock, compositeRank: compositeRank, poiFid: row["poi_fid"] };
    } else {
      let currentBest = storeAssignments[code];
      let replace = false;

      if (hasAlignmentLock && !currentBest.hasAlignmentLock) {
        replace = true;
      } else if (!hasAlignmentLock && currentBest.hasAlignmentLock) {
        replace = false;
      } else {
        if (compositeRank > currentBest.compositeRank) {
          replace = true;
        }
      }

      if (replace) {
        storeAssignments[code] = { index: i, hasAlignmentLock: hasAlignmentLock, compositeRank: compositeRank, poiFid: row["poi_fid"] };
      }
    }
  }

  for (let i = 0; i < dataArray.length; i++) {
    let row = dataArray[i];
    let code = row["final_assigned_store_code"];

    if (!code || code === "Human_Review_Needed" || code === "No_Match_Found" || String(code).trim() === "") continue;

    let bestMatch = storeAssignments[code];
    if (bestMatch.index !== i) {
      row["final_assigned_store_code"] = "Conflict: StoreCode " + code + " taken by POI " + bestMatch.poiFid;
    }
  }

  return dataArray;
}

function writeToSpecificSheet(targetSpreadsheet, targetSheetName, dataArray, originalAiData) {
  if (dataArray.length === 0) {
    targetSpreadsheet.insertSheet(targetSheetName).getRange(1, 1).setValue("No records found for this category.");
    return;
  }

  let newSheet = targetSpreadsheet.insertSheet(targetSheetName);
  let headers = [];
  let matrixRows = [];

  if (targetSheetName === "Overlap" || targetSheetName === "Duplicate Conflicts") {
    const aiLookupMap = {};
    if (originalAiData) {
      for (let k = 0; k < originalAiData.length; k++) {
        let aiRow = originalAiData[k];
        if (aiRow["store_code"]) {
          aiLookupMap[String(aiRow["store_code"]).trim()] = aiRow;
        }
      }
    }

    headers = [
      "poi_fid", "maps_link", "ai_website_closest_geo", "ai_website_closest_address", 
      "name", "name_local", "is_possible_spam_poi_bucket",
      "failure_reason", "probable_duplicate", "nbr_cluster_id", "cluster_group", "address", "website",
      "storeCode", "Name", "address_ai", "Phone", "Website_ai",
      "nearest_ai_store_code", "nearest_ai_dist_m", "match_strength",
      "nearest_address_match_id", "address_match_score", "final_assigned_store_code", "maps_link_review"
    ];

    const visualHeaders = [
      "poi_fid", "maps_link", "nearest_ai_storeCode_website", "nearest_address_website", 
      "name", "name_local", "is_possible_spam_poi_bucket",
      "failure_reason", "probable_duplicate", "nbr_cluster_id", "cluster_group", "address", "website",
      "ai_storeCode", "ai_name", "ai_address", "ai_phone", "ai_website_master",
      "nearest_ai_store_code", "nearest_ai_dist_m", "match_strength",
      "nearest_address_match_id", "address_match_score", "final_assigned_store_code", "maps_link_review"
    ];

    matrixRows.push(visualHeaders);

    for (let i = 0; i < dataArray.length; i++) {
      let rowData = dataArray[i];
      let rawCode = rowData["final_assigned_store_code"] || rowData["nearest_ai_store_code"];
      
      let cleanLookupKey = "";
      if (rawCode) {
        let strCode = String(rawCode).trim();
        let conflictMatch = strCode.match(/Conflict:\s*StoreCode\s+([^\s]+)\s+taken by POI/i);
        if (conflictMatch && conflictMatch[1]) {
          cleanLookupKey = conflictMatch[1];
        } else if (strCode.startsWith("Conflict:")) {
          cleanLookupKey = String(rowData["nearest_ai_store_code"] || "").trim();
        } else if (strCode.startsWith("QC Conflict:")) {
          cleanLookupKey = strCode.replace(/^QC Conflict: Duplicate Store Code\s*/i, "").trim();
        } else {
          cleanLookupKey = strCode;
        }
      }

      let matchedAiRow = aiLookupMap[cleanLookupKey] || {};

      let formattedRow = headers.map(function (header) {
        if (rowData[header] !== undefined) return rowData[header];
        if (header === "storeCode") return cleanLookupKey;

        if (header === "Name") return matchedAiRow["Name"] !== undefined ? matchedAiRow["Name"] : "";
        if (header === "address_ai") return matchedAiRow["address"] !== undefined ? matchedAiRow["address"] : "";
        if (header === "Phone") return matchedAiRow["Phone"] !== undefined ? matchedAiRow["Phone"] : "";
        if (header === "Website_ai") return matchedAiRow["Website"] !== undefined ? matchedAiRow["Website"] : "";

        return "";
      });
      matrixRows.push(formattedRow);
    }

  } else {
    headers = Object.keys(dataArray[0]);
    matrixRows.push(headers);

    for (let i = 0; i < dataArray.length; i++) {
      let row = headers.map(header => dataArray[i][header]);
      matrixRows.push(row);
    }
  }

  newSheet.getRange(1, 1, matrixRows.length, matrixRows[0].length).setValues(matrixRows);
}

function flagDuplicateMatches(dataArray, idField, distField, strengthField) {
  const bestMatches = {};

  for (let i = 0; i < dataArray.length; i++) {
    let row = dataArray[i];
    let targetId = row[idField];
    let distance = row[distField];

    if (!targetId) continue;

    if (!(targetId in bestMatches) || distance < bestMatches[targetId].distance) {
      bestMatches[targetId] = { index: i, distance: distance };
    }
  }

  for (let i = 0; i < dataArray.length; i++) {
    let row = dataArray[i];
    let targetId = row[idField];

    if (!targetId) continue;

    if (bestMatches[targetId].index !== i) {
      row[strengthField] = "Already matched to a closer entry";
    }
  }

  return dataArray;
}

function getDistanceTier(dist) {
  if (dist <= 50) return "Tier 1: Exceptional";
  if (dist < 100) return "Tier 2: Strong";
  if (dist < 200) return "Tier 3: Moderate";
  if (dist < 300) return "Tier 4: Fair";
  if (dist < 500) return "Tier 5: Low";
  if (dist < 2000) return "Tier 6: Negligible";
  return "Out of Scope";
}

function getAddressMatchStrength(addressScore) {
  if (addressScore >= 75) return "Tier 1: Exceptional";
  if (addressScore >= 60) return "Tier 2: Strong";
  if (addressScore >= 50) return "Tier 3: Moderate";
  if (addressScore >= 40) return "Tier 4: Fair";
  if (addressScore >= 30) return "Tier 5: Low";
  return "Tier 6: Negligible";
}

function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

function getHaversineDistance(lat1, lon1, lat2, lon2) {
  const EARTH_RADIUS = 6371000;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return c * EARTH_RADIUS;
}

function getSheetData(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const headers = data[0].map(h => h.toString().trim());
  const rows = [];

  for (let i = 1; i < data.length; i++) {
    let rowObj = {};
    for (let j = 0; j < headers.length; j++) {
      rowObj[headers[j]] = data[i][j];
    }
    rows.push(rowObj);
  }
  return rows;
}

function writeToNewSheet(sheetName, dataArray) {
  if (dataArray.length === 0) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let existingSheet = ss.getSheetByName(sheetName);
  if (existingSheet) ss.deleteSheet(existingSheet);

  let newSheet = ss.insertSheet(sheetName);
  const headers = Object.keys(dataArray[0]);
  const outputMatrix = [headers];

  for (let i = 0; i < dataArray.length; i++) {
    let row = headers.map(header => dataArray[i][header]);
    outputMatrix.push(row);
  }
  newSheet.getRange(1, 1, outputMatrix.length, outputMatrix[0].length).setValues(outputMatrix);
}





function normalizeAddress(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .replace(/\bi[- ]?(\d+)\b/g, "interstate $1")
    // Expand common directional abbreviations
    .replace(/\bn\b/g, "north")
    .replace(/\bs\b/g, "south")
    .replace(/\be\b/g, "east")
    .replace(/\bw\b/g, "west")
    .replace(/\bne\b/g, "northeast")
    .replace(/\bnw\b/g, "northwest")
    .replace(/\bse\b/g, "southeast")
    .replace(/\bsw\b/g, "southwest")
    // Expand street types
    .replace(/\bst\b/g, "street")
    .replace(/\brd\b/g, "road")
    .replace(/\bave?\b/g, "avenue")
    .replace(/\bblvd\b/g, "boulevard")
    .replace(/\bpkwy\b/g, "parkway")
    .replace(/\bdr\b/g, "drive")
    .replace(/\bln\b/g, "lane")
    .replace(/\bhwy\b/g, "highway")
    .replace(/\b(united states|usa|us)\b/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}