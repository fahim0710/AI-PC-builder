import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const isLocalDatabaseUrl = (value: string | undefined) => {
  if (!value) return false;
  try { return ["localhost", "127.0.0.1", "postgres"].includes(new URL(value).hostname); }
  catch { return false; }
};

// A manually uploaded local .env can accidentally override the Neon variables
// injected by Vercel. Never try to connect a serverless function to its own
// localhost; prefer the integration-provided pooled URL in that situation.
const databaseUrl = process.env.VERCEL && isLocalDatabaseUrl(process.env.DATABASE_URL)
  ? process.env.POSTGRES_URL ?? process.env.DATABASE_URL_UNPOOLED
  : process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.DATABASE_URL_UNPOOLED;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required. Copy .env.example to .env.");
}

if (process.env.VERCEL && isLocalDatabaseUrl(databaseUrl)) {
  throw new Error("Vercel requires a hosted PostgreSQL URL; localhost is not reachable from a serverless function.");
}

export const pool = new Pool({
  connectionString: databaseUrl,
  // Serverless instances can multiply connection pools quickly. Keep the pool
  // deliberately small in production and use a pooled provider URL on Vercel.
  max: process.env.VERCEL ? 3 : 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  allowExitOnIdle: true,
});
