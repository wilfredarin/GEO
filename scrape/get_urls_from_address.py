import os
import re
import time
import urllib.parse
from colabtools import sheets
import pandas as pd
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

# =====================================================================
# CONFIGURATION
# =====================================================================
INPUT_SPREADSHEET_ID = "YOUR_SPREADSHEET_ID_HERE"
WORKSHEET_NAME = "Sheet1"  # Change to your worksheet name

# Column names in your Google Sheet
COL_ADDRESS = "Address"
COL_KEYWORD = "Keyword"
COL_RESULT_URL = "Extracted_URL"
COL_RESULT_MATCH = "Matched_POI_Name"


# =====================================================================
# GOOGLE SHEETS HELPER FUNCTIONS
# =====================================================================
def read_sheet_by_name(
    spreadsheet_id: str, worksheet_name: str
) -> pd.DataFrame:
  """Reads a worksheet from a Google Sheet into a Pandas DataFrame."""
  worksheets = sheets.get_worksheets(spreadsheet_id)
  matching = worksheets[worksheets['Title'] == worksheet_name]
  if matching.empty:
    raise ValueError(
        f"Worksheet '{worksheet_name}' not found in spreadsheet"
        f" {spreadsheet_id}"
    )

  worksheet_id = matching['Worksheet Id'].iloc[0]
  return sheets.get_cells(spreadsheet_id, worksheet_id, has_col_header=True)


def write_sheet_by_name(
    spreadsheet_id: str, worksheet_name: str, df: pd.DataFrame
):
  """Writes a Pandas DataFrame to a worksheet, creating it if it doesn't exist."""
  worksheets = sheets.get_worksheets(spreadsheet_id)
  matching = worksheets[worksheets['Title'] == worksheet_name]

  if not matching.empty:
    worksheet_id = matching['Worksheet Id'].iloc[0]
  else:
    worksheet_id = sheets.add_worksheet(spreadsheet_id, worksheet_name)

  sheets.update_cells(spreadsheet_id, worksheet_id, df, include_col_header=True)


# =====================================================================
# COLAB SELENIUM DRIVER SETUP
# =====================================================================
def create_colab_driver():
  """Installs and configures a headless Chrome browser in Google Colab."""
  # Ensure chromium and driver dependencies exist in Colab environment
  os.system(
      'apt-get update && apt-get install -y chromium-chromedriver'
      ' chromium-browser > /dev/null 2>&1'
  )

  chrome_options = Options()
  chrome_options.add_argument('--headless')
  chrome_options.add_argument('--no-sandbox')
  chrome_options.add_argument('--disable-dev-shm-usage')
  chrome_options.add_argument('--disable-gpu')
  chrome_options.add_argument(
      'user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      ' (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  )

  service = Service('/usr/bin/chromedriver')
  return webdriver.Chrome(service=service, options=chrome_options)


# =====================================================================
# GOOGLE MAPS SCRAPING & MATCHING LOGIC
# =====================================================================
def search_and_extract(driver, address: str, keyword: str):
  """Searches Google Maps for an address, finds the matching POI, and returns its name and full URL."""
  search_url = (
      f'https://www.google.com/maps/search/{urllib.parse.quote(address)}'
  )
  driver.get(search_url)

  wait = WebDriverWait(driver, 6)

  try:
    time.sleep(2)  # Allow page JS and URL redirects to resolve
    current_url = driver.current_url

    # Case 1: Google Maps directly opened a single exact match page
    if keyword.lower() in driver.title.lower():
      return driver.title, current_url

    # Case 2: Google Maps returned a list of multiple candidate POIs on the left panel
    poi_elements = wait.until(
        EC.presence_of_all_elements_located(
            (By.CSS_SELECTOR, 'a.hfGl2c, div.Nv2PK a')
        )
    )

    for element in poi_elements:
      aria_label = element.get_attribute('aria-label') or ''
      element_text = element.text or ''

      # Check if target keyword matches the candidate POI title/label
      if (
          keyword.lower() in aria_label.lower()
          or keyword.lower() in element_text.lower()
      ):
        # Trigger JS click to open the POI detail panel and update the URL
        driver.execute_script('arguments[0].click();', element)
        time.sleep(2.5)  # Wait for URL to update with place details
        matched_title = aria_label or element_text
        return matched_title.strip(), driver.current_url

  except Exception as e:
    print(f"  [!] Error matching '{address}': {e}")

  return 'No Match Found', ''


# =====================================================================
# MAIN PIPELINE
# =====================================================================
def main():
  print('1. Fetching DataFrame from Google Sheet...')
  df = read_sheet_by_name(INPUT_SPREADSHEET_ID, WORKSHEET_NAME)

  # Ensure target output columns exist in DataFrame
  if COL_RESULT_URL not in df.columns:
    df[COL_RESULT_URL] = ''
  if COL_RESULT_MATCH not in df.columns:
    df[COL_RESULT_MATCH] = ''

  print('2. Initializing Headless Chrome in Colab...')
  driver = create_colab_driver()

  print(f'3. Processing {len(df)} rows...\n')

  try:
    for idx, row in df.iterrows():
      address = str(row.get(COL_ADDRESS, '')).strip()
      keyword = str(row.get(COL_KEYWORD, '')).strip()

      # Skip if address or keyword is missing
      if not address or not keyword or address.lower() == 'nan':
        continue

      # Skip if this row has already been processed
      if pd.notna(row.get(COL_RESULT_URL)) and str(
          row.get(COL_RESULT_URL)
      ).strip():
        print(f"Row {idx + 1}: Already completed. Skipping.")
        continue

      print(
          f"Processing Row {idx + 1}/{len(df)}: Address='{address}' |"
          f" Keyword='{keyword}'"
      )

      matched_name, poi_url = search_and_extract(driver, address, keyword)

      # Update Pandas DataFrame in memory
      df.at[idx, COL_RESULT_MATCH] = matched_name
      df.at[idx, COL_RESULT_URL] = poi_url

      print(f"  -> Matched: {matched_name}")
      print(f"  -> URL: {poi_url}\n")

  finally:
    driver.quit()

  print('4. Writing updated DataFrame back to Google Sheet...')
  write_sheet_by_name(INPUT_SPREADSHEET_ID, WORKSHEET_NAME, df)
  print('Done! Google Sheet successfully updated.')


# Execute
main()