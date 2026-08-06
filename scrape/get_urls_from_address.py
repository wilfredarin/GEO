import os
import re
import time
import urllib.parse
import pandas as pd
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from webdriver_manager.chrome import ChromeDriverManager

# ==========================================
# CONFIGURATION
# ==========================================
# Look for input and output inside the ../Data/ directory
INPUT_FILE_PATH = os.path.join("..", "DATA", "input_stores_map.xlsx")
OUTPUT_FILE_PATH = os.path.join("..", "DATA", "output_stores_map.csv")

# Column names in your input Excel file
COL_STORE_CODE = "store_code"
COL_ADDRESS = "address"
COL_KEYWORD = "keyword"  # Optional: e.g. "Starbucks", "Kroger", "Walmart"

# Row processing configuration (0-indexed)
# Set START_ROW = None to start from the beginning
# Set END_ROW = None to process until the last row
START_ROW = None  # e.g., 0 for row 1, 50 for row 51
END_ROW = None  # e.g., 100 to stop at row 100

SAVE_INTERVAL = 20  # Save to output.csv every 20 rows


# ==========================================
# SELENIUM DRIVER SETUP
# ==========================================
def create_driver():
  chrome_options = Options()
  # Uncomment the line below to run browser without UI
  # chrome_options.add_argument("--headless=new")
  chrome_options.add_argument("--no-sandbox")
  chrome_options.add_argument("--disable-dev-shm-usage")
  chrome_options.add_argument("--disable-blink-features=AutomationControlled")
  chrome_options.add_argument(
      "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      " (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  )

  service = Service(ChromeDriverManager().install())
  return webdriver.Chrome(service=service, options=chrome_options)


# ==========================================
# GOOGLE MAPS EXTRACTION LOGIC
# ==========================================
def extract_maps_url(driver, address, keyword=None):
  """Searches Google Maps for an address and returns the resulting POI URL,

  handling direct POI page opens, URL redirects, and list selection.
  """
  search_query = (
      f"{keyword} {address}".strip() if keyword else str(address).strip()
  )
  search_url = (
      f"https://www.google.com/maps/search/{urllib.parse.quote(search_query)}"
  )

  try:
    driver.get(search_url)
    wait = WebDriverWait(driver, 8)

    # 1. WAIT FOR URL REDIRECT (Up to 5 seconds)
    # Check repeatedly if Google Maps rewritten the URL to a specific POI (/maps/place/ or featuring a CID)
    for _ in range(10):
      current_url = driver.current_url
      if "/maps/place/" in current_url or "!1s" in current_url:
        return current_url
      time.sleep(0.5)

    # 2. CHECK IF A SINGLE POI PANEL IS ALREADY OPEN (Main Heading h1)
    # Sometimes the detail panel opens directly but the URL hasn't updated yet
    try:
      heading_element = driver.find_element(
          By.CSS_SELECTOR, "h1.DUwif, h1.fontHeadlineLarge"
      )
      heading_text = heading_element.text or ""

      if not keyword or keyword.lower() in heading_text.lower():
        # Give Google 1.5 extra seconds to finish updating the URL bar
        time.sleep(1.5)
        return driver.current_url
    except Exception:
      pass  # Heading not found, proceed to list check

    # 3. CASE: MULTIPLE CANDIDATE POIs IN SIDEBAR LIST
    poi_elements = wait.until(
        EC.presence_of_all_elements_located(
            (By.CSS_SELECTOR, "a.hfGl2c, div.Nv2PK a")
        )
    )

    if poi_elements:
      for elem in poi_elements:
        aria_label = elem.get_attribute("aria-label") or ""
        elem_text = elem.text or ""

        # Check if keyword matches
        if not keyword or (
            keyword.lower() in aria_label.lower()
            or keyword.lower() in elem_text.lower()
        ):
          driver.execute_script("arguments[0].click();", elem)

          # Wait for click to update the URL to /maps/place/
          for _ in range(10):
            time.sleep(0.5)
            if "/maps/place/" in driver.current_url:
              return driver.current_url

          return driver.current_url

      # Fallback: Click first POI in list if no explicit keyword match was found
      driver.execute_script("arguments[0].click();", poi_elements[0])
      time.sleep(2.5)
      return driver.current_url

  except Exception as e:
    print(f"  [!] Extraction error for query '{search_query}': {e}")

  return "No Match Found"


# ==========================================
# HELPER FOR SAVING TO CSV
# ==========================================
def save_output(df):
  """Saves the output DataFrame to ../Data/output.csv."""
  output_dir = os.path.dirname(OUTPUT_FILE_PATH)
  if output_dir:
    os.makedirs(output_dir, exist_ok=True)

  df.to_csv(OUTPUT_FILE_PATH, index=False)
  print(f"\n[✓] Progress saved to {OUTPUT_FILE_PATH}\n")


# ==========================================
# MAIN EXECUTION PIPELINE
# ==========================================
def main():
  if not os.path.exists(INPUT_FILE_PATH):
    raise FileNotFoundError(
        f"Input file '{INPUT_FILE_PATH}' not found. Please ensure it exists"
        " inside the '../Data' folder."
    )

  print(f"Reading input file: {INPUT_FILE_PATH}")
  input_df = pd.read_excel(INPUT_FILE_PATH)

  # Check if output CSV already exists to resume from past work
  if os.path.exists(OUTPUT_FILE_PATH):
    output_df = pd.read_csv(OUTPUT_FILE_PATH)
    print(
        f"Found existing {OUTPUT_FILE_PATH} with {len(output_df)} records."
        " Resuming..."
    )
  else:
    output_df = pd.DataFrame(columns=["store_code", "url"])

  # Configure start and end boundaries
  start_idx = START_ROW if START_ROW is not None else 0
  end_idx = END_ROW if END_ROW is not None else len(input_df)

  # Ensure boundaries stay within valid index ranges
  start_idx = max(0, start_idx)
  end_idx = min(len(input_df), end_idx)

  print(
      f"Processing rows from index {start_idx} to {end_idx} (Total:"
      f" {end_idx - start_idx} rows)...\n"
  )

  driver = create_driver()
  processed_count = 0

  try:
    for idx in range(start_idx, end_idx):
      row = input_df.iloc[idx]
      store_code = row.get(COL_STORE_CODE, "")
      address = row.get(COL_ADDRESS, "")
      keyword = (
          row.get(COL_KEYWORD, None) if COL_KEYWORD in input_df.columns else None
      )

      # Check if this store_code has already been processed in output_df
      if store_code in output_df["store_code"].values:
        print(
            f"Row {idx + 1}/{len(input_df)} [Store: {store_code}]: Already"
            " processed. Skipping."
        )
        continue

      print(
          f"Processing Row {idx + 1}/{len(input_df)} | Store Code:"
          f" {store_code}"
      )

      poi_url = extract_maps_url(driver, address, keyword)
      pattern = r'0x[0-9a-fA-F]+0x:[0-9a-fA-F]+'
      featureids = re.findall(pattern, poi_url)
      # Append result row to output DataFrame
      new_row = pd.DataFrame([{"store_code": store_code, "url": poi_url, "featureids": featureids}])
      output_df = pd.concat([output_df, new_row], ignore_index=True)

      print(f"  -> Extracted URL: {poi_url}")

      processed_count += 1

      # Save to CSV every SAVE_INTERVAL rows
      if processed_count % SAVE_INTERVAL == 0:
        save_output(output_df)

  except KeyboardInterrupt:
    print("\nProcess interrupted manually by user.")
  finally:
    driver.quit()
    # Save any remaining unsaved progress on finish or exit
    save_output(output_df)
    print("Execution completed.")


if __name__ == "__main__":
  main()