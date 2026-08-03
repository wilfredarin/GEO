import re
import time
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree
from colabtools import sheets

EARTH_RADIUS_M = 6371000.0
INPUT_SPREADSHEET_ID = "1_GIk3-7GFvAsAC8qfaNZ3mqFPGoXeciGKphoMcINauY"

# -------------------------------------------------------------------------
# 1. Address Normalization & Pre-tokenization
# -------------------------------------------------------------------------

def normalize_address(text):
    """Cleans and standardizes common street address patterns."""
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
    """Pre-tokenizes and caches string metadata once to eliminate inner loop processing."""
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
    """Sørensen–Dice similarity calculated on pre-tokenized structure."""
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
    """Converts spherical (Lat, Lng) into 3D Cartesian (X, Y, Z) vectors for spatial indexing."""
    lat_rad = np.radians(lat)
    lon_rad = np.radians(lon)
    x = EARTH_RADIUS_M * np.cos(lat_rad) * np.cos(lon_rad)
    y = EARTH_RADIUS_M * np.cos(lat_rad) * np.sin(lon_rad)
    z = EARTH_RADIUS_M * np.sin(lat_rad)
    return np.column_stack((x, y, z))


def haversine_distance_3d(p1, p2):
    """Computes exact surface distance in meters using 3D spatial points."""
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
    if geo_id is not None and str(geo_id).strip() == str(address_id).strip():
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

    # Normalize coordinate inputs
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
    target_ids = target_clean[target_id_col].tolist()

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
    """Resolves duplicate store code claims by selecting highest composite rank score."""
    store_assignments = {}

    for idx, row in df.iterrows():
        code = str(row.get('final_assigned_store_code', '')).replace('.0', '').strip()
        if not code or code in ["Human_Review_Needed", "No_Match_Found", "nan", "None"]:
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

        geo_id = str(row.get('nearest_ai_store_code', '')).replace('.0', '').strip()
        addr_id = str(row.get('nearest_address_match_id', '')).replace('.0', '').strip()

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
        code = str(row.get('final_assigned_store_code', '')).replace('.0', '').strip()
        if not code or code in ["Human_Review_Needed", "No_Match_Found", "nan", "None"]:
            continue
        best = store_assignments[code]
        if best['index'] != idx:
            df.at[idx, 'final_assigned_store_code'] = f"Conflict: StoreCode {code} taken by POI {best['poiFid']}"

    return df

# -------------------------------------------------------------------------
# 5. Sheet Read / Write Functions
# -------------------------------------------------------------------------

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
    worksheets = sheets.get_worksheets(spreadsheet_id)
    matching = worksheets[worksheets['Title'] == worksheet_name]

    if not matching.empty:
        worksheet_id = matching['Worksheet Id'].iloc[0]
    else:
        worksheet_id = sheets.add_worksheet(spreadsheet_id, worksheet_name)

    sheets.update_cells(spreadsheet_id, worksheet_id, df, include_col_header=True)

# -------------------------------------------------------------------------
# 6. QC Segregation & Tab Generation Logic
# -------------------------------------------------------------------------

