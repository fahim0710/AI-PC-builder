# NexRig AI PC Builder

NexRig is a full-stack PC-building application for Bangladesh. It combines a PostgreSQL catalog imported from Ryans Computers, Firebase authentication, an AI/RAG recommendation agent named **Nexa**, a persistent cart, administrator product management, and Stripe-hosted Checkout.

## What is implemented

- Database-backed component catalog with search, categories, product details, images, build selection and totals.
- Firebase email/password and Google sign-in; Firebase Admin verifies every protected API request.
- PostgreSQL admin allowlist with authenticated product creation and soft deletion.
- Guest AI limit of one prompt per browser session; signed-in users get persistent conversations and chat deletion.
- Nexa workflow using LangGraph, Hugging Face, manual RAG, internet context and deterministic budget/compatibility checks.
- PostgreSQL-only product validation so the model cannot invent purchasable products or prices.
- Persistent cart and immutable order snapshots.
- Stripe Checkout with server-calculated prices, idempotency, delivery details, return-page verification and signed webhooks.
- Local PostgreSQL 17 via Docker Compose and a Vercel-compatible serverless Express entry.

## Architecture

```text
Vite + React browser
        | Firebase ID token / JSON
        v
Express API
  local: Node on port 4001
  Vercel: api/[...path].ts function
        |
        +-- PostgreSQL: catalog, users, carts, orders, chats, RAG
        +-- Firebase Admin: identity verification
        +-- Hugging Face + LangGraph: Nexa
        +-- Stripe: hosted Checkout + webhooks
```

Docker is for **local development only**. Vercel cannot run `docker-compose.yml`; production needs hosted PostgreSQL with a pooled connection URL, such as Neon through the Vercel Marketplace.

## Project map

- `app/` — React UI, authentication modal, Nexa chat, admin tools, cart/checkout and styles.
- `src/` — Vite browser entry and environment types.
- `api/` — Vercel catch-all function exporting the Express app.
- `server/` — routes, authorization, AI, database, payments and scripts.
- `server/db/` — PostgreSQL pool and complete idempotent schema.
- `server/ai/` — Hugging Face client, retrieval/ranking and LangGraph workflow.
- `server/payments/` — Stripe client and webhook handler.
- `scraper/` — Ryans browser export, scraper and image utilities.
- `public/` — static assets.

## Local setup

Requirements: Node.js 20+, npm, Docker Engine, and Firebase/Hugging Face/Stripe accounts.

```powershell
npm install
Copy-Item .env.example .env
npm run db:up
npm run db:migrate
npm run db:migrate:remote  # Uses DATABASE_URL; intended for hosted PostgreSQL
npm run db:import -- "C:\path\to\ryans-products.json"
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to port `4001`. Add `localhost` to Firebase Authentication → Settings → Authorized domains.

Useful commands:

```powershell
npm run build
npm run typecheck:server
npm run hf:verify
npm run ai:eval
npm run ai:ingest -- "C:\path\to\manual.txt"
npm run db:down
```

The catalog importer upserts by Ryans product URL. Product image URLs are stored in PostgreSQL; locally downloaded image files are not required in production.

## Environment variables

Copy `.env.example` locally and never commit `.env`. `VITE_` variables are intentionally public in the browser bundle; every other credential is server-only.

| Variable | Scope | Purpose |
|---|---|---|
| `DATABASE_URL` | Server | PostgreSQL; use a pooled TLS URL on Vercel |
| `WEB_ORIGIN`, `APP_URL` | Server | Browser origin and Stripe return URL |
| `VITE_FIREBASE_*` | Browser/public | Firebase web-app configuration |
| `FIREBASE_PROJECT_ID` | Server | Firebase Admin project |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Secret | Full service-account JSON as one value |
| `HF_TOKEN` | Secret | Hugging Face inference token |
| `HF_CHAT_MODEL`, `HF_EMBEDDING_MODEL` | Server | AI model IDs |
| `AI_WEB_SEARCH_ENABLED` | Server | Enables contextual web lookup |
| `STRIPE_SECRET_KEY` | Secret | Stripe server API key |
| `STRIPE_WEBHOOK_SECRET` | Secret | Stripe webhook signature verification |

The frontend does not need a Stripe publishable key because the server redirects to Stripe's hosted Checkout page.

## Authentication and administrators

Enable Email/Password and Google providers in Firebase. Add the final Vercel/custom hostname to Authorized domains. Google OAuth fails on an unapproved hostname.

Admin status is not implied by Google sign-in. On login, the API normalizes the Firebase email, compares it with PostgreSQL `admin_emails`, and assigns the role. Admin endpoints verify both the Firebase token and database role. The schema currently seeds the project owner's chosen admin email.

## Nexa AI/RAG

The graph runs intent extraction → manual retrieval → internet requirements context → PostgreSQL candidate ranking → Hugging Face explanation → deterministic validation. PostgreSQL is the final authority for names, IDs and prices. Chat context, web text, manual chunks and output are capped to keep token use low. If generation is unavailable, the UI reports that the server is busy rather than presenting fallback text as an AI answer.

## Stripe flow

1. A signed-in user saves catalog products to their database cart.
2. The API validates name, phone and delivery address, then rereads active products and prices.
3. It creates immutable `orders` and `order_items` in integer minor units.
4. It creates an idempotent Stripe Checkout Session and redirects the browser.
5. The signed webhook and return-page check mark the order paid and clear the cart.

For local testing, forward Stripe CLI events to `http://localhost:4001/api/webhooks/stripe`. In production, register `https://YOUR_DOMAIN/api/webhooks/stripe`, subscribe to `checkout.session.completed`, and save its signing secret in `STRIPE_WEBHOOK_SECRET`.

## Deploy on Vercel

1. Push the repository to GitHub and import it into Vercel as a Vite project.
2. Create hosted PostgreSQL, point `DATABASE_URL` at it, run `npm run db:migrate:remote`, and import the catalog into that database.
3. Add all applicable `.env.example` values in Vercel Project Settings. Store secrets as sensitive values. Set `APP_URL` and `WEB_ORIGIN` to the production HTTPS URL.
4. Deploy. `vercel.json` builds static assets to `dist`; `api/[...path].ts` runs Express as a Node function.
5. Add the deployed domain to Firebase and configure the Stripe production webhook.
6. Verify `/api/health`, login, catalog loading, Nexa and a Stripe test payment before enabling live payments.

Environment changes affect only new deployments, so redeploy after updating them. Use separate Preview and Production credentials and databases.

## Security and release checklist

- `.env`, exports, local images, logs, caches, build output and Docker data are gitignored.
- Never give server secrets a `VITE_` prefix.
- Rotate any credential pasted into chat, screenshots, logs or Git history before production.
- Keep Firebase service-account JSON and Stripe/Hugging Face secrets only in Vercel's encrypted environment settings.
- A current-tree scan cannot erase old Git history; inspect history and rotate any credential that was ever committed.
- Use pooled TLS PostgreSQL and restricted production credentials.

Before release:

```powershell
npm ci
npm run typecheck:server
npm run build
```
