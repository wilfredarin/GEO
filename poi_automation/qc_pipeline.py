import math
import re
import pandas as pd

# ============================================================================
# 1. GOOGLE SHEETS HELPERS
# ============================================================================

def read_sheet_by_name(spreadsheet_id: str, worksheet_name: str) -> pd.DataFrame:
    """Reads a worksheet from a Google Sheet into a Pandas DataFrame."""
    worksheets = sheets.get_worksheets(spreadsheet_id)
    matching = worksheets[worksheets['Title'] == worksheet_name]
    if matching.empty:
        raise ValueError(f"Worksheet '{worksheet_name}' not found in spreadsheet {spreadsheet_id}")

    worksheet_id = matching['Worksheet Id'].iloc[0]
    return sheets.get_cells(spreadsheet_id, worksheet_id, has_col_header=True)


def write_sheet_by_name(spreadsheet_id: str, worksheet_name: str, df: pd.DataFrame):
    """Writes a Pandas DataFrame to a worksheet, creating it if it doesn't exist."""
    if df is None or df.empty:
        return

    worksheets = sheets.get_worksheets(spreadsheet_id)
    matching = worksheets[worksheets['Title'] == worksheet_name]

    if not matching.empty:
        worksheet_id = matching['Worksheet Id'].iloc[0]
    else:
        worksheet_id = sheets.add_worksheet(spreadsheet_id, worksheet_name)

    sheets.update_cells(spreadsheet_id, worksheet_id, df, include_col_header=True)


def extract_spreadsheet_id(url_or_id: str) -> str:
    """Extracts clean Spreadsheet ID if full URL is passed."""
    match = re.search(r"/d/([a-zA-Z0-9-_]+)", str(url_or_id))
    return match.group(1) if match else str(url_or_id).strip()


# ============================================================================
# 2. UTILITY VALIDATORS & GEOSPATIAL CALCULATIONS
# ============================================================================

def calculate_haversine(lat1, lng1, lat2, lng2):
    """Calculates distance between two coordinates in kilometers."""
    try:
        lat1, lng1, lat2, lng2 = map(float, [lat1, lng1, lat2, lng2])
    except (ValueError, TypeError):
        return float('nan')

    if any(math.isnan(x) for x in [lat1, lng1, lat2, lng2]):
        return float('nan')

    R = 6371.0  # Earth's radius in km
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def is_valid_ai_phone(phone_str):
    """Validates if proposed phone number contains 10 to 15 digits."""
    if not phone_str or pd.isna(phone_str):
        return True
    digits = re.sub(r'\D', '', str(phone_str))
    return 10 <= len(digits) <= 15


# ============================================================================
# 3. PHASE 1 ENGINE: INGESTION & TRIAGE PIPELINE
# ============================================================================

