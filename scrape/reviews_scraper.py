import csv
import os
import time
from urllib.parse import parse_qs, urlparse
import pandas as pd
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


def search_google_map_new(driver, url, max_reviews=10):
  """Scrapes up to max_reviews from a single Google Maps place URL."""
  try:
    if not isinstance(url, str) or not url.startswith("http"):
      return "Invalid URL"

    parsed_url = urlparse(url)
    params = parse_qs(parsed_url.query)
    if params.get("rcount", [None])[0] == "0":
      return "No Reviews"

    driver.get(url)
    wait = WebDriverWait(driver, 10)

    # Click Reviews tab
    try:
      rev_tab_xpath = (
          "//button[contains(@aria-label, 'Reviews for')] |"
          " //button[contains(@data-item-id, 'review')] | //div[contains(text(),"
          " 'Reviews')]"
      )
      wait.until(
          EC.element_to_be_clickable((By.XPATH, rev_tab_xpath))
      ).click()
      time.sleep(1.5)
    except Exception:
      pass

    # Click Sort -> Newest
    try:
      wait.until(
          EC.element_to_be_clickable(
              (By.XPATH, "//button[contains(@aria-label, 'Sort reviews')]")
          )
      ).click()
      time.sleep(1)
      wait.until(
          EC.element_to_be_clickable(
              (By.XPATH, "//div[@role='menuitem' and @data-index='1']")
          )
      ).click()
      time.sleep(2)
    except Exception:
      pass

    # Find scroll pane
    try:
      scrollable_xpath = (
          "//div[@role='main']//div[contains(@class, 'm6QErb') and"
          " @tabindex='-1']"
      )
      scroll_pane = wait.until(
          EC.presence_of_element_located((By.XPATH, scrollable_xpath))
      )
    except Exception:
      return "Not Found/Error"

    reviews, seen, scroll_attempts = [], set(), 0

    while len(reviews) < max_reviews and scroll_attempts < 8:
      # Expand "More"
      for btn in driver.find_elements(
          By.XPATH,
          "//button[contains(@aria-label, 'More') or contains(@class,"
          " 'w8nwRe')]",
      ):
        try:
          driver.execute_script("arguments[0].click();", btn)
        except Exception:
          pass

      review_spans = driver.find_elements(By.CSS_SELECTOR, ".jftiEf .wiI7pd")
      initial_count = len(reviews)

      for span in review_spans:
        txt = span.text.strip()
        if txt and txt not in seen:
          seen.add(txt)
          reviews.append(txt)
        if len(reviews) >= max_reviews:
          break

      if len(reviews) >= max_reviews:
        break

      # Scroll pane
      last_h = driver.execute_script(
          "return arguments[0].scrollHeight", scroll_pane
      )
      driver.execute_script(
          "arguments[0].scrollTop = arguments[0].scrollHeight;", scroll_pane
      )
      time.sleep(2)

      if (
          driver.execute_script("return arguments[0].scrollHeight", scroll_pane)
          == last_h
      ):
        try:
          scroll_pane.click()
          scroll_pane.send_keys(Keys.PAGE_DOWN)
          time.sleep(1.5)
        except Exception:
          pass

      scroll_attempts = (
          scroll_attempts + 1 if len(reviews) == initial_count else 0
      )

    return (
        " | ".join(reviews[:max_reviews]) if reviews else "No Text Reviews Found"
    )

  except Exception as e:
    return "Not Found/Error"


def create_chrome_driver():
  """Creates a memory-optimized Chrome driver instance."""
  options = webdriver.ChromeOptions()
  options.add_argument("--no-sandbox")
  options.add_argument("--disable-dev-shm-usage")
  options.add_argument("--disable-gpu")
  options.add_argument("--disable-extensions")
  prefs = {"profile.managed_default_content_settings.images": 2}
  options.add_experimental_option("prefs", prefs)
  return webdriver.Chrome(options=options)


def convert_csv_to_excel(csv_path, excel_path):
  """Converts the safety CSV log into the final Excel file once scraping completes."""
  if os.path.exists(csv_path):
    print("\n[EXCEL CONVERSION] Converting backup CSV to final Excel file...")
    df_scraped = pd.read_csv(csv_path)
    df_scraped.to_excel(excel_path, sheet_name="Scraped_Data", index=False)
    print(f"SUCCESS: Saved final Excel file to: {excel_path}")


def process_and_update_excel(
    file_path, start_row=0, num_rows=None, driver_restart_every=40
):
  """Main process: Logs strictly to CSV during execution, generates Excel at the very end."""
  if not os.path.exists(file_path):
    print(f"File not found: {file_path}")
    return

  base_dir, file_name = os.path.split(file_path)
  file_root, _ = os.path.splitext(file_name)

  backup_csv_path = os.path.join(base_dir, f"{file_root}_backup.csv")
  output_excel_path = os.path.join(base_dir, f"{file_root}_scraped_output.xlsx")

  df = pd.read_excel(file_path, sheet_name="DATA")
  total_rows = len(df)
  end_row = (
      total_rows if num_rows is None else min(start_row + num_rows, total_rows)
  )

  # 1. ADDED 'bogus_fid' TO CSV HEADER
  if not os.path.exists(backup_csv_path):
    with open(backup_csv_path, mode="w", newline="", encoding="utf-8") as f:
      writer = csv.writer(f)
      writer.writerow(["excel_row_index", "bogus_fid", "url", "scraped_review"])

  driver = create_chrome_driver()

  try:
    for i in range(start_row, end_row):
      # Clear Chrome RAM periodically
      if (i - start_row) > 0 and (i - start_row) % driver_restart_every == 0:
        print("\n[MEMORY REFRESH] Clearing Chrome RAM...")
        driver.quit()
        driver = create_chrome_driver()

      url = df.at[i, "bogus_map"]

      # 2. EXTRACT bogus_fid FROM DATAFRAME
      # Handles cases where bogus_fid might be missing or non-string
      bogus_fid = (
          df.at[i, "bogus_fid"] if "bogus_fid" in df.columns else "N/A"
      )

      print(
          f"Processing Row {i + 1}/{total_rows} (Index {i}) | FID:"
          f" {bogus_fid}..."
      )

      review_result = search_google_map_new(driver, url, max_reviews=10)

      # 3. WRITE bogus_fid TO CSV
      with open(backup_csv_path, mode="a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([i, bogus_fid, url, review_result])

    print("\nScraping loop completed successfully!")

  except Exception as e:
    print(f"\n[CRITICAL ERROR] Execution interrupted: {e}")
    print(
        f"All progress up to this point is safe in CSV: {backup_csv_path}"
    )

  finally:
    driver.quit()
    convert_csv_to_excel(backup_csv_path, output_excel_path)


if __name__ == "__main__":
  excel_file_path = r"/usr/local/google/home/sameerranjan/Desktop/py_work/DATA/MVP_V2_Paris.xlsx"

  process_and_update_excel(
      file_path=excel_file_path,
      start_row=0,
      num_rows=None,
      driver_restart_every=40,
  )