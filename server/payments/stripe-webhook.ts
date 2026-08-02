import type { Request, Response } from "express";
import type Stripe from "stripe";
import { pool } from "../db/pool.js";
import { getStripe } from "./stripe.js";

const paymentIntentId = (session: Stripe.Checkout.Session) =>
  typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;

export async function stripeWebhook(request: Request, response: Response) {
  const signature = request.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || typeof signature !== "string") return response.status(400).send("Stripe webhook is not configured");

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(request.body, signature, secret);
  } catch (error) {
    console.error("Stripe webhook signature verification failed", error instanceof Error ? error.message : error);
    return response.status(400).send("Invalid Stripe signature");
  }

  const supported = new Set([
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "checkout.session.expired",
  ]);
  if (!supported.has(event.type)) return response.json({ received: true });

  const session = event.data.object as Stripe.Checkout.Session;
  const orderId = session.metadata?.orderId;
  if (!orderId) return response.status(400).send("Stripe session has no order metadata");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const recorded = await client.query(
      `INSERT INTO stripe_webhook_events (stripe_event_id, event_type)
       VALUES ($1, $2) ON CONFLICT (stripe_event_id) DO NOTHING RETURNING stripe_event_id`,
      [event.id, event.type],
    );
    if (!recorded.rowCount) {
      await client.query("ROLLBACK");
      return response.json({ received: true, duplicate: true });
    }

    const order = await client.query<{ id: string; user_id: string; total_minor: string; currency: string; stripe_checkout_session_id: string | null }>(
      `SELECT id, user_id, total_minor, currency, stripe_checkout_session_id
       FROM orders WHERE public_id = $1 FOR UPDATE`, [orderId],
    );
    if (!order.rowCount) throw new Error(`Stripe referenced unknown order ${orderId}`);
    const saved = order.rows[0];
    if (saved.stripe_checkout_session_id !== session.id) throw new Error("Stripe session does not match the saved order");
    if (session.currency !== saved.currency || session.amount_total !== Number(saved.total_minor)) throw new Error("Stripe amount or currency does not match the saved order");

    const paid = (event.type === "checkout.session.completed" && session.payment_status === "paid") || event.type === "checkout.session.async_payment_succeeded";
    if (paid) {
      await client.query(
        `UPDATE orders SET status = 'paid', payment_status = 'paid', stripe_payment_intent_id = $1, updated_at = NOW()
         WHERE id = $2 AND payment_status <> 'paid'`, [paymentIntentId(session), saved.id],
      );
      await client.query(
        `DELETE FROM cart_items WHERE cart_id = (SELECT id FROM carts WHERE user_id = $1)`, [saved.user_id],
      );
    } else if (event.type === "checkout.session.async_payment_failed") {
      await client.query("UPDATE orders SET status = 'cancelled', payment_status = 'failed', updated_at = NOW() WHERE id = $1 AND payment_status <> 'paid'", [saved.id]);
    } else if (event.type === "checkout.session.expired") {
      await client.query("UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND payment_status <> 'paid'", [saved.id]);
    }
    await client.query("COMMIT");
    return response.json({ received: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Stripe webhook processing failed", error);
    return response.status(500).send("Webhook processing failed");
  } finally {
    client.release();
  }
}