def run_phase1_ingestion_df(df_mapfacts: pd.DataFrame, df_comparison: pd.DataFrame) -> dict:
    """
    Executes Phase 1 triage logic over DataFrames.
    Returns a dictionary of DataFrames mapped to output tab names.
    """
    # Normalize column names to lower_case
    df_mapfacts.columns = [str(c).lower().strip() for c in df_mapfacts.columns]
    df_comparison.columns = [str(c).lower().strip() for c in df_comparison.columns]

    # Mapfacts lookup cache construction
    mapfacts_cache = {}
    for _, row in df_mapfacts.iterrows():
        fid = str(row.get('poi_fid', '')).strip()
        if fid:
            mapfacts_cache[fid] = {
                'address': str(row.get('address', '')),
                'phone': str(row.get('phone', '')),
                'website': str(row.get('website', '')),
                'hours': str(row.get('operating_hours', '')),
                'lat': row.get('lat'),
                'lng': row.get('lng'),
                'nbr_cnt': int(row.get('nbr_count', 0)) if pd.notna(row.get('nbr_count')) else 0
            }

    left_over = []
    human_review = []
    duplicates = []

    bugs_address = []
    bugs_phone = []
    bugs_hours = []
    bugs_website = []

    ids_in_comparison = set()

    for _, c_row in df_comparison.iterrows():
        c_fid = str(c_row.get('id', '')).strip()
        if not c_fid:
            continue

        ids_in_comparison.add(c_fid)

        c_ai_website = str(c_row.get('ai_website', '')) if pd.notna(c_row.get('ai_website')) else ""
        c_ai_address = str(c_row.get('ai_address', '')) if pd.notna(c_row.get('ai_address')) else ""
        c_ai_phone = str(c_row.get('ai_phone', '')) if pd.notna(c_row.get('ai_phone')) else ""
        c_ai_hours = str(c_row.get('ai_operatinghours', '')) if pd.notna(c_row.get('ai_operatinghours')) else ""

        try:
            c_ai_lat = float(c_row.get('ai_lat'))
            c_ai_lng = float(c_row.get('ai_lng'))
        except (ValueError, TypeError):
            c_ai_lat, c_ai_lng = float('nan'), float('nan')

        res_address = str(c_row.get('address_result', '')).lower().strip()
        res_phone = str(c_row.get('phone_result', '')).lower().strip()
        res_hours = str(c_row.get('hours_result', '')).lower().strip()
        res_website = str(c_row.get('website_result', '')).lower().strip()

        # Gate 1: AI Hallucination Check
        if c_fid not in mapfacts_cache:
            human_review.append({
                'ID': c_fid, 'Mapfacts_Address': '', 'AI_Address': c_ai_address,
                'Mapfacts_Phone': '', 'AI_Phone': c_ai_phone, 'AI_Website': c_ai_website,
                'Validation_Failure_Reason': 'AI Hallucinated ID', 'Calculated_Drift_KM': 0, 'QC_Action': 'Pending Review'
            })
            continue

        mf = mapfacts_cache[c_fid]

        # Gate 2: Proximity Match Review
        if mf['nbr_cnt'] > 0:
            duplicates.append({
                'ID': c_fid, 'Mapfacts_Address': mf['address'], 'AI_Address': c_ai_address,
                'Mapfacts_Website': mf['website'], 'AI_Website': c_ai_website,
                'nbr_cnt': mf['nbr_cnt'], 'QC_Status': 'Duplicate'
            })
            continue

        # Gate 3a: Empty AI Payload Data Verification
        if not c_ai_address or not c_ai_phone or not c_ai_website or not c_ai_hours:
            left_over.append({
                'ID': c_fid, 'Address': mf['address'], 'Website': mf['website'],
                'Phone': mf['phone'], 'operating_hours': mf['hours'],
                'Source_Status': 'Empty AI Payload', 'QC_Action': 'Pending Review',
                'QC_Discovered_Website': '', 'Resolution_Notes': ''
            })
            continue

        # Gate 3b: Missing Coordinate Integrity Scan
        if math.isnan(c_ai_lat) or math.isnan(c_ai_lng) or not c_ai_lat or not c_ai_lng:
            left_over.append({
                'ID': c_fid, 'Address': mf['address'], 'Website': mf['website'],
                'Phone': mf['phone'], 'operating_hours': mf['hours'],
                'Source_Status': 'Missing Coordinates', 'QC_Action': 'Pending Review',
                'QC_Discovered_Website': '', 'Resolution_Notes': ''
            })
            continue

        # Gate 4: Geospatial Displacement Check
        drift = calculate_haversine(mf['lat'], mf['lng'], c_ai_lat, c_ai_lng)
        if not math.isnan(drift) and drift > 1.0:
            human_review.append({
                'ID': c_fid, 'Mapfacts_Address': mf['address'], 'AI_Address': c_ai_address,
                'Mapfacts_Phone': mf['phone'], 'AI_Phone': c_ai_phone, 'AI_Website': c_ai_website,
                'Validation_Failure_Reason': 'Distance Drift > 1km', 'Calculated_Drift_KM': round(drift, 3), 'QC_Action': 'Pending Review'
            })
            continue

        # Gate 5: Proposed AI Phone Target Structure Validation
        if c_ai_phone and not is_valid_ai_phone(c_ai_phone):
            human_review.append({
                'ID': c_fid, 'Mapfacts_Address': mf['address'], 'AI_Address': c_ai_address,
                'Mapfacts_Phone': mf['phone'], 'AI_Phone': c_ai_phone, 'AI_Website': c_ai_website,
                'Validation_Failure_Reason': 'Invalid Proposed AI Phone', 'Calculated_Drift_KM': round(drift, 3) if not math.isnan(drift) else 0, 'QC_Action': 'Pending Review'
            })
            continue

        # Gate 6: Upstream Structural Mismatches
        if res_address == 'mismatch':
            bugs_address.append({'ID': c_fid, 'AI_Website': c_ai_website, 'Address': mf['address'], 'AI_Address': c_ai_address, 'raise_bug': False})
        if res_phone == 'mismatch':
            bugs_phone.append({'ID': c_fid, 'AI_Website': c_ai_website, 'Address': mf['address'], 'Mapfacts_Phone': mf['phone'], 'AI_Phone': c_ai_phone, 'raise_bug': False})
        if res_hours == 'mismatch':
            bugs_hours.append({'ID': c_fid, 'AI_Website': c_ai_website, 'Address': mf['address'], 'Mapfacts_Operating_Hours': mf['hours'], 'AI_Operating_Hours': c_ai_hours, 'raise_bug': False})
        if res_website == 'mismatch':
            bugs_website.append({'ID': c_fid, 'AI_Website': c_ai_website, 'Address': mf['address'], 'Mapfacts_Website': mf['website'], 'raise_bug': False})

    # Inverted Check: Find Mapfacts POIs missing from Scraper Output
    for _, mf_row in df_mapfacts.iterrows():
        check_fid = str(mf_row.get('poi_fid', '')).strip()
        if check_fid and check_fid not in ids_in_comparison:
            unassigned = mapfacts_cache.get(check_fid, {})
            left_over.append({
                'ID': check_fid, 'Address': unassigned.get('address', ''),
                'Website': unassigned.get('website', ''), 'Phone': unassigned.get('phone', ''),
                'operating_hours': unassigned.get('hours', ''), 'Source_Status': 'Missing from Scraper Output',
                'QC_Action': 'Pending Review', 'QC_Discovered_Website': '', 'Resolution_Notes': ''
            })

    # Manual Bug Tab default structure setup
    manual_bug_cols = ["ID", "Address", "Website", "Phone", "Operating_Hours", "AI_Address", "AI_Phone", "AI_Website", "AI_Operating_Hours", "Address_Result", "Phone_Result", "Website_Result", "Hours_Result"]

    return {
        "Left_Over": pd.DataFrame(left_over),
        "Human_Review": pd.DataFrame(human_review),
        "Duplicate_Review": pd.DataFrame(duplicates),
        "Bugs_Address": pd.DataFrame(bugs_address),
        "Bugs_Phone": pd.DataFrame(bugs_phone),
        "Bugs_Hours": pd.DataFrame(bugs_hours),
        "Bugs_Website": pd.DataFrame(bugs_website),
        "Manual_Bug_Tab": pd.DataFrame(columns=manual_bug_cols)
    }


