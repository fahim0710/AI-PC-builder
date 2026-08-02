import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Copy .env.example to .env.");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Serverless instances can multiply connection pools quickly. Keep the pool
  // deliberately small in production and use a pooled provider URL on Vercel.
  max: process.env.VERCEL ? 3 : 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  allowExitOnIdle: true,
});
