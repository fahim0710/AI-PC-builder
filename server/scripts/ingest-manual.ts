import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { pool } from "../db/pool.js";
import { embed } from "../ai/huggingface.js";

const manualPath = process.argv[2];
if (!manualPath) throw new Error("Usage: npm run ai:ingest -- path/to/manual.txt");
const absolutePath = resolve(manualPath);
if (![".txt", ".md"].includes(extname(absolutePath).toLowerCase())) throw new Error("The first ingestion version accepts .txt and .md manuals. Convert PDF/DOCX to text first.");

const content = (await readFile(absolutePath, "utf8")).replace(/\r\n/g, "\n").trim();
if (!content) throw new Error("Manual is empty");
const hash = createHash("sha256").update(content).digest("hex");

function chunkText(text: string, size = 1400, overlap = 220) {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf("\n\n", end), text.lastIndexOf(". ", end));
      if (boundary > start + size * 0.55) end = boundary + 1;
    }
    chunks.push(text.slice(start, end).trim());
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const document = await client.query<{ id: string }>(
    `INSERT INTO knowledge_documents (title, source_path, content_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (source_path) DO UPDATE SET title = EXCLUDED.title,
       content_hash = EXCLUDED.content_hash, updated_at = NOW()
     RETURNING id`, [basename(absolutePath), absolutePath, hash],
  );
  await client.query("DELETE FROM knowledge_chunks WHERE document_id = $1", [document.rows[0].id]);
  const chunks = chunkText(content);
  for (let index = 0; index < chunks.length; index++) {
    const vector = await embed(chunks[index]);
    await client.query(
      `INSERT INTO knowledge_chunks (document_id, chunk_index, content, embedding, metadata)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
      [document.rows[0].id, index, chunks[index], JSON.stringify(vector), JSON.stringify({ source: basename(absolutePath), chunk: index })],
    );
    console.log(`Embedded chunk ${index + 1}/${chunks.length}`);
  }
  await client.query("COMMIT");
  console.log(`Ingested ${chunks.length} chunks from ${absolutePath}`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
