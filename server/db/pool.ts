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
// Vercel Marketplace integrations can use a custom prefix. This project was
// connected with the prefix `STORAGE`, which exposes STORAGE_URL. Accept both
// that name and the standard Neon/Vercel names so preview and production
// deployments use the same database without copying secrets into the repo.
const hostedDatabaseUrl = process.env.POSTGRES_URL
  ?? process.env.STORAGE_URL
  ?? process.env.DATABASE_URL_UNPOOLED
  ?? process.env.POSTGRES_PRISMA_URL
  ?? process.env.STORAGE_URL_UNPOOLED;

const databaseUrl = process.env.VERCEL && isLocalDatabaseUrl(process.env.DATABASE_URL)
  ? hostedDatabaseUrl
  : process.env.DATABASE_URL ?? hostedDatabaseUrl;

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
