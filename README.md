# NexRig AI PC Builder

The current milestone is a database-backed PC component builder using the
public Ryans catalog export.

## Data flow

```text
React (Vite, port 5173)
        |
        | /api
        v
Express API (port 4000)
        |
        | parameterized SQL via node-postgres
        v
PostgreSQL 17 (Docker, port 5432)
```

Product names, prices, descriptions, specifications, source links, and image
URLs live in PostgreSQL. The React application no longer contains a hard-coded
product catalog.

## Start the project

1. Start Docker Desktop.
2. Start PostgreSQL:

   ```powershell
   npm run db:up
   ```

3. Import or refresh the Ryans JSON export:

   ```powershell
   npm run db:import -- "E:\Downloads\ryans-products-2026-07-30T00-51-36-124Z.json"
   ```

4. Start the frontend and API together:

   ```powershell
   npm run dev
   ```

5. Open `http://127.0.0.1:5173`.

## Database files

- `docker-compose.yml` defines PostgreSQL and its persistent Docker volume.
- `server/db/schema.sql` defines `categories` and `products`.
- `server/db/pool.ts` owns the database connection pool.
- `server/scripts/import-ryans.ts` validates and upserts scraper exports.
- `.env.example` documents local configuration.

The importer is idempotent: importing the same export updates existing products
by their Ryans product URL rather than creating duplicates.

## API

- `GET /api/health`
- `GET /api/categories`
- `GET /api/products?category=CPU&search=Ryzen&limit=50&offset=0`
- `GET /api/products/:id`

## Verification

```powershell
npm run build
npm run typecheck:server
```
# Firebase authentication

The React app uses the Firebase client SDK for email/password and Google sign-in. After login, it sends a Firebase ID token to `GET /api/auth/me`. Express verifies that token with the Firebase Admin SDK and creates or updates the matching record in PostgreSQL's `users` table.

Enable **Email/Password** and **Google** in Firebase Console → Authentication → Sign-in method. The Firebase web configuration lives in `.env`; `.env` is gitignored. A deployed API should set `FIREBASE_SERVICE_ACCOUNT_JSON` as a secret. Never expose that service-account JSON through a `VITE_` variable.

After the Docker engine is running, apply schema updates without deleting product data:

```bash
npm run db:up
npm run db:migrate
```

## Cart and checkout preparation

Authenticated users can save the currently selected PC components into a PostgreSQL cart and prepare an unpaid order. Checkout preparation snapshots product names and prices into `order_items`; later catalog price changes therefore cannot alter an existing order. Amounts are stored as integer minor units, and `orders` already includes nullable Stripe Checkout Session and PaymentIntent identifiers. No Stripe SDK or payment API call is included yet.

## AI PC builder (RAG)

The authenticated AI chat uses LangGraph to execute a fixed workflow: intent extraction → manual retrieval → internet requirements context → PostgreSQL product retrieval → Hugging Face generation → deterministic guardrails. PostgreSQL is the only allowed source for product IDs, names and prices. Conversations and messages are persisted per Firebase user.

Configure `HF_TOKEN`, `HF_CHAT_MODEL` and `HF_EMBEDDING_MODEL` in `.env`. Ingest a text or Markdown PC-build manual with:

```bash
npm run ai:ingest -- "C:\path\to\pc-build-manual.txt"
```

The manual is chunked with overlap, embedded through Hugging Face, and stored in `knowledge_documents` and `knowledge_chunks`. PDF/DOCX conversion is not included in the first ingestion version. The web node uses a keyless general-context lookup and a structured Steam requirements fallback for games. Web results provide context only; they never introduce purchasable products.

Open local development at `http://localhost:5173`. Firebase authorizes domains by hostname, so `localhost` and `127.0.0.1` are different OAuth domains.
