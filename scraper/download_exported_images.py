"""Download product images from a JSON export created in normal Brave."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import re
import time
from pathlib import Path
from urllib.parse import urlparse

import requests


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "item"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("json_export", type=Path)
    parser.add_argument("--output", type=Path, default=Path("scraped_data/ryans"))
    parser.add_argument("--delay", type=float, default=0.25)
    args = parser.parse_args()
    payload = json.loads(args.json_export.read_text(encoding="utf-8"))
    products = payload.get("products", payload if isinstance(payload, list) else [])
    session = requests.Session()
    session.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    saved = 0
    for index, product in enumerate(products, start=1):
        url = product.get("image_url") or ""
        if not url:
            continue
        folder = args.output / "images" / slug(product.get("category", "uncategorized"))
        folder.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha1(url.encode()).hexdigest()[:10]
        try:
            response = session.get(url, headers={"Referer": product.get("source_builder_url", "https://www.ryans.com/")}, timeout=30)
            response.raise_for_status()
            content_type = response.headers.get("content-type", "").split(";", 1)[0]
            extension = mimetypes.guess_extension(content_type) or Path(urlparse(url).path).suffix or ".jpg"
            path = folder / f"{slug(product.get('sku') or product.get('name', 'product'))[:90]}-{digest}{extension}"
            path.write_bytes(response.content)
            product["local_image_path"] = path.relative_to(args.output).as_posix()
            saved += 1
        except Exception as error:
            print(f"[{index}/{len(products)}] failed {url}: {error}")
        time.sleep(args.delay)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "products-with-images.json").write_text(json.dumps(products, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {saved} images out of {len(products)} products.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
