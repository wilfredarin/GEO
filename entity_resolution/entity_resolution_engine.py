def run_full_pipeline(input_spreadsheet_id):
    print("=== STARTING PHASE 1: SPATIAL MATCHING ===")
    print(f"Loading raw data from source sheet: {input_spreadsheet_id}")
    mapfacts_df = read_sheet_by_name(input_spreadsheet_id, "Mapfacts")
    ai_df = read_sheet_by_name(input_spreadsheet_id, "AI")

    print(f"Loaded {len(mapfacts_df)} Mapfacts rows and {len(ai_df)} AI rows.")
    print("Executing 3D KD-Tree matching & address scoring...")
    
    mf_matched = match_datasets(mapfacts_df, ai_df, 'poi_fid', 'store_code', max_k=30)
    mf_matched.rename(columns={
        'closest_geo_id': 'nearest_ai_store_code',
        'min_distance': 'nearest_ai_dist_m',
        'best_address_id': 'nearest_address_match_id',
        'final_assigned_id': 'final_assigned_store_code'
    }, inplace=True)

    print("Resolving assignment conflicts...")
    mf_matched = smart_deduplicate_mapfacts(mf_matched)

    print("Creating output Google Spreadsheet...")
    output_spreadsheet_id = sheets.create_spreadsheet("QC_Report_Output")
    
    # Write base matching results
    write_sheet_by_name(output_spreadsheet_id, "mapfacts_with_ai_matches", mf_matched)
    write_sheet_by_name(output_spreadsheet_id, "Original AI Data", ai_df)
    write_sheet_by_name(output_spreadsheet_id, "Original Mapfacts Data", mapfacts_df)

    print(f"Phase 1 complete. Output Sheet ID: {output_spreadsheet_id}")

    print("\n=== STARTING PHASE 2: QC TAB GENERATION ===")
    generate_qc_report(mf_matched, ai_df, mapfacts_df, output_spreadsheet_id)

    sheet_url = f"https://docs.google.com/spreadsheets/d/{output_spreadsheet_id}"
    print(f"\n✨ Full pipeline completed successfully!")
    print(f"Your complete QC Google Sheet is ready: {sheet_url}")


if __name__ == "__main__":
    
    RAW_INPUT_SHEET_ID = ""
    run_full_pipeline(RAW_INPUT_SHEET_ID)