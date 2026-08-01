# Ryans PC Builder importer

This importer collects public PC Builder product listings into:

- `scraped_data/ryans/products.json`
- `scraped_data/ryans/products.csv`
- `scraped_data/ryans/categories.json`
- `scraped_data/ryans/images/<category>/...`

Run from the project root:

```powershell
.\.venv\Scripts\python.exe .\scraper\scrape_ryans.py
```

A visible Chrome window is intentional. If Ryans displays its security check,
complete it once and leave the browser open. The persistent `.scraper-profile`
directory remembers the verified browser session. Exports are saved after every
category, so a partial run still produces usable data.

For a small selector test without downloading images:

```powershell
.\.venv\Scripts\python.exe .\scraper\scrape_ryans.py --limit-categories 1 --skip-images
```

The importer uses a two-second delay between category pages and does not visit
checkout, cart, account, or other user-specific routes. Prices are snapshots and
must retain their `collected_at` timestamps and source links.

## Normal-Brave fallback

If Cloudflare blocks Playwright but Ryans loads in normal Brave:

1. Open `https://www.ryans.com/pc-builder` normally.
2. Open DevTools, select **Console**, and run the complete contents of
   `ryans_console_export.js`.
3. Move the downloaded JSON file to `scraped_data/ryans/import.json`.
4. Download its image manifest with:

```powershell
.\.venv\Scripts\python.exe .\scraper\download_exported_images.py .\scraped_data\ryans\import.json
```

The console exporter runs inside your already verified, normal browser session.
It waits 2.5 seconds between component pages and stops if Ryans requests another
verification instead of attempting to bypass it.
