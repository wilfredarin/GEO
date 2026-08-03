import re
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree
from colabtools import sheets

EARTH_RADIUS_M = 6371000.0
INPUT_SPREADSHEET_ID = "1_GIk3-7GFvAsAC8qfaNZ3mqFPGoXeciGKphoMcINauY"

# -------------------------------------------------------------------------
# Helper Utilities
# -------------------------------------------------------------------------

def sanitize_phone(val):
    """
    Cleans phone numbers starting with '+' or affected by Google Sheets formula errors.
    Returns a clean string formatted safely for Google Sheets.
    """
    if pd.isna(val) or val is None:
        return ""
    
    s = str(val).strip()
    
    # Filter out Google Sheets formula errors caused by '+'
    if s.startswith("#") or s in ["nan", "None", "null", ""]:
        return ""
    
    # If the phone starts with '+', prefix with a single quote for Google Sheets plain text format
    if s.startswith("+"):
        return f"'{s}"
    
    return s

def clean_id(val):
    """Sanitizes IDs by stripping trailing '.0' and whitespace."""
    if pd.isna(val) or val is None:
        return ""
    s = str(val).strip()
    if s.startswith("#"):
        return ""
    if s.endswith(".0"):
        s = s[:-2]
    return s if s not in ["nan", "None", "null", ""] else ""

def extract_field_flexible(row_dict, candidate_keys, is_phone=False):
    """Case-insensitive search for fields across column variations with error handling."""
    if not isinstance(row_dict, dict):
        return ""
    
    normalized_dict = {str(k).strip().lower(): v for k, v in row_dict.items()}
    for key in candidate_keys:
        val = normalized_dict.get(key.lower())
        if pd.notna(val):
            val_str = str(val).strip()
            if val_str and not val_str.startswith("#") and val_str not in ["nan", "None"]:
                return sanitize_phone(val_str) if is_phone else val_str
    return ""

def sanitize_dataframe_for_sheets(df):
    """Formats DataFrame columns to prevent '+' leading characters from being parsed as formulas."""
    df_clean = df.copy()
    for col in df_clean.columns:
        if 'phone' in str(col).lower() or 'mobile' in str(col).lower() or 'contact' in str(col).lower():
            df_clean[col] = df_clean[col].apply(sanitize_phone)
    return df_clean

# -------------------------------------------------------------------------
# 1. Address Normalization & Pre-tokenization
# -------------------------------------------------------------------------