# ============================================================================
# 4. PHASE 2 ENGINE: RECONCILIATION & SHIPPING
# ============================================================================

def run_phase2_reconciliation_df(df_snapshot: pd.DataFrame, df_comparison: pd.DataFrame, feedback_tabs: dict) -> dict:
    """
    Executes Phase 2 reconciliation logic over dataframes.
    """
    df_snapshot.columns = [str(c).lower().strip() for c in df_snapshot.columns]
    df_comparison.columns = [str(c).lower().strip() for c in df_comparison.columns]

    comp_agent_cache = {}
    for _, row in df_comparison.iterrows():
        cid = str(row.get('id', '')).strip()
        if cid:
            comp_agent_cache[cid] = {
                'ai_address': str(row.get('ai_address', '')) if pd.notna(row.get('ai_address')) else '',
                'ai_phone': str(row.get('ai_phone', '')) if pd.notna(row.get('ai_phone')) else '',
                'ai_website': str(row.get('ai_website', '')) if pd.notna(row.get('ai_website')) else '',
                'ai_hours': str(row.get('ai_operatinghours', '')) if pd.notna(row.get('ai_operatinghours')) else '',
                'res_address': str(row.get('address_result', '')).lower().strip(),
                'res_phone': str(row.get('phone_result', '')).lower().strip(),
                'res_website': str(row.get('website_result', '')).lower().strip(),
                'res_hours': str(row.get('hours_result', '')).lower().strip()
            }

    processed_ids = {}
    final_spam_duplicates = []
    re_run_queue = []

    base_address_overrides = {}
    base_phone_overrides = {}
    base_hours_overrides = {}
    base_website_overrides = {}

    evidence_source_tracker = {}
    update_source_tracker = {}

    # Process Drops & Drops Routing
    if "Left_Over" in feedback_tabs and not feedback_tabs["Left_Over"].empty:
        df_lo = feedback_tabs["Left_Over"]
        df_lo.columns = [str(c).lower().strip() for c in df_lo.columns]
        for _, row in df_lo.iterrows():
            lo_id = str(row.get('id', '')).strip()
            action = str(row.get('qc_action', '')).strip()
            if lo_id and action in ["Spam", "Duplicate", "Pending Review", "Can't Fix"]:
                processed_ids[lo_id] = "dropped"
                if action in ["Spam", "Duplicate"]:
                    final_spam_duplicates.append({'id': lo_id, 'original_mapfacts_address': row.get('address', ''), 'source_tab': 'Left_Over', 'classification': action})

    if "Duplicate_Review" in feedback_tabs and not feedback_tabs["Duplicate_Review"].empty:
        df_dup = feedback_tabs["Duplicate_Review"]
        df_dup.columns = [str(c).lower().strip() for c in df_dup.columns]
        for _, row in df_dup.iterrows():
            dup_id = str(row.get('id', '')).strip()
            status = str(row.get('qc_status', '')).strip()
            if dup_id:
                if status in ["Duplicate", "Spam", "Pending Review", "Can't Decide"]:
                    processed_ids[dup_id] = "dropped"
                    if status in ["Duplicate", "Spam"]:
                        final_spam_duplicates.append({'id': dup_id, 'original_mapfacts_address': row.get('mapfacts_address', ''), 'source_tab': 'Duplicate_Review', 'classification': status})
                elif status == "Not Duplicate":
                    processed_ids[dup_id] = "evaluate_mismatch"

    if "Human_Review" in feedback_tabs and not feedback_tabs["Human_Review"].empty:
        df_hr = feedback_tabs["Human_Review"]
        df_hr.columns = [str(c).lower().strip() for c in df_hr.columns]
        for _, row in df_hr.iterrows():
            hr_id = str(row.get('id', '')).strip()
            action = str(row.get('qc_action', '')).strip()
            if hr_id and processed_ids.get(hr_id) != "dropped":
                if action in ["Spam", "Duplicate", "Pending Review", "Can't Fix"]:
                    processed_ids[hr_id] = "dropped"
                    if action in ["Spam", "Duplicate"]:
                        final_spam_duplicates.append({'id': hr_id, 'original_mapfacts_address': row.get('mapfacts_address', ''), 'source_tab': 'Human_Review', 'classification': action})
                elif action == "Verified OK":
                    processed_ids[hr_id] = "evaluate_mismatch"

    # Digest sparse bug tabs
    def digest_bug_tab(df_tab, target_col, storage_obj):
        if df_tab is None or df_tab.empty:
            return
        df_tab.columns = [str(c).lower().strip() for c in df_tab.columns]
        for _, row in df_tab.iterrows():
            b_id = str(row.get('id', '')).strip()
            if not b_id or processed_ids.get(b_id) in ["dropped", "rerun"]:
                continue
            is_raised = str(row.get('raise_bug', '')).upper() in ['TRUE', '1']
            if is_raised:
                val = str(row.get(target_col, '')).strip()
                if val:
                    storage_obj[b_id] = val
                    evidence_source_tracker[b_id] = str(row.get('ai_website', '')).strip()
                    update_source_tracker[b_id] = "Automated_Scrape"

    digest_bug_tab(feedback_tabs.get("Bugs_Address"), "ai_address", base_address_overrides)
    digest_bug_tab(feedback_tabs.get("Bugs_Phone"), "ai_phone", base_phone_overrides)
    digest_bug_tab(feedback_tabs.get("Bugs_Hours"), "ai_operating_hours", base_hours_overrides)
    digest_bug_tab(feedback_tabs.get("Bugs_Website"), "ai_website", base_website_overrides)

    # Process Manual Bug Tab overrides
    if "Manual_Bug_Tab" in feedback_tabs and not feedback_tabs["Manual_Bug_Tab"].empty:
        df_mb = feedback_tabs["Manual_Bug_Tab"]
        df_mb.columns = [str(c).lower().strip() for c in df_mb.columns]
        for _, row in df_mb.iterrows():
            mb_id = str(row.get('id', '')).strip()
            if not mb_id or processed_ids.get(mb_id) == "dropped":
                continue

            current_ai_website = str(row.get('ai_website', '')).strip()
            evidence_source_tracker[mb_id] = current_ai_website
            update_source_tracker[mb_id] = "Human_Manual"

            if str(row.get('address_result', '')).lower().strip() == "mismatch" and row.get('ai_address'):
                base_address_overrides[mb_id] = str(row.get('ai_address')).strip()
            if str(row.get('phone_result', '')).lower().strip() == "mismatch" and row.get('ai_phone'):
                base_phone_overrides[mb_id] = str(row.get('ai_phone')).strip()
            if str(row.get('website_result', '')).lower().strip() == "mismatch" and row.get('ai_website'):
                base_website_overrides[mb_id] = str(row.get('ai_website')).strip()
            if str(row.get('hours_result', '')).lower().strip() == "mismatch" and row.get('ai_operating_hours'):
                base_hours_overrides[mb_id] = str(row.get('ai_operating_hours')).strip()

    # Resolve mismatches
    for key_id, state in list(processed_ids.items()):
        if state == "evaluate_mismatch":
            rec = comp_agent_cache.get(key_id)
            if rec:
                evidence_source_tracker[key_id] = rec['ai_website'] or "NA"
                update_source_tracker[key_id] = "Automated_Scrape_Resolved"
                if rec['res_address'] == 'mismatch' and key_id not in base_address_overrides:
                    base_address_overrides[key_id] = rec['ai_address']
                if rec['res_phone'] == 'mismatch' and key_id not in base_phone_overrides:
                    base_phone_overrides[key_id] = rec['ai_phone']
                if rec['res_website'] == 'mismatch' and key_id not in base_website_overrides:
                    base_website_overrides[key_id] = rec['ai_website']
                if rec['res_hours'] == 'mismatch' and key_id not in base_hours_overrides:
                    base_hours_overrides[key_id] = rec['ai_hours']

    # Compile output data matrices
    ship_to_gde = []
    golden_data = []

    for _, row in df_snapshot.iterrows():
        s_id = str(row.get('poi_fid', '')).strip()
        if not s_id or processed_ids.get(s_id) == "dropped":
            continue

        mf_addr = str(row.get('address', '')) if pd.notna(row.get('address')) else ''
        mf_phon = str(row.get('phone', '')) if pd.notna(row.get('phone')) else ''
        mf_webs = str(row.get('website', '')) if pd.notna(row.get('website')) else ''
        mf_hour = str(row.get('operating_hours', '')) if pd.notna(row.get('operating_hours')) else ''

        ai_addr = base_address_overrides.get(s_id, "")
        ai_phon = base_phone_overrides.get(s_id, "")
        ai_webs = base_website_overrides.get(s_id, "")
        ai_hour = base_hours_overrides.get(s_id, "")

        if any([ai_addr, ai_phon, ai_webs, ai_hour]):
            ship_to_gde.append({
                "id": s_id,
                "source_evidence": evidence_source_tracker.get(s_id) or ai_webs or mf_webs or "NA",
                "mapfacts_address": mf_addr, "proposed_address": ai_addr or "NA",
                "mapfacts_phone": mf_phon, "proposed_phone": ai_phon or "NA",
                "mapfacts_website": mf_webs, "proposed_website": ai_webs or "NA",
                "mapfacts_operating_hours": mf_hour, "proposed_operating_hours": ai_hour or "NA",
                "update_source": update_source_tracker.get(s_id, "Automated_Scrape"),
                "gde_verdict_phone_number_is_correct": "",
                "gde_verdict_business_hours_is_correct": "",
                "gde_verdict_website_is_correct": "",
                "gde_verdict_address_is_correct": ""
            })

        golden_data.append({
            "poi_fid": s_id,
            "mapfacts_address": mf_addr, "ai_address": ai_addr or mf_addr,
            "mapfacts_phone": mf_phon, "ai_phone": ai_phon or mf_phon,
            "mapfacts_website": mf_webs, "ai_website": ai_webs or mf_webs,
            "mapfacts_operating_hours": mf_hour, "ai_operating_hours": ai_hour or mf_hour
        })

    return {
        "ship_to_gde": pd.DataFrame(ship_to_gde),
        "Golden_Data": pd.DataFrame(golden_data),
        "Final_Spam_Duplicates": pd.DataFrame(final_spam_duplicates),
        "Re_Run_Agent": pd.DataFrame(re_run_queue, columns=["id", "ai_website", "target_attribute", "suggested_value"])
    }


