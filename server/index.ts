import "dotenv/config";
import cors from "cors";
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "./db/pool.js";
import { type AuthenticatedRequest, requireAdmin, requireAuth } from "./auth.js";
import { runPcBuilder } from "./ai/graph.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);

app.use(cors({ origin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173" }));
app.use(express.json());

app.get("/api/health", async (_request, response, next) => {
  try {
    const result = await pool.query<{ now: string }>("SELECT NOW() AS now");
    response.json({ status: "ok", database: "connected", time: result.rows[0].now });
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/me", requireAuth, async (request: AuthenticatedRequest, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id::text, firebase_uid AS "firebaseUid", email,
              display_name AS "displayName", role,
              email_verified AS "emailVerified", stripe_customer_id AS "stripeCustomerId"
       FROM users WHERE firebase_uid = $1`,
      [request.authUser!.uid],
    );
    return response.json({ user: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/categories", async (_request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.source_component_id AS "componentId", c.name, c.source_url AS "sourceUrl",
              COUNT(p.id)::int AS "productCount"
       FROM categories c
       LEFT JOIN products p ON p.category_id = c.id
       GROUP BY c.id
       ORDER BY c.id`,
    );
    response.json({ categories: result.rows });
  } catch (error) {
    next(error);
  }
});

const productQuerySchema = z.object({
  category: z.string().trim().min(1).max(120),
  search: z.string().trim().max(120).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const createProductSchema = z.object({
  category: z.string().trim().min(1).max(120),
  name: z.string().trim().min(2).max(300),
  description: z.string().trim().max(4000).default(""),
  price: z.coerce.number().int().min(0).max(100_000_000),
  imageUrl: z.union([z.string().url(), z.literal("")]).default(""),
  sourceUrl: z.union([z.string().url(), z.literal("")]).default(""),
});

const cartSchema = z.object({
  items: z.array(z.object({
    productId: z.coerce.number().int().positive(),
    quantity: z.coerce.number().int().min(1).max(10).default(1),
  })).max(20).refine((items) => new Set(items.map((item) => item.productId)).size === items.length, "Duplicate products are not allowed"),
});

const checkoutSchema = z.object({ idempotencyKey: z.string().uuid() });
const aiChatSchema = z.object({ conversationId: z.string().uuid().optional(), message: z.string().trim().min(2).max(2000) });
const guestAiSchema = z.object({ sessionId: z.string().uuid(), message: z.string().trim().min(2).max(2000) });
const usedGuestSessions = new Map<string, number>();

async function databaseUserId(firebaseUid: string) {
  const result = await pool.query<{ id: string }>("SELECT id FROM users WHERE firebase_uid = $1", [firebaseUid]);
  if (!result.rowCount) throw new Error("Authenticated database user was not found");
  return result.rows[0].id;
}

app.get("/api/ai/conversations", requireAuth, async (request: AuthenticatedRequest, response, next) => {
  try {
    const userId = await databaseUserId(request.authUser!.uid);
    const result = await pool.query(
      `SELECT c.id, c.title, c.created_at AS "createdAt", c.updated_at AS "updatedAt",
              (SELECT content FROM ai_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS preview
       FROM ai_conversations c WHERE c.user_id = $1 ORDER BY c.updated_at DESC LIMIT 30`, [userId],
    );
    return response.json({ conversations: result.rows });
  } catch (error) { return next(error); }
});

app.get("/api/ai/conversations/:id/messages", requireAuth, async (request: AuthenticatedRequest, response, next) => {
  try {
    const conversationId = z.string().uuid().parse(request.params.id);
    const userId = await databaseUserId(request.authUser!.uid);
    const result = await pool.query(
      `SELECT m.id::text, m.role, m.content, m.build, m.sources,
              m.guardrail_status AS guardrails, m.created_at AS "createdAt"
       FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id
       WHERE c.id = $1 AND c.user_id = $2 ORDER BY m.created_at`, [conversationId, userId],
    );
    return response.json({ messages: result.rows });
  } catch (error) { return next(error); }
});

app.delete("/api/ai/conversations/:id", requireAuth, async (request: AuthenticatedRequest, response, next) => {
  try {
    const conversationId = z.string().uuid().parse(request.params.id);
    const userId = await databaseUserId(request.authUser!.uid);
    const result = await pool.query("DELETE FROM ai_conversations WHERE id = $1 AND user_id = $2 RETURNING id", [conversationId, userId]);
    if (!result.rowCount) return response.status(404).json({ error: "Conversation not found" });
    return response.status(204).send();
  } catch (error) { return next(error); }
});

app.post("/api/ai/guest", async (request, response, next) => {
  try {
    const input = guestAiSchema.parse(request.body);
    const expiry = Date.now() - 60 * 60 * 1000;
    for (const [sessionId, usedAt] of usedGuestSessions) if (usedAt < expiry) usedGuestSessions.delete(sessionId);
    if (usedGuestSessions.has(input.sessionId)) return response.status(429).json({ error: "Guest prompt already used. Sign in to continue chatting." });
    usedGuestSessions.set(input.sessionId, Date.now());
    try {
      const result = await runPcBuilder(input.message, []);
      return response.json({ message: { role: "assistant", content: result.answer, build: result.build, sources: result.sources, guardrails: result.guardrails, total: result.total, budget: result.budget }, guestLimitReached: true });
    } catch (error) {
      usedGuestSessions.delete(input.sessionId);
      throw error;
    }
  } catch (error) { return next(error); }
});

app.post("/api/ai/chat", requireAuth, async (request: AuthenticatedRequest, response, next) => {
  try {
    const input = aiChatSchema.parse(request.body);
    const userId = await databaseUserId(request.authUser!.uid);
    const conversationId = input.conversationId ?? randomUUID();
    if (input.conversationId) {
      const owned = await pool.query("SELECT 1 FROM ai_conversations WHERE id = $1 AND user_id = $2", [conversationId, userId]);
      if (!owned.rowCount) return response.status(404).json({ error: "Conversation not found" });
    } else {
      await pool.query("INSERT INTO ai_conversations (id, user_id, title) VALUES ($1, $2, $3)", [conversationId, userId, input.message.slice(0, 80)]);
    }
    const historyResult = await pool.query<{ role: "user" | "assistant"; content: string }>(
      `SELECT role, content FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 12`, [conversationId],
    );
    await pool.query("INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1, 'user', $2)", [conversationId, input.message]);
    const result = await runPcBuilder(input.message, historyResult.rows.reverse());
    const saved = await pool.query<{ id: string; createdAt: string }>(
      `INSERT INTO ai_messages (conversation_id, role, content, build, sources, guardrail_status)
       VALUES ($1, 'assistant', $2, $3::jsonb, $4::jsonb, $5::jsonb)
       RETURNING id::text, created_at AS "createdAt"`,
      [conversationId, result.answer, JSON.stringify(result.build), JSON.stringify(result.sources), JSON.stringify(result.guardrails)],
    );
    await pool.query("UPDATE ai_conversations SET updated_at = NOW() WHERE id = $1", [conversationId]);
    return response.json({ conversationId, message: { ...saved.rows[0], role: "assistant", content: result.answer, build: result.build, sources: result.sources, guardrails: result.guardrails, total: result.total, budget: result.budget } });
  } catch (error) { return next(error); }
});

app.get("/api/cart", requireAuth, async (request: AuthenticatedRequest, response, next) => {
  try {
    const userId = await databaseUserId(request.authUser!.uid);
    const result = await pool.query(
      `SELECT p.id::text, p.name, p.description, p.price_bdt AS price,
              p.image_url AS "imageUrl", p.source_product_url AS "sourceUrl",
              c.name AS category, ci.quantity
       FROM carts cart
       JOIN cart_items ci ON ci.cart_id = cart.id
       JOIN products p ON p.id = ci.product_id
       JOIN categories c ON c.id = p.category_id
       WHERE cart.user_id = $1 AND p.is_active = TRUE
       ORDER BY ci.created_at`,
      [userId],
    );
    const subtotal = result.rows.reduce((sum, item) => sum + item.price * item.quantity, 0);
    return response.json({ cart: { items: result.rows, currency: "bdt", subtotal, total: subtotal } });
  } catch (error) { return next(error); }
});

app.put("/api/cart", requireAuth, async (request: AuthenticatedRequest, response, next) => {
  const client = await pool.connect();
  try {
    const input = cartSchema.parse(request.body);
    const userId = await databaseUserId(request.authUser!.uid);
    await client.query("BEGIN");
    const cart = await client.query<{ id: string }>(
      `INSERT INTO carts (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW() RETURNING id`, [userId],
    );
    await client.query("DELETE FROM cart_items WHERE cart_id = $1", [cart.rows[0].id]);
    for (const item of input.items) {
      const inserted = await client.query(
        `INSERT INTO cart_items (cart_id, product_id, quantity)
         SELECT $1, id, $3 FROM products WHERE id = $2 AND is_active = TRUE`,
        [cart.rows[0].id, item.productId, item.quantity],
      );
      if (!inserted.rowCount) throw new Error(`Product ${item.productId} is unavailable`);
    }
    await client.query("COMMIT");
    return response.status(204).send();
  } catch (error) { await client.query("ROLLBACK"); return next(error); }
  finally { client.release(); }
});

app.delete("/api/cart/items/:productId", requireAuth, async (request: AuthenticatedRequest, response, next) => {
  try {
    const productId = z.coerce.number().int().positive().parse(request.params.productId);
    const userId = await databaseUserId(request.authUser!.uid);
    await pool.query(
      `DELETE FROM cart_items ci USING carts cart
       WHERE ci.cart_id = cart.id AND cart.user_id = $1 AND ci.product_id = $2`, [userId, productId],
    );
    return response.status(204).send();
  } catch (error) { return next(error); }
});

app.post("/api/checkout/prepare", requireAuth, async (request: AuthenticatedRequest, response, next) => {
  const client = await pool.connect();
  try {
    const { idempotencyKey } = checkoutSchema.parse(request.body);
    const userId = await databaseUserId(request.authUser!.uid);
    const existing = await client.query(
      `SELECT public_id AS "orderId", status, payment_status AS "paymentStatus",
              currency, total_minor AS "totalMinor"
       FROM orders WHERE user_id = $1 AND idempotency_key = $2`, [userId, idempotencyKey],
    );
    if (existing.rowCount) return response.json({ order: existing.rows[0], stripeReady: true });

    await client.query("BEGIN");
    const items = await client.query(
      `SELECT p.id, p.name, p.price_bdt, p.image_url, ci.quantity
       FROM carts cart JOIN cart_items ci ON ci.cart_id = cart.id
       JOIN products p ON p.id = ci.product_id
       WHERE cart.user_id = $1 AND p.is_active = TRUE FOR UPDATE OF ci`, [userId],
    );
    if (!items.rowCount) {
      await client.query("ROLLBACK");
      return response.status(400).json({ error: "Your cart is empty" });
    }
    const subtotalMinor = items.rows.reduce((sum, item) => sum + item.price_bdt * 100 * item.quantity, 0);
    const publicId = randomUUID();
    const order = await client.query<{ id: string }>(
      `INSERT INTO orders (public_id, user_id, currency, subtotal_minor, total_minor, idempotency_key)
       VALUES ($1, $2, 'bdt', $3, $3, $4) RETURNING id`,
      [publicId, userId, subtotalMinor, idempotencyKey],
    );
    for (const item of items.rows) {
      const unitMinor = item.price_bdt * 100;
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_amount_minor, quantity, line_total_minor, image_url)
         VALUES ($1, $2, $3, $4, $5, $4 * $5, $6)`,
        [order.rows[0].id, item.id, item.name, unitMinor, item.quantity, item.image_url],
      );
    }
    await client.query("COMMIT");
    return response.status(201).json({
      order: { orderId: publicId, status: "pending_payment", paymentStatus: "unpaid", currency: "bdt", totalMinor: subtotalMinor },
      stripeReady: true,
      message: "Order prepared. No payment has been charged.",
    });
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); return next(error); }
  finally { client.release(); }
});

app.get("/api/products", async (request, response, next) => {
  try {
    const query = productQuerySchema.parse(request.query);
    const values: unknown[] = [query.category, query.limit, query.offset];
    let searchSql = "";
    if (query.search) {
      values.push(`%${query.search}%`);
      searchSql = `AND p.name ILIKE $${values.length}`;
    }
    const result = await pool.query(
      `SELECT p.id::text, p.name, p.description,
              p.specifications, p.price_bdt AS price,
              p.price_text AS "priceText", p.image_url AS "imageUrl",
              p.source_product_url AS "sourceUrl", p.source_sku AS sku,
              c.name AS category
       FROM products p
       JOIN categories c ON c.id = p.category_id
       WHERE LOWER(c.name) = LOWER($1) AND p.is_active = TRUE ${searchSql}
       ORDER BY p.price_bdt ASC, p.name ASC
       LIMIT $2 OFFSET $3`,
      values,
    );
    response.json({ products: result.rows, limit: query.limit, offset: query.offset });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/products", requireAuth, requireAdmin, async (request, response, next) => {
  try {
    const product = createProductSchema.parse(request.body);
    const category = await pool.query<{ id: string; source_url: string }>(
      "SELECT id, source_url FROM categories WHERE LOWER(name) = LOWER($1)", [product.category],
    );
    if (!category.rowCount) return response.status(400).json({ error: "Unknown product category" });
    const uniqueSourceUrl = product.sourceUrl || `https://nexrig.local/admin-products/${randomUUID()}`;
    const result = await pool.query(
      `INSERT INTO products (category_id, source, source_product_url, source_builder_url, name,
         description, specifications, price_bdt, price_text, image_url, collected_at)
       VALUES ($1, 'NexRig Admin', $2, $3, $4, $5, '[]'::jsonb, $6, $7, $8, NOW())
       RETURNING id::text, name, description, price_bdt AS price, price_text AS "priceText",
         image_url AS "imageUrl", source_product_url AS "sourceUrl"`,
      [category.rows[0].id, uniqueSourceUrl, category.rows[0].source_url, product.name,
        product.description, product.price, `৳${product.price.toLocaleString("en-BD")}`, product.imageUrl || null],
    );
    return response.status(201).json({ product: { ...result.rows[0], category: product.category, specifications: [] } });
  } catch (error) { return next(error); }
});

app.delete("/api/admin/products/:id", requireAuth, requireAdmin, async (request, response, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const result = await pool.query(
      "UPDATE products SET is_active = FALSE, updated_at = NOW() WHERE id = $1 AND is_active = TRUE RETURNING id",
      [id],
    );
    if (!result.rowCount) return response.status(404).json({ error: "Product not found" });
    return response.status(204).send();
  } catch (error) { return next(error); }
});

app.get("/api/products/:id", async (request, response, next) => {
  try {
    const id = z.coerce.number().int().positive().parse(request.params.id);
    const result = await pool.query(
      `SELECT p.id::text, p.name, p.description, p.specifications,
              p.price_bdt AS price, p.price_text AS "priceText",
              p.image_url AS "imageUrl", p.source_product_url AS "sourceUrl",
              p.source_sku AS sku, c.name AS category
       FROM products p JOIN categories c ON c.id = p.category_id
       WHERE p.id = $1 AND p.is_active = TRUE`,
      [id],
    );
    if (!result.rowCount) return response.status(404).json({ error: "Product not found" });
    return response.json({ product: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) {
    return response.status(400).json({ error: "Invalid request", details: error.issues });
  }
  console.error(error);
  return response.status(500).json({ error: "Internal server error" });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`NexRig API listening at http://127.0.0.1:${port}`);
});