def normalize_address(text):
    if not text or pd.isna(text):
        return ""
    text = str(text).lower()
    text = re.sub(r'\bi[- ]?(\d+)\b', r'interstate \1', text)
    directionals = {
        r'\bn\b': 'north', r'\bs\b': 'south', r'\be\b': 'east', r'\bw\b': 'west',
        r'\bne\b': 'northeast', r'\bnw\b': 'northwest', r'\bse\b': 'southeast', r'\bsw\b': 'southwest'
    }
    for k, v in directionals.items():
        text = re.sub(k, v, text)
    streets = {
        r'\bst\b': 'street', r'\brd\b': 'road', r'\bave?\b': 'avenue',
        r'\bblvd\b': 'boulevard', r'\bpkwy\b': 'parkway', r'\bdr\b': 'drive',
        r'\bln\b': 'lane', r'\bhwy\b': 'highway', r'\b(united states|usa|us)\b': ''
    }
    for k, v in streets.items():
        text = re.sub(k, v, text)
    text = re.sub(r'[^a-z0-9\s]', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()

def pretokenize_addresses(address_list):
    tokenized = []
    for addr in address_list:
        norm = normalize_address(addr)
        tokens = [t for t in norm.split() if t]
        counts = {}
        for t in tokens:
            counts[t] = counts.get(t, 0) + 1
        tokenized.append((tokens, counts, len(tokens)))
    return tokenized

def fast_token_similarity(s_tok_info, t_tok_info):
    s_tokens, s_counts, s_len = s_tok_info
    t_tokens, t_counts, t_len = t_tok_info
    if s_len == 0 or t_len == 0:
        return 0.0
    intersect = 0
    counts_copy = s_counts.copy()
    for t in t_tokens:
        if counts_copy.get(t, 0) > 0:
            intersect += 1
            counts_copy[t] -= 1
    return (2.0 * intersect) / (s_len + t_len)

# -------------------------------------------------------------------------
# 2. Geospatial Mathematics
# -------------------------------------------------------------------------

def latlon_to_cartesian(lat, lon):
    lat_rad = np.radians(lat)
    lon_rad = np.radians(lon)
    x = EARTH_RADIUS_M * np.cos(lat_rad) * np.cos(lon_rad)
    y = EARTH_RADIUS_M * np.cos(lat_rad) * np.sin(lon_rad)
    z = EARTH_RADIUS_M * np.sin(lat_rad)
    return np.column_stack((x, y, z))

def haversine_distance_3d(p1, p2):
    chord_dist = np.linalg.norm(p1 - p2)
    return 2 * EARTH_RADIUS_M * np.arcsin(np.clip(chord_dist / (2 * EARTH_RADIUS_M), 0, 1))

# -------------------------------------------------------------------------
# 3. Matching Rules & Tiers
# -------------------------------------------------------------------------

def calculate_final_assigned_id(geo_id, address_id, distance, score_pct):
    if distance >= 2000 and score_pct < 40:
        return "No_Match_Found"
    if distance > 10000:
        return "No_Match_Found"
    if geo_id and clean_id(geo_id) == clean_id(address_id):
        return geo_id
    if distance <= 50:
        return "Human_Review_Needed" if score_pct < 30 else geo_id
    if distance <= 500:
        return geo_id if score_pct >= 40 else "Human_Review_Needed"
    if distance > 500:
        return address_id if (score_pct >= 50 and address_id is not None) else "Human_Review_Needed"
    return "Human_Review_Needed"

def get_distance_tier(dist):
    if dist <= 50:   return "Tier 1: Exceptional"
    if dist < 100:  return "Tier 2: Strong"
    if dist < 200:  return "Tier 3: Moderate"
    if dist < 300:  return "Tier 4: Fair"
    if dist < 500:  return "Tier 5: Low"
    if dist < 2000: return "Tier 6: Negligible"
    return "Out of Scope"

# -------------------------------------------------------------------------
# 4. Core Pipeline Engine
# -------------------------------------------------------------------------

def match_datasets(source_df, target_df, source_id_col, target_id_col, max_k=30):
    source_clean = source_df.copy()
    target_clean = target_df.copy()

    source_clean['lat'] = pd.to_numeric(source_clean['lat'], errors='coerce')
    source_clean['lng'] = pd.to_numeric(source_clean['lng'], errors='coerce')
    target_clean['lat'] = pd.to_numeric(target_clean['lat'], errors='coerce')
    target_clean['lng'] = pd.to_numeric(target_clean['lng'], errors='coerce')

    source_clean = source_clean.dropna(subset=['lat', 'lng']).reset_index(drop=True)
    target_clean = target_clean.dropna(subset=['lat', 'lng']).reset_index(drop=True)

    target_coords = latlon_to_cartesian(target_clean['lat'].values, target_clean['lng'].values)
    source_coords = latlon_to_cartesian(source_clean['lat'].values, source_clean['lng'].values)

    tree = cKDTree(target_coords)

    target_addresses_raw = target_clean['address'].tolist() if 'address' in target_clean.columns else []
    target_tokenized = pretokenize_addresses(target_addresses_raw)
    target_ids = [clean_id(x) for x in target_clean[target_id_col].tolist()]

    source_addresses_raw = source_clean['address'].tolist() if 'address' in source_clean.columns else []
    source_tokenized = pretokenize_addresses(source_addresses_raw)

    k_neighbors = min(max_k, len(target_clean))
    results = []

    for idx, (s_idx, s_row) in enumerate(source_clean.iterrows()):
        s_coord = source_coords[idx]
        s_tok_info = source_tokenized[idx]

        distances_chord, nearby_indices = tree.query(s_coord, k=k_neighbors)
        if k_neighbors == 1:
            nearby_indices = [nearby_indices]

        min_dist = float('inf')
        closest_geo_id = None
        max_score = -1.0
        best_addr_id = None

        for n_idx in nearby_indices:
            dist = haversine_distance_3d(s_coord, target_coords[n_idx])
            if dist < min_dist:
                min_dist = dist
                closest_geo_id = target_ids[n_idx]

            score = fast_token_similarity(s_tok_info, target_tokenized[n_idx]) if target_tokenized else 0.0
            if score > max_score:
                max_score = score
                best_addr_id = target_ids[n_idx]

        score_pct = (max_score if max_score != -1 else 0.0) * 100.0
        final_id = calculate_final_assigned_id(closest_geo_id, best_addr_id, min_dist, score_pct)

        res = s_row.to_dict()
        res['closest_geo_id'] = closest_geo_id
        res['min_distance'] = min_dist
        res['match_strength'] = get_distance_tier(min_dist)
        res['best_address_id'] = best_addr_id
        res['max_address_score_pct'] = score_pct
        res['address_match_score'] = f"{score_pct:.1f}%"
        res['final_assigned_id'] = final_id
        results.append(res)

    return pd.DataFrame(results)

def smart_deduplicate_mapfacts(df):
    store_assignments = {}
    for idx, row in df.iterrows():
        code = clean_id(row.get('final_assigned_store_code'))
        if not code or code in ["Human_Review_Needed", "No_Match_Found"]:
            continue

        try:
            dist = float(row.get('nearest_ai_dist_m', float('inf')))
        except (ValueError, TypeError):
            dist = float('inf')

        score_str = str(row.get('address_match_score', '0')).replace('%', '')
        try:
            score = float(score_str)
        except (ValueError, TypeError):
            score = 0.0

        geo_id = clean_id(row.get('nearest_ai_store_code'))
        addr_id = clean_id(row.get('nearest_address_match_id'))

        has_alignment_lock = (geo_id == code and addr_id == code)
        composite_rank = score - (dist / 10.0)

        if code not in store_assignments:
            store_assignments[code] = {
                'index': idx, 'hasAlignmentLock': has_alignment_lock,
                'compositeRank': composite_rank, 'poiFid': row.get('poi_fid', '')
            }
        else:
            curr = store_assignments[code]
            replace = False
            if has_alignment_lock and not curr['hasAlignmentLock']:
                replace = True
            elif not has_alignment_lock and curr['hasAlignmentLock']:
                replace = False
            elif composite_rank > curr['compositeRank']:
                replace = True

            if replace:
                store_assignments[code] = {
                    'index': idx, 'hasAlignmentLock': has_alignment_lock,
                    'compositeRank': composite_rank, 'poiFid': row.get('poi_fid', '')
                }

    for idx, row in df.iterrows():
        code = clean_id(row.get('final_assigned_store_code'))
        if not code or code in ["Human_Review_Needed", "No_Match_Found"]:
            continue
        best = store_assignments[code]
        if best['index'] != idx:
            df.at[idx, 'final_assigned_store_code'] = f"Conflict: StoreCode {code} taken by POI {best['poiFid']}"

    return df

# -------------------------------------------------------------------------
# 5. Sheet Read / Write Functions
# -------------------------------------------------------------------------

def read_sheet_by_name(spreadsheet_id: str, worksheet_name: str) -> pd.DataFrame:
    worksheets = sheets.get_worksheets(spreadsheet_id)
    matching = worksheets[worksheets['Title'] == worksheet_name]
    if matching.empty:
        raise ValueError(f"Worksheet '{worksheet_name}' not found in spreadsheet {spreadsheet_id}")
    worksheet_id = matching['Worksheet Id'].iloc[0]
    df = sheets.get_cells(spreadsheet_id, worksheet_id, has_col_header=True)
    df.columns = df.columns.str.strip()
    return df

def write_sheet_by_name(spreadsheet_id: str, worksheet_name: str, df: pd.DataFrame):
    worksheets = sheets.get_worksheets(spreadsheet_id)
    matching = worksheets[worksheets['Title'] == worksheet_name]
    if not matching.empty:
        worksheet_id = matching['Worksheet Id'].iloc[0]
    else:
        worksheet_id = sheets.add_worksheet(spreadsheet_id, worksheet_name)
    
    # Pre-sanitize DataFrame before pushing to Google Sheets
    clean_df = sanitize_dataframe_for_sheets(df)
    sheets.update_cells(spreadsheet_id, worksheet_id, clean_df, include_col_header=True)

# -------------------------------------------------------------------------
# 6. QC Report & Comparison Generation
# -------------------------------------------------------------------------

def generate_qc_report(mf_matched_df, ai_raw_df, output_spreadsheet_id):
    print("Generating QC Report & comparison_agent_input tab...")

    phone_keys = ['phone', 'phone_number', 'contact', 'telephone', 'mobile', 'Phone', 'Phone Number']
    website_keys = ['website', 'site', 'url', 'Website']
    hours_keys = ['operating_hours', 'opening_hours', 'hours', 'Operating Hours']

    ai_raw_df_clean = ai_raw_df.copy()
    ai_raw_df_clean['clean_store_code'] = ai_raw_df_clean['store_code'].apply(clean_id)
    ai_lookup = ai_raw_df_clean.set_index('clean_store_code').to_dict('index')

    overlap_rows = []
    conflict_rows = []
    human_review_rows = []
    only_mapfacts_rows = []
    seen_store_codes = set()

    for _, row in mf_matched_df.iterrows():
        code = clean_id(row.get('final_assigned_store_code'))
        row_dict = row.to_dict()

        if str(row.get('final_assigned_store_code', '')).startswith("Conflict:"):
            conflict_rows.append(row_dict)
        elif code == "Human_Review_Needed":
            human_review_rows.append(row_dict)
        elif code in ["No_Match_Found", ""]:
            only_mapfacts_rows.append(row_dict)
        else:
            overlap_rows.append(row_dict)
            seen_store_codes.add(code)

    only_ai_rows = []
    for _, ai_row in ai_raw_df.iterrows():
        ai_code = clean_id(ai_row.get('store_code'))
        if ai_code and ai_code not in seen_store_codes:
            only_ai_rows.append(ai_row.to_dict())

    comp_agent_rows = []
    for row in overlap_rows:
        matched_code = clean_id(row.get('final_assigned_store_code'))
        matched_ai = ai_lookup.get(matched_code, {})

        comp_agent_rows.append({
            "poi_fid": row.get("poi_fid", ""),
            "address": extract_field_flexible(row, ['address', 'Address']),
            "phone": extract_field_flexible(row, phone_keys, is_phone=True),
            "website": extract_field_flexible(row, website_keys),
            "operating_hours": extract_field_flexible(row, hours_keys),
            "lat": row.get("lat", ""),
            "lng": row.get("lng", ""),
            "ai_store_code": matched_ai.get("store_code", matched_code),
            "ai_address": extract_field_flexible(matched_ai, ['address', 'Address']),
            "ai_website": extract_field_flexible(matched_ai, website_keys),
            "ai_operating_hours": extract_field_flexible(matched_ai, hours_keys),
            "ai_phone": extract_field_flexible(matched_ai, phone_keys, is_phone=True)
        })

    comparison_agent_df = pd.DataFrame(comp_agent_rows)

    write_sheet_by_name(output_spreadsheet_id, "Overlap", pd.DataFrame(overlap_rows))
    write_sheet_by_name(output_spreadsheet_id, "Human Review Needed", pd.DataFrame(human_review_rows))
    write_sheet_by_name(output_spreadsheet_id, "Duplicate Conflicts", pd.DataFrame(conflict_rows))
    write_sheet_by_name(output_spreadsheet_id, "Only Mapfacts", pd.DataFrame(only_mapfacts_rows))
    write_sheet_by_name(output_spreadsheet_id, "Only AI", pd.DataFrame(only_ai_rows))
    write_sheet_by_name(output_spreadsheet_id, "comparison_agent_input", comparison_agent_df)

# -------------------------------------------------------------------------
# 7. Main Execution Pipeline
# -------------------------------------------------------------------------

def run_full_pipeline(input_spreadsheet_id):
    print("=== STARTING FULL PIPELINE ===")
    print(f"Ingesting datasets from: {input_spreadsheet_id}")
    mapfacts_df = read_sheet_by_name(input_spreadsheet_id, "Mapfacts")
    ai_df = read_sheet_by_name(input_spreadsheet_id, "AI")

    print(f"Loaded {len(mapfacts_df)} Mapfacts rows and {len(ai_df)} AI rows.")

    mf_matched = match_datasets(mapfacts_df, ai_df, 'poi_fid', 'store_code', max_k=30)
    mf_matched.rename(columns={
        'closest_geo_id': 'nearest_ai_store_code',
        'min_distance': 'nearest_ai_dist_m',
        'best_address_id': 'nearest_address_match_id',
        'final_assigned_id': 'final_assigned_store_code'
    }, inplace=True)

    mf_matched = smart_deduplicate_mapfacts(mf_matched)

    print("Creating output Google Spreadsheet...")
    output_spreadsheet_id = sheets.create_spreadsheet("QC_Report_Output")

    # Write raw copy sheets safely pre-sanitized
    write_sheet_by_name(output_spreadsheet_id, "mapfacts_with_ai_matches", mf_matched)
    write_sheet_by_name(output_spreadsheet_id, "Original AI Data", ai_df)
    write_sheet_by_name(output_spreadsheet_id, "Original Mapfacts Data", mapfacts_df)

    # Generate QC outputs
    generate_qc_report(mf_matched, ai_df, output_spreadsheet_id)

    sheet_url = f"https://docs.google.com/spreadsheets/d/{output_spreadsheet_id}"
    print(f"\nPipeline finished successfully!")
    print(f"Output Sheet: {sheet_url}")

if __name__ == "__main__":
    run_full_pipeline(INPUT_SPREADSHEET_ID)