# ============================================================================
# 5. PIPELINE EXECUTORS
# ============================================================================

def execute_phase_1(host_spreadsheet_id: str):
    """Executes Phase 1 Pipeline using native Colab Google Sheets helpers."""
    host_id = extract_spreadsheet_id(host_spreadsheet_id)
    
    # 1. Read Config tab to locate external Mapfacts Sheet
    df_config = read_sheet_by_name(host_id, "Config")
    
    ext_url, ext_tab = "", ""
    for _, row in df_config.iterrows():
        key = str(row.iloc[0]).lower().strip()
        val = str(row.iloc[1]).strip()
        if "url" in key or "sheet link" in key:
            ext_url = val
        if "tab name" in key:
            ext_tab = val

    if not ext_url or not ext_tab:
        raise ValueError("Could not locate 'Sheet Link' or 'Tab Name' in Config tab.")

    remote_id = extract_spreadsheet_id(ext_url)

    # 2. Ingest Remote Mapfacts and Local Agent Output
    df_mapfacts = read_sheet_by_name(remote_id, ext_tab)
    df_comparison = read_sheet_by_name(host_id, "Comparison_Agent_Output")

    # 3. Save snapshot locally in host spreadsheet
    write_sheet_by_name(host_id, "Mapfacts_Snapshot", df_mapfacts)

    # 4. Run Triage Engine
    triage_results = run_phase1_ingestion_df(df_mapfacts, df_comparison)

    # 5. Write back output tabs
    for tab_name, df_output in triage_results.items():
        write_sheet_by_name(host_id, tab_name, df_output)
        
    print("Phase 1 Triage successfully executed and written to Host Sheet!")


