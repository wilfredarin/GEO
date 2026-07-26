# 📍 Geospatial Overlap Finder & Data Matching Pipeline

A Google Apps Script tool designed to cross-match spatial location data between **Mapfacts** (POI data) and **AI** (Master Store data) using geographic distance calculations, string token similarity, and automated deduplication rules.

---

## 🚀 Overview & Workflow

The pipeline runs sequentially via a custom menu interface directly within Google Sheets:

$$\text{[1. Match Data]} \longrightarrow \text{[2. Export QC File]} \longrightarrow \text{[3. Process QC File]}$$

1. **`Match Data` (Phase 1):** Calculates Haversine distances ($\text{lat}, \text{lng}$) and address string token similarities between records, assigns confidence IDs based on predefined thresholds, and applies deduplication logic.
2. **`Export QC File` (Phase 2):** Generates a standalone Google Sheet specifically formatted for Quality Control (QC), categorizing matches into targeted review tabs (`Overlap`, `Human Review Needed`, `Duplicate Conflicts`, `Only Mapfacts`, `Only AI`, and `comparison_agent_input`).
3. **`Process QC File` (Phase 3):** Ingests the reviewed QC spreadsheet via URL, validates human edits, flags manual duplicate overrides, and updates final master tabs.

---

## 🛠️ Setup & Installation

1. Open your target Google Sheet containing the **`Mapfacts`** and **`AI`** data tabs.
2. Navigate to **Extensions** > **Apps Script**.
3. Replace any existing code with the provided `Code.gs` script and save.
4. Refresh your Google Sheet. A new custom menu titled **`Overlap Finder`** will appear in the toolbar.

---

## 🏗️ System Architecture & Technical Specifications

### 1. Mathematical Formulas

#### A. Spatial Distance (Haversine Formula)
Calculates great-circle distance in meters between two geographical coordinates:

$$d = 2R \arcsin\left(\sqrt{\sin^2\left(\frac{\Delta \phi}{2}\right) + \cos(\phi_1)\cos(\phi_2)\sin^2\left(\frac{\Delta \lambda}{2}\right)}\right)$$

* **Implementation:** `getHaversineDistance()`
* **Earth Radius ($R$):** $6,371,000\text{ meters}$

#### B. Address Token Similarity (Sørensen–Dice Coefficient)
Measures string similarity on sanitized lower-case word tokens:

$$\text{Score} = \frac{2 \times |T_1 \cap T_2|}{|T_1| + |T_2|}$$

* **Implementation:** `getTokenSimilarity()`
* **Score Range:** $0.0 \text{ to } 1.0$ (Converted to $0\% \text{ to } 100\%$)

---

### 2. Matching Decision Matrix

The `calculationFinalAssignedId` function assigns the target `store_code` based on spatial proximity ($d$) and address similarity ($S$):


```

```
                   ┌─────────────────────────┐
                   │   Distance & Score?     │
                   └────────────┬────────────┘
                                │
       ┌────────────────────────┼────────────────────────┐
       ▼                        ▼                        ▼
 d > 10,000m               d <= 50m                  d <= 500m

```

OR (d >= 2,000m              │                        │
& S < 40%)              ┌┴───────────┐           ┌┴───────────┐
│                   │  S < 20%?  │           │  S >= 40%? │
▼                   └─┬─────────┬┘           └─┬─────────┬┘
"No_Match_Found"              │         │              │         │
Yes  ▼      No ▼          Yes ▼      No ▼
"Human_Review_Needed"  geoId        geoId  "Human_Review_Needed"

```

* **Distance $> 500\text{m}$:** Assigned to `addressId` if $S \ge 50\%$; otherwise flags `"Human_Review_Needed"`.
* **Exact Alignment Lock:** If `geoId === addressId` (and non-null), accepts `geoId` immediately.

---

### 3. Deduplication & Conflict Handling

#### Phase 1: Smart Deduplication (`smartDeduplicateMapfacts`)
When multiple POIs point to the same AI `store_code`:
1. **Alignment Lock Check:** If both closest geographic ID (`nearest_ai_store_code`) AND best address match (`nearest_address_match_id`) resolve to the same code, it receives top priority.
2. **Composite Ranking:** Evaluated as:
   $$\text{Composite Rank} = \text{Address Score (\%)} - \frac{\text{Distance (m)}}{10}$$
3. **Resolution:** The top-ranked record claims the `store_code`. Contenders are tagged as:  
   `"Conflict: StoreCode <CODE> taken by POI <POI_FID>"`

#### Phase 3: QC Ingestion Safeguard (`processQcFileFromUrl`)
If human reviewers manually assign the same store code to multiple rows in the QC sheet:
* Codes appearing more than once are overwritten as:  
  `"QC Conflict: Duplicate Store Code <CODE>"`  
  and isolated in the **`Duplicate Conflicts`** tab for further review.

---

### 4. String Parsing & Clean Lookup Logic

During report generation (`writeToSpecificSheet`), metadata (`Name`, `address`, `Phone`, `Website`) must be looked up in the master dictionary (`aiLookupMap`). 

Because assignment strings may contain conflict metadata, `cleanLookupKey` extracts the underlying raw store ID:

```javascript
let rawCode = rowData["final_assigned_store_code"] || rowData["nearest_ai_store_code"];
let cleanLookupKey = "";

if (rawCode) {
  let strCode = String(rawCode).trim();
  
  // 1. Regex Match for System Conflicts
  let conflictMatch = strCode.match(/Conflict:\s*StoreCode\s+([^\s]+)\s+taken by POI/i);
  if (conflictMatch && conflictMatch[1]) {
    cleanLookupKey = conflictMatch[1];
    
  // 2. Generic Conflict Fallback
  } else if (strCode.startsWith("Conflict:")) {
    cleanLookupKey = String(rowData["nearest_ai_store_code"] || "").trim();
    
  // 3. QC Manual Overlap Conflicts
  } else if (strCode.startsWith("QC Conflict:")) {
    cleanLookupKey = strCode.replace(/^QC Conflict: Duplicate Store Code\s*/i, "").trim();
    
  // 4. Standard Store Code
  } else {
    cleanLookupKey = strCode;
  }
}

// Master Lookup Execution
let matchedAiRow = aiLookupMap[cleanLookupKey] || {};

```

#### Parsing Strategy Summary

| Input Pattern Example | Extraction Logic | Extracted `cleanLookupKey` |
| --- | --- | --- |
| `"ST_10023"` | Direct Assignment | `"ST_10023"` |
| `"Conflict: StoreCode ST_10023 taken by POI 88"` | Regex Extraction | `"ST_10023"` |
| `"QC Conflict: Duplicate Store Code ST_10023"` | Prefix Removal | `"ST_10023"` |
| `"Conflict: System Error"` | Fallback | `nearest_ai_store_code` |

---

## 📋 Tab & Output Specifications

* **`Overlap` / `Duplicate Conflicts`:** Combined sheets containing matched Mapfacts records merged alongside corresponding AI master metadata.
* **`Human Review Needed`:** Intermediate tab isolating ambiguous geographic/address matches for manual review.
* **`comparison_agent_input`:** Standardized 12-column normalized schema optimized for downstream machine processing and AI agents.
* **`Only Mapfacts` / `Only AI`:** Contains unmatched records isolated from either dataset.


