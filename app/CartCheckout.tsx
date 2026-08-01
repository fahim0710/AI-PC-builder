import { useEffect, useMemo, useState } from "react";
import { auth } from "./firebase";

type CartItem = { id: string; name: string; price: number; quantity: number; category: string; imageUrl?: string };

async function authenticatedFetch(url: string, options: RequestInit = {}) {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("Please sign in again.");
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...options.headers } });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? "Request failed.");
  return body;
}

export function CartCheckout({ onClose, onRemoved }: { onClose: () => void; onRemoved: (productId: string) => void }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [orderId, setOrderId] = useState("");
  const total = useMemo(() => items.reduce((sum, item) => sum + item.price * item.quantity, 0), [items]);

  useEffect(() => {
    authenticatedFetch("/api/cart").then((data) => setItems(data.cart.items)).catch((error: Error) => setMessage(error.message)).finally(() => setLoading(false));
  }, []);

  const remove = async (item: CartItem) => {
    try {
      await authenticatedFetch(`/api/cart/items/${item.id}`, { method: "DELETE" });
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      onRemoved(item.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not remove item."); }
  };

  const prepareCheckout = async () => {
    setMessage("Preparing your order…");
    try {
      const data = await authenticatedFetch("/api/checkout/prepare", { method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }) });
      setOrderId(data.order.orderId);
      setMessage("Order prepared. No payment was charged—Stripe will be connected in the next phase.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Checkout could not be prepared."); }
  };

  return <div className="modal-backdrop cart-backdrop" onMouseDown={onClose}><section className="cart-modal" role="dialog" aria-modal="true" aria-label="Review cart" onMouseDown={(e) => e.stopPropagation()}>
    <header><div><div className="step">CHECKOUT 01</div><h2>Review your build</h2></div><button aria-label="Close" onClick={onClose}>×</button></header>
    {loading ? <p className="cart-state">Loading your saved cart…</p> : <div className="cart-body">
      <div className="cart-items">{items.length === 0 ? <p className="cart-state">Your cart is empty.</p> : items.map((item) => <article key={item.id}>
        <div className="cart-thumb">{item.imageUrl ? <img src={item.imageUrl} alt="" /> : item.category.slice(0, 3).toUpperCase()}</div>
        <div><small>{item.category}</small><strong>{item.name}</strong><span>Quantity {item.quantity}</span></div>
        <b>৳{(item.price * item.quantity).toLocaleString("en-BD")}</b><button onClick={() => void remove(item)}>Remove</button>
      </article>)}</div>
      <aside className="checkout-card"><span>ORDER SUMMARY</span><div><span>Components</span><b>{items.length}</b></div><div><span>Subtotal</span><b>৳{total.toLocaleString("en-BD")}</b></div><div><span>Delivery</span><b>Calculated later</b></div><div className="checkout-total"><span>Total</span><strong>৳{total.toLocaleString("en-BD")}</strong></div>
        <button className="checkout" disabled={!items.length || Boolean(orderId)} onClick={() => void prepareCheckout()}>{orderId ? "Order prepared" : "Prepare secure checkout"}<span>→</span></button>
        <small>Stripe is not connected yet. This creates an unpaid order only.</small>{orderId && <code>Order {orderId}</code>}{message && <p className="cart-message" role="status">{message}</p>}
      </aside>
    </div>}
  </section></div>;
}
