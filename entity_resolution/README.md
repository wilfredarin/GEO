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