def generate_qc_report(mf_matched_df, ai_raw_df, mapfacts_raw_df, output_filepath):
    print("Segregating QC tabs (Overlap, Conflict, Human Review, Unmatched)...")

    # Helper function to flexibly extract telephone values across potential key variations
    def extract_field(d, candidate_keys):
        for key in candidate_keys:
            for k in d.keys():
                if str(k).strip().lower() == key.lower():
                    val = d[k]
                    if pd.notna(val) and str(val).strip() not in ["", "nan", "None"]:
                        return str(val).strip()
        return ""

    phone_keys = ['phone', 'phone_number', 'contact', 'telephone', 'mobile']
    website_keys = ['website', 'site', 'url']
    hours_keys = ['operating_hours', 'opening_hours', 'hours']

    # Pre-build AI lookup map with sanitized store codes
    ai_raw_df_clean = ai_raw_df.copy()
    ai_raw_df_clean['clean_store_code'] = (
        ai_raw_df_clean['store_code']
        .astype(str)
        .str.replace(r'\.0$', '', regex=True)
        .str.strip()
    )
    ai_lookup = ai_raw_df_clean.set_index('clean_store_code').to_dict('index')

    overlap_rows = []
    conflict_rows = []
    human_review_rows = []
    only_mapfacts_rows = []
    seen_store_codes = set()

    # 1. Bucket Mapfacts records based on final assignment status
    for _, row in mf_matched_df.iterrows():
        code = str(row.get('final_assigned_store_code', '')).replace('.0', '').strip()
        row_dict = row.to_dict()

        if code.startswith("Conflict:"):
            conflict_rows.append(row_dict)
        elif code == "Human_Review_Needed":
            human_review_rows.append(row_dict)
        elif code in ["No_Match_Found", "", "nan", "None"]:
            only_mapfacts_rows.append(row_dict)
        else:
            overlap_rows.append(row_dict)
            seen_store_codes.add(code)

    # 2. Identify AI stores not matched to any Mapfacts POI
    only_ai_rows = []
    for _, ai_row in ai_raw_df.iterrows():
        ai_code = str(ai_row.get('store_code', '')).replace('.0', '').strip()
        if ai_code and ai_code not in seen_store_codes and ai_code not in ["nan", "None"]:
            only_ai_rows.append(ai_row.to_dict())

    overlap_df = pd.DataFrame(overlap_rows)
    conflict_df = pd.DataFrame(conflict_rows)
    human_review_df = pd.DataFrame(human_review_rows)
    only_mapfacts_df = pd.DataFrame(only_mapfacts_rows)
    only_ai_df = pd.DataFrame(only_ai_rows)

    # 3. Generate comparison_agent_input side-by-side view
    print("Generating 'comparison_agent_input' tab...")
    comp_agent_rows = []
    for row in overlap_rows:
        matched_code = str(row.get('final_assigned_store_code', '')).replace('.0', '').strip()
        matched_ai = ai_lookup.get(matched_code, {})

        comp_agent_rows.append({
            "poi_fid": row.get("poi_fid", ""),
            "address": row.get("address", ""),
            "phone": extract_field(row, phone_keys),
            "website": extract_field(row, website_keys),
            "operating_hours": extract_field(row, hours_keys),
            "lat": row.get("lat", ""),
            "lng": row.get("lng", ""),
            "ai_store_code": matched_ai.get("store_code", ""),
            "ai_address": matched_ai.get("address", ""),
            "ai_website": extract_field(matched_ai, website_keys),
            "ai_operating_hours": extract_field(matched_ai, hours_keys),
            "ai_phone": extract_field(matched_ai, phone_keys)
        })

    comparison_agent_df = pd.DataFrame(comp_agent_rows)

    # 4. Write all structured sheets into final Google Spreadsheet
    print(f"Writing sheets into output spreadsheet ID '{output_filepath}'...")
    write_sheet_by_name(output_filepath, "Overlap", overlap_df)
    write_sheet_by_name(output_filepath, "Human Review Needed", human_review_df)
    write_sheet_by_name(output_filepath, "Duplicate Conflicts", conflict_df)
    write_sheet_by_name(output_filepath, "Only Mapfacts", only_mapfacts_df)
    write_sheet_by_name(output_filepath, "Only AI", only_ai_df)
    write_sheet_by_name(output_filepath, "comparison_agent_input", comparison_agent_df)

# -------------------------------------------------------------------------
# 7. End-to-End Runtime Pipeline
# -------------------------------------------------------------------------

def run_full_pipeline(input_spreadsheet_id):
    print("=== STARTING PHASE 1: SPATIAL MATCHING & DEDUPLICATION ===")
    print(f"Reading raw datasets from input sheet: {input_spreadsheet_id}")
    mapfacts_df = read_sheet_by_name(input_spreadsheet_id, "Mapfacts")
    ai_df = read_sheet_by_name(input_spreadsheet_id, "AI")

    print(f"Loaded {len(mapfacts_df)} Mapfacts POIs and {len(ai_df)} AI Store records.")
    print("Performing 3D KD-Tree spatial indexing and address scoring...")

    mf_matched = match_datasets(mapfacts_df, ai_df, 'poi_fid', 'store_code', max_k=30)
    mf_matched.rename(columns={
        'closest_geo_id': 'nearest_ai_store_code',
        'min_distance': 'nearest_ai_dist_m',
        'best_address_id': 'nearest_address_match_id',
        'final_assigned_id': 'final_assigned_store_code'
    }, inplace=True)

    print("Resolving duplicate store assignments...")
    mf_matched = smart_deduplicate_mapfacts(mf_matched)

    print("Creating new Google Spreadsheet for QC Output...")
    output_spreadsheet_id = sheets.create_spreadsheet("QC_Report_Output")

    write_sheet_by_name(output_spreadsheet_id, "mapfacts_with_ai_matches", mf_matched)
    write_sheet_by_name(output_spreadsheet_id, "Original AI Data", ai_df)
    write_sheet_by_name(output_spreadsheet_id, "Original Mapfacts Data", mapfacts_df)

    print(f"Phase 1 Complete. Base output ID: {output_spreadsheet_id}")

    print("\n=== STARTING PHASE 2: QC REPORT & AGENT VIEW GENERATION ===")
    generate_qc_report(mf_matched, ai_df, mapfacts_df, output_spreadsheet_id)

    sheet_url = f"https://docs.google.com/spreadsheets/d/{output_spreadsheet_id}"
    print(f"\nPipeline finished successfully!")
    print(f"Output QC Spreadsheet: {sheet_url}")


if __name__ == "__main__":
    # Execute full pipeline end-to-end
    run_full_pipeline(INPUT_SPREADSHEET_ID)