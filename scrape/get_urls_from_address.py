import re
import time
import urllib.parse
import gspread
from google.oauth2.service_account import Credentials
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager

# ==========================================
# 1. CONFIGURATION
# ==========================================
SHEET_NAME = "Maps Matching Data"  # Name of your Google Sheet
INPUT_COL_ADDRESS = 1  # Column A: Address
INPUT_COL_KEYWORD = 2  # Column B: Target Keyword (e.g., Starbucks, Walmart)
OUTPUT_COL_URL = 3  # Column C: Extracted Google Maps URL
OUTPUT_COL_MATCH = 4  # Column D: Matched POI Name

# Google Sheets API Auth
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]
creds = Credentials.from_service_account_file("credentials.json", scopes=SCOPES)
client = gspread.authorize(creds)
sheet = client.open(SHEET_NAME).sheet1


# ==========================================
# 2. SELENIUM BROWSER SETUP
# ==========================================
def create_driver():
    chrome_options = Options()
    # Uncomment next line to run headless (without opening visible browser windows)
    # chrome_options.add_argument("--headless=new")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--disable-blink-features=AutomationControlled")
    chrome_options.add_argument(
        "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )

    service = Service(ChromeDriverManager().install())
    return webdriver.Chrome(service=service, options=chrome_options)


# ==========================================
# 3. SCRAPING & MATCHING LOGIC
# ==========================================
def search_and_extract(driver, address, keyword):
    """Searches Google Maps for an address, checks results for keyword,

    and returns the matching POI name and its full URL.
    """
    search_url = (
        f"https://www.google.com/maps/search/{urllib.parse.quote(address)}"
    )
    driver.get(search_url)

    wait = WebDriverWait(driver, 8)

    try:
        # Case A: Google Maps directly redirected to a single exact POI page
        time.sleep(2)  # Allow page JS and URL redirect to settle
        current_url = driver.current_url

        # Check if the title or page text matches the keyword
        page_title = driver.title.lower()
        if keyword.lower() in page_title:
            return driver.title, current_url

        # Case B: Google Maps shows a list of multiple candidate POIs on the left panel
        poi_elements = wait.until(
            EC.presence_of_all_elements_located(
                (By.CSS_SELECTOR, "a.hfGl2c, div.Nv2PK a")
            )
        )

        for element in poi_elements:
            aria_label = element.get_attribute("aria-label") or ""
            element_text = element.text or ""

            # Check if the target keyword is in the result name/label
            if (
                keyword.lower() in aria_label.lower()
                or keyword.lower() in element_text.lower()
            ):
                # Click the matching POI to load its detailed URL
                driver.execute_script("arguments[0].click();", element)
                time.sleep(2.5)  # Wait for URL to update with POI details
                return aria_label or element_text, driver.current_url

    except Exception as e:
        print(f"  [!] Error processing '{address}': {e}")

    return "No Match Found", ""


# ==========================================
# 4. MAIN EXECUTION LOOP
# ==========================================
def main():
    driver = create_driver()
    rows = sheet.get_all_values()

    print(f"Found {len(rows) - 1} rows to process.\n")

    # Iterate through rows (skipping header at row index 0)
    for index, row in enumerate(rows[1:], start=2):
        if len(row) < 2:
            continue

        address = row[0].strip()
        keyword = row[1].strip()

        # Skip if address or keyword is missing, or if already processed
        if not address or not keyword:
            continue
        if len(row) >= OUTPUT_COL_URL and row[OUTPUT_COL_URL - 1].strip():
            print(f"Row {index}: Already processed ({address}). Skipping.")
            continue

        print(
            f"Processing Row {index}: Address='{address}' | Keyword='{keyword}'"
        )

        matched_name, poi_url = search_and_extract(driver, address, keyword)

        # Update Google Sheet immediately for each processed row
        sheet.update_cell(index, OUTPUT_COL_URL, poi_url)
        sheet.update_cell(index, OUTPUT_COL_MATCH, matched_name)

        print(f"  -> Result: {matched_name}")
        print(f"  -> URL: {poi_url}\n")

        time.sleep(1)  

    driver.quit()
    print("Task completed successfully!")


if __name__ == "__main__":
    main()