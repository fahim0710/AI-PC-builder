import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { pool } from "../db/pool.js";

const productSchema = z.object({
  source: z.string().default("Ryans Computers"),
  source_builder_url: z.string().url(),
  component_id: z.coerce.string(),
  category: z.string().min(1),
  name: z.string().min(1),
  sku: z.string().optional().default(""),
  price_bdt: z.coerce.number().int().nonnegative(),
  price_text: z.string().optional().default(""),
  description: z.string().optional().default(""),
  specifications: z.array(z.string()).optional().default([]),
  product_url: z.string().url(),
  image_url: z.string().optional().default(""),
  local_image_path: z.string().optional().default(""),
  collected_at: z.coerce.date(),
});

const exportSchema = z.object({ products: z.array(productSchema) });

async function run() {
  const inputPath = resolve(process.argv[2] ?? process.env.RYANS_EXPORT_PATH ?? "");
  if (!inputPath) throw new Error("Pass the Ryans JSON export path or set RYANS_EXPORT_PATH.");
  const payload = exportSchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(await readFile(resolve("server/db/schema.sql"), "utf8"));
    const categoryIds = new Map<string, string>();
    for (const product of payload.products) {
      const categoryKey = product.component_id;
      if (!categoryIds.has(categoryKey)) {
        const category = await client.query<{ id: string }>(
          `INSERT INTO categories (source_component_id, name, source_url)
           VALUES ($1, $2, $3)
           ON CONFLICT (source_component_id) DO UPDATE
           SET name = EXCLUDED.name, source_url = EXCLUDED.source_url, updated_at = NOW()
           RETURNING id::text`,
          [product.component_id, product.category, product.source_builder_url],
        );
        categoryIds.set(categoryKey, category.rows[0].id);
      }
      await client.query(
        `INSERT INTO products (
           category_id, source, source_product_url, source_builder_url, source_sku,
           name, description, specifications, price_bdt, price_text, image_url,
           local_image_path, collected_at
         ) VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7,$8::jsonb,$9,$10,NULLIF($11,''),NULLIF($12,''),$13)
         ON CONFLICT (source_product_url) DO UPDATE SET
           category_id=EXCLUDED.category_id, source_sku=EXCLUDED.source_sku,
           name=EXCLUDED.name, description=EXCLUDED.description,
           specifications=EXCLUDED.specifications, price_bdt=EXCLUDED.price_bdt,
           price_text=EXCLUDED.price_text, image_url=EXCLUDED.image_url,
           local_image_path=EXCLUDED.local_image_path, collected_at=EXCLUDED.collected_at,
           updated_at=NOW()`,
        [
          categoryIds.get(categoryKey), product.source, product.product_url,
          product.source_builder_url, product.sku, product.name, product.description,
          JSON.stringify(product.specifications), product.price_bdt, product.price_text,
          product.image_url, product.local_image_path, product.collected_at,
        ],
      );
    }
    await client.query("COMMIT");
    const counts = await client.query(
      `SELECT COUNT(*)::int AS products, COUNT(DISTINCT category_id)::int AS categories FROM products`,
    );
    console.log(`Imported ${counts.rows[0].products} products across ${counts.rows[0].categories} categories.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
