import re
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree
from rapidfuzz import fuzz

EARTH_RADIUS_M = 6371000.0

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

def get_token_similarity(str1, str2):
    s1_norm = normalize_address(str1)
    s2_norm = normalize_address(str2)
    if not s1_norm or not s2_norm:
        return 0.0
    
    t1 = [t for t in s1_norm.split() if t]
    t2 = [t for t in s2_norm.split() if t]
    if not t1 or not t2:
        return 0.0
    
    counts = {}
    for t in t1:
        counts[t] = counts.get(t, 0) + 1
    
    intersect = 0
    for t in t2:
        if counts.get(t, 0) > 0:
            intersect += 1
            counts[t] -= 1
            
    return (2.0 * intersect) / (len(t1) + len(t2))

def latlon_to_cartesian(lat, lon):
    lat_rad = np.radians(lat)
    lon_rad = np.radians(lon)
    x = EARTH_RADIUS_M * np.cos(lat_rad) * np.cos(lon_rad)
    y = EARTH_RADIUS_M * np.cos(lat_rad) * np.sin(lon_rad)
    z = EARTH_RADIUS_M * np.sin(lat_rad)
    return np.column_stack((x, y, z))

def haversine_distance_3d(p1, p2):
    """Calculates chord distance converted to arc length along Earth's sphere."""
    chord_dist = np.linalg.norm(p1 - p2)
    return 2 * EARTH_RADIUS_M * np.arcsin(np.clip(chord_dist / (2 * EARTH_RADIUS_M), 0, 1))

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

def get_address_match_strength(score_pct):
    if score_pct >= 75: return "Tier 1: Exceptional"
    if score_pct >= 60: return "Tier 2: Strong"
    if score_pct >= 50: return "Tier 3: Moderate"
    if score_pct >= 40: return "Tier 4: Fair"
    if score_pct >= 30: return "Tier 5: Low"
    return "Tier 6: Negligible"

def match_datasets(source_df, target_df, source_id_col, target_id_col):
    source_clean = source_df.copy()
    target_clean = target_df.copy()
    
    # 1. Force conversion of lat and lng to float (invalid/string values become NaN)
    source_clean['lat'] = pd.to_numeric(source_clean['lat'], errors='coerce')
    source_clean['lng'] = pd.to_numeric(source_clean['lng'], errors='coerce')
    target_clean['lat'] = pd.to_numeric(target_clean['lat'], errors='coerce')
    target_clean['lng'] = pd.to_numeric(target_clean['lng'], errors='coerce')
    
    # # 2. Drop rows where coordinates are NaN or missing
    # source_clean = source_clean.dropna(subset=['lat', 'lng']).reset_index(drop=True)
    # target_clean = target_clean.dropna(subset=['lat', 'lng']).reset_index(drop=True)
    
    # 3. Convert clean float values to Cartesian coordinates
    target_coords = latlon_to_cartesian(target_clean['lat'].values, target_clean['lng'].values)
    source_coords = latlon_to_cartesian(source_clean['lat'].values, source_clean['lng'].values)
    
    tree = cKDTree(target_coords)
    
    # Radius query ~10,000m (chord length approximation)
    max_radius = 2 * EARTH_RADIUS_M * np.sin(10000 / (2 * EARTH_RADIUS_M))
    
    results = []
    
    target_addresses = target_clean['address'].tolist()
    target_ids = target_clean[target_id_col].tolist()
    
    for idx, (s_idx, s_row) in enumerate(source_clean.iterrows()):
        s_coord = source_coords[idx]
        s_addr = s_row.get('address', '')
        
        # Spatial search (nearest points within 10km)
        nearby_indices = tree.query_ball_point(s_coord, r=max_radius)
        
        min_dist = float('inf')
        closest_geo_id = None
        
        if nearby_indices:
            for n_idx in nearby_indices:
                dist = haversine_distance_3d(s_coord, target_coords[n_idx])
                if dist < min_dist:
                    min_dist = dist
                    closest_geo_id = target_ids[n_idx]
        else:
            # Fallback to absolute nearest if none within 10km radius
            dist_val, n_idx = tree.query(s_coord, k=1)
            min_dist = haversine_distance_3d(s_coord, target_coords[n_idx])
            closest_geo_id = target_ids[n_idx]

        # Address similarity across target set
        max_score = -1.0
        best_addr_id = None
        
        for t_idx, t_addr in enumerate(target_addresses):
            score = get_token_similarity(s_addr, t_addr)
            if score > max_score:
                max_score = score
                best_addr_id = target_ids[t_idx]
                
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
        
        if code not in storeAssignments:
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


if __name__ == "__main__":
    print("Loading data...")
    mapfacts_df = pd.read_excel("input_data.xlsx", sheet_name="Mapfacts")
    ai_df = pd.read_excel("input_data.xlsx", sheet_name="AI")

    print("Matching Mapfacts -> AI...")
    mf_matched = match_datasets(mapfacts_df, ai_df, 'poi_fid', 'store_code')
    mf_matched.rename(columns={
        'closest_geo_id': 'nearest_ai_store_code',
        'min_distance': 'nearest_ai_dist_m',
        'best_address_id': 'nearest_address_match_id',
        'final_assigned_id': 'final_assigned_store_code'
    }, inplace=True)

    mf_matched = smart_deduplicate_mapfacts(mf_matched)

    print("Generating Excel QC File...")
    with pd.ExcelWriter("QC_Report_Output.xlsx", engine="openpyxl") as writer:
        mf_matched.to_excel(writer, sheet_name="mapfacts_with_ai_matches", index=False)
        ai_df.to_excel(writer, sheet_name="Original AI Data", index=False)
        mapfacts_df.to_excel(writer, sheet_name="Original Mapfacts Data", index=False)
    print("Processing completed successfully!")