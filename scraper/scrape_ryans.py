"""Export public Ryans PC Builder products to JSON/CSV and local image files.

The site may show a Cloudflare verification screen. This scraper deliberately
uses a visible, persistent Chrome session so a human can complete that check;
it does not attempt to bypass the site's access controls.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

from playwright.sync_api import BrowserContext, Page, sync_playwright

BASE_URL = "https://www.ryans.com"
BUILDER_URL = f"{BASE_URL}/pc-builder"
DEFAULT_CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = PROJECT_ROOT / "scraped_data" / "ryans"
DEFAULT_PROFILE = PROJECT_ROOT / ".scraper-profile"


def slugify(value: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return value or "uncategorized"


def clean_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def wait_for_catalog(page: Page, timeout_seconds: int) -> None:
    """Wait for the real site after any user-completed verification screen."""
    deadline = time.time() + timeout_seconds
    last_title = ""
    while time.time() < deadline:
        last_title = page.title()
        body = page.locator("body").inner_text(timeout=10_000)
        challenged = "Performing security verification" in body or "Just a moment" in last_title
        if not challenged and "pc-builder" in page.url:
            return
        page.wait_for_timeout(2_000)
    raise TimeoutError(
        f"Ryans verification was not completed within {timeout_seconds}s. "
        f"Last page title: {last_title!r}"
    )


def discover_categories(page: Page) -> list[dict[str, str]]:
    page.goto(BUILDER_URL, wait_until="domcontentloaded", timeout=90_000)
    wait_for_catalog(page, 600)
    links = page.locator('a[href*="pc-builder-select?component_id="]').evaluate_all(
        """links => links.map(a => ({
          name: (a.textContent || '').replace(/\\s+/g, ' ').trim(),
          url: a.href
        }))"""
    )
    found: dict[str, dict[str, str]] = {}
    for item in links:
        url = item.get("url", "")
        match = re.search(r"component_id=(\d+)", url)
        if not match:
            continue
        component_id = match.group(1)
        name = clean_text(item.get("name")) or f"Component {component_id}"
        if name.lower() == "select":
            name = f"Component {component_id}"
        found.setdefault(component_id, {"id": component_id, "name": name, "url": url})
    return list(found.values())


def extract_products(page: Page, category: dict[str, str]) -> list[dict]:
    """Find product blocks by their PC Builder button, independent of CSS class names."""
    raw = page.evaluate(
        """() => {
          const norm = value => (value || '').replace(/\\s+/g, ' ').trim();
          const candidates = [...document.querySelectorAll('a, button')]
            .filter(el => /add to pc builder/i.test(norm(el.textContent)));
          return candidates.map(button => {
            let node = button.parentElement;
            let card = node;
            for (let depth = 0; node && depth < 9; depth++, node = node.parentElement) {
              const text = norm(node.innerText);
              const hasPrice = /(?:Tk|৳)\\s*[\\d,]+/i.test(text);
              const hasImage = !!node.querySelector('img');
              const productLinks = [...node.querySelectorAll('a[href]')]
                .filter(a => !/pc-builder|add-to-cart|javascript:/i.test(a.href));
              if (hasPrice && hasImage && productLinks.length) { card = node; break; }
            }
            if (!card) return null;
            const text = norm(card.innerText);
            const priceMatch = text.match(/(?:Tk|৳)\\s*([\\d,]+)/i);
            const links = [...card.querySelectorAll('a[href]')]
              .filter(a => !/pc-builder|add-to-cart|javascript:/i.test(a.href));
            const namedLinks = links.map(a => ({ a, text: norm(a.textContent) }))
              .filter(x => x.text && !/^(select|compare|details)$/i.test(x.text))
              .sort((a, b) => b.text.length - a.text.length);
            const productLink = namedLinks[0];
            const img = card.querySelector('img');
            const specs = [...card.querySelectorAll('li')].map(li => norm(li.textContent)).filter(Boolean);
            const fallbackLines = (card.innerText || '').split(/\\n+/).map(norm)
              .filter(line => line && !/add to pc builder/i.test(line) && !/(?:Tk|৳)\\s*[\\d,]+/i.test(line));
            return {
              name: productLink?.text || fallbackLines[0] || '',
              product_url: productLink?.a.href || '',
              price_bdt: priceMatch ? Number(priceMatch[1].replace(/,/g, '')) : null,
              price_text: priceMatch ? priceMatch[0] : '',
              description: (specs.length ? specs : fallbackLines.slice(1, 9)).join(' | '),
              specifications: specs,
              image_url: img ? (img.currentSrc || img.dataset.src || img.dataset.lazySrc || img.src || '') : '',
              sku: (text.match(/\\b\\d{2}\\.\\d{2}\\.\\d{3}\\.\\d{3}\\b/) || [])[0] || ''
            };
          }).filter(Boolean);
        }"""
    )
    collected_at = datetime.now(timezone.utc).isoformat()
    unique: dict[str, dict] = {}
    for product in raw:
        name = clean_text(product.get("name"))
        price = product.get("price_bdt")
        if not name or price is None:
            continue
        product_url = urljoin(BASE_URL, product.get("product_url", ""))
        image_url = urljoin(BASE_URL, product.get("image_url", ""))
        key = product_url or f"{name}|{price}"
        unique[key] = {
            "source": "Ryans Computers",
            "source_builder_url": category["url"],
            "component_id": category["id"],
            "category": category["name"],
            "name": name,
            "sku": clean_text(product.get("sku")),
            "price_bdt": price,
            "price_text": clean_text(product.get("price_text")),
            "description": clean_text(product.get("description")),
            "specifications": product.get("specifications", []),
            "product_url": product_url,
            "image_url": image_url,
            "local_image_path": "",
            "collected_at": collected_at,
        }
    return list(unique.values())


def extension_for(content_type: str, image_url: str) -> str:
    mapping = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
    content_type = content_type.split(";", 1)[0].lower()
    if content_type in mapping:
        return mapping[content_type]
    suffix = Path(urlparse(image_url).path).suffix.lower()
    return suffix if suffix in mapping.values() else ".jpg"


def download_image(context: BrowserContext, product: dict, output: Path) -> None:
    image_url = product["image_url"]
    if not image_url:
        return
    category_dir = output / "images" / slugify(product["category"])
    category_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha1(image_url.encode("utf-8")).hexdigest()[:10]
    base_name = f"{slugify(product['sku'] or product['name'])[:80]}-{digest}"
    response = context.request.get(
        image_url,
        headers={"Referer": product["source_builder_url"]},
        timeout=45_000,
        fail_on_status_code=False,
    )
    if not response.ok:
        return
    extension = extension_for(response.headers.get("content-type", ""), image_url)
    file_path = category_dir / f"{base_name}{extension}"
    file_path.write_bytes(response.body())
    product["local_image_path"] = file_path.relative_to(output).as_posix()


def save_exports(products: list[dict], categories: list[dict], output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    (output / "categories.json").write_text(json.dumps(categories, ensure_ascii=False, indent=2), encoding="utf-8")
    (output / "products.json").write_text(json.dumps(products, ensure_ascii=False, indent=2), encoding="utf-8")
    fields = [
        "source", "source_builder_url", "component_id", "category", "name", "sku",
        "price_bdt", "price_text", "description", "product_url", "image_url",
        "local_image_path", "collected_at",
    ]
    with (output / "products.csv").open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(products)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape public Ryans PC Builder catalog data")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--chrome", type=Path, default=DEFAULT_CHROME)
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--category-delay", type=float, default=2.0)
    parser.add_argument("--image-delay", type=float, default=0.2)
    parser.add_argument("--skip-images", action="store_true")
    parser.add_argument("--limit-categories", type=int, default=0, help="Useful for a small test run")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(args.profile.resolve()),
            executable_path=str(args.chrome),
            headless=False,
            ignore_default_args=["--no-sandbox"],
            viewport={"width": 1440, "height": 1000},
        )
        page = context.pages[0] if context.pages else context.new_page()
        print("Opening Ryans PC Builder. Complete any browser verification if prompted.", flush=True)
        categories = discover_categories(page)
        if args.limit_categories:
            categories = categories[: args.limit_categories]
        print(f"Discovered {len(categories)} component categories.", flush=True)
        all_products: list[dict] = []
        for index, category in enumerate(categories, start=1):
            print(f"[{index}/{len(categories)}] {category['name']}", flush=True)
            page.goto(category["url"], wait_until="domcontentloaded", timeout=90_000)
            wait_for_catalog(page, 600)
            page.wait_for_timeout(2_000)
            products = extract_products(page, category)
            print(f"  found {len(products)} products", flush=True)
            if not args.skip_images:
                for product_index, product in enumerate(products, start=1):
                    try:
                        download_image(context, product, args.output)
                    except Exception as error:
                        print(f"  image {product_index} failed: {error}", flush=True)
                    time.sleep(args.image_delay)
            all_products.extend(products)
            save_exports(all_products, categories, args.output)
            time.sleep(args.category_delay)
        context.close()
    print(f"Saved {len(all_products)} products to {args.output}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
