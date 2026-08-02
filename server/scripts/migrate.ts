import "dotenv/config";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "../db/pool.js";

const schemaPath = fileURLToPath(new URL("../db/schema.sql", import.meta.url));

try {
  const schema = await readFile(schemaPath, "utf8");
  await pool.query(schema);
  console.log("Database schema is up to date.");
} finally {
  await pool.end();
}
