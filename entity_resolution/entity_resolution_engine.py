import re
import time
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

EARTH_RADIUS_M = 6371000.0

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
    """Pre-tokenizes and caches string metadata once to eliminate inner loop string processing."""
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
    """Converts spherical (Lat, Lng) into 3D Cartesian (X, Y, Z) vectors for fast spatial indexing."""
    lat_rad = np.radians(lat)
    lon_rad = np.radians(lon)
    x = EARTH_RADIUS_M * np.cos(lat_rad) * np.cos(lon_rad)
    y = EARTH_RADIUS_M * np.sin(lat_rad) * np.cos(lat_rad)
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
    if dist <= 50: return "Tier 1: Exceptional"
    if dist < 100: return "Tier 2: Strong"
    if dist < 200: return "Tier 3: Moderate"
    if dist < 300: return "Tier 4: Fair"
    if dist < 500: return "Tier 5: Low"
    if dist < 2000: return "Tier 6: Negligible"
    return "Out of Scope"

# -------------------------------------------------------------------------
# 4. Core Pipeline Engine
# -------------------------------------------------------------------------

def match_datasets(source_df, target_df, source_id_col, target_id_col, max_k=30):
    source_clean = source_df.copy()
    target_clean = target_df.copy()
    
    # Force coordinates to numeric float (Coerce invalid string inputs to NaN)
    source_clean['lat'] = pd.to_numeric(source_clean['lat'], errors='coerce')
    source_clean['lng'] = pd.to_numeric(source_clean['lng'], errors='coerce')
    target_clean['lat'] = pd.to_numeric(target_clean['lat'], errors='coerce')
    target_clean['lng'] = pd.to_numeric(target_clean['lng'], errors='coerce')
    
    # Drop rows missing valid coordinates
    source_clean = source_clean.dropna(subset=['lat', 'lng']).reset_index(drop=True)
    target_clean = target_clean.dropna(subset=['lat', 'lng']).reset_index(drop=True)
    
    # Convert coordinates to 3D spatial points
    target_coords = latlon_to_cartesian(target_clean['lat'].values, target_clean['lng'].values)
    source_coords = latlon_to_cartesian(source_clean['lat'].values, source_clean['lng'].values)
    
    # Build 3D spatial KD-Tree Index
    tree = cKDTree(target_coords)
    
    # Pre-tokenize all raw addresses
    target_addresses_raw = target_clean['address'].tolist()
    target_tokenized = pretokenize_addresses(target_addresses_raw)
    target_ids = target_clean[target_id_col].tolist()
    
    source_addresses_raw = source_clean['address'].tolist()
    source_tokenized = pretokenize_addresses(source_addresses_raw)
    
    k_neighbors = min(max_k, len(target_clean))
    results = []
    
    for idx, (s_idx, s_row) in enumerate(source_clean.iterrows()):
        s_coord = source_coords[idx]
        s_tok_info = source_tokenized[idx]
        
        # 1. Fetch exact K nearest neighbors via spatial tree index (~0.00005 seconds per point)
        distances_chord, nearby_indices = tree.query(s_coord, k=k_neighbors)
        
        if k_neighbors == 1:
            nearby_indices = [nearby_indices]
            
        min_dist = float('inf')
        closest_geo_id = None
        max_score = -1.0
        best_addr_id = None
        
        # 2. Evaluate candidate matches bounded strictly by K-nearest spatial neighbors
        for n_idx in nearby_indices:
            dist = haversine_distance_3d(s_coord, target_coords[n_idx])
            
            if dist < min_dist:
                min_dist = dist
                closest_geo_id = target_ids[n_idx]
            
            # Cached fast token similarity score check
            score = fast_token_similarity(s_tok_info, target_tokenized[n_idx])
            
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
        code = str(row.get('final_assigned_store_code', '')).strip()
        if not code or code in ["Human_Review_Needed", "No_Match_Found", "nan"]:
            continue
            
        dist = float(row.get('nearest_ai_dist_m', float('inf')))
        score_str = str(row.get('address_match_score', '0')).replace('%', '')
        score = float(score_str) if score_str != 'nan' else 0.0
        
        geo_id = str(row.get('nearest_ai_store_code', '')).strip()
        addr_id = str(row.get('nearest_address_match_id', '')).strip()
        
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
        code = str(row.get('final_assigned_store_code', '')).strip()
        if not code or code in ["Human_Review_Needed", "No_Match_Found", "nan"]:
            continue
        best = store_assignments[code]
        if best['index'] != idx:
            df.at[idx, 'final_assigned_store_code'] = f"Conflict: StoreCode {code} taken by POI {best['poiFid']}"
            
    return df

# -------------------------------------------------------------------------
# 5. Execution Entry Point
# -------------------------------------------------------------------------

if __name__ == "__main__":
    start_time = time.time()
    
    input_file = "input_data.xlsx"
    output_file = "QC_Report_Output.xlsx"
    
    print(f"Reading input sheets from '{input_file}'...")
    mapfacts_df = pd.read_excel(input_file, sheet_name="Mapfacts")
    ai_df = pd.read_excel(input_file, sheet_name="AI")

    print(f"Loaded {len(mapfacts_df)} Mapfacts rows and {len(ai_df)} AI rows.")
    print("Executing geospatial and pre-tokenized address matching...")
    
    mf_matched = match_datasets(mapfacts_df, ai_df, 'poi_fid', 'store_code', max_k=30)
    
    # Rename matching output headers to align with original Apps Script schema
    mf_matched.rename(columns={
        'closest_geo_id': 'nearest_ai_store_code',
        'min_distance': 'nearest_ai_dist_m',
        'best_address_id': 'nearest_address_match_id',
        'final_assigned_id': 'final_assigned_store_code'
    }, inplace=True)

    print("Deduplicating store assignments...")
    mf_matched = smart_deduplicate_mapfacts(mf_matched)

    print(f"Exporting results to '{output_file}'...")
    with pd.ExcelWriter(output_file, engine="openpyxl") as writer:
        mf_matched.to_excel(writer, sheet_name="mapfacts_with_ai_matches", index=False)
        ai_df.to_excel(writer, sheet_name="Original AI Data", index=False)
        mapfacts_df.to_excel(writer, sheet_name="Original Mapfacts Data", index=False)

    elapsed_time = time.time() - start_time
    print(f"Success! Process completed in {elapsed_time:.2f} seconds.")