def execute_phase_2(qc_spreadsheet_id: str):
    """Executes Phase 2 Reconciliation Pipeline on Remote QC Workspace."""
    qc_id = extract_spreadsheet_id(qc_spreadsheet_id)

    # 1. Ingest Master Snapshot & Comparison Output
    df_snapshot = read_sheet_by_name(qc_id, "Mapfacts_Snapshot")
    df_comparison = read_sheet_by_name(qc_id, "Comparison_Agent_Output")

    # 2. Ingest Feedback Tabs
    feedback_tabs = {}
    target_tabs = [
        "Left_Over", "Human_Review", "Duplicate_Review",
        "Bugs_Address", "Bugs_Phone", "Bugs_Hours", "Bugs_Website", "Manual_Bug_Tab"
    ]

    for tab in target_tabs:
        try:
            feedback_tabs[tab] = read_sheet_by_name(qc_id, tab)
        except ValueError:
            feedback_tabs[tab] = pd.DataFrame()

    # 3. Run Reconciliation Engine
    recon_results = run_phase2_reconciliation_df(df_snapshot, df_comparison, feedback_tabs)

    # 4. Write back outputs to Remote QC Workspace
    for tab_name, df_output in recon_results.items():
        write_sheet_by_name(qc_id, tab_name, df_output)

    print("Phase 2 Reconciliation successfully executed and shipped to QC Workspace!")




HOST_SHEET_URL = "https://docs.google.com/spreadsheets/d/YOUR_HOST_SHEET_ID/edit"
# execute_phase_1(HOST_SHEET_URL)
QC_SHEET_URL = "https://docs.google.com/spreadsheets/d/YOUR_QC_WORKSPACE_SHEET_ID/edit"
# execute_phase_2(QC_SHEET_URL)