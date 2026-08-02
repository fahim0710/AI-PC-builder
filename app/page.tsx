"use client";

import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { AuthModal } from "./AuthModal";
import { auth } from "./firebase";
import { AdminProducts } from "./AdminProducts";
import { CartCheckout } from "./CartCheckout";
import { AiChat } from "./AiChat";

type ComponentKey = "cpu" | "motherboard" | "ram" | "gpu" | "ssd" | "psu" | "case" | "cooler";
type Product = { id: string; name: string; price: number; description: string; specifications: string[]; sourceUrl: string; imageUrl: string; category: string };

const categories: { key: ComponentKey; label: string; dataCategory: string; hint: string; mark: string }[] = [
  { key: "cpu", label: "Processor", dataCategory: "CPU", hint: "The brain", mark: "CPU" },
  { key: "motherboard", label: "Motherboard", dataCategory: "Motherboard", hint: "Connect everything", mark: "MB" },
  { key: "ram", label: "Memory", dataCategory: "Ram", hint: "Run more at once", mark: "RAM" },
  { key: "gpu", label: "Graphics card", dataCategory: "Graphics Card", hint: "Power the pixels", mark: "GPU" },
  { key: "ssd", label: "Storage", dataCategory: "SSD", hint: "Keep it fast", mark: "SSD" },
  { key: "psu", label: "Power supply", dataCategory: "Power Supply", hint: "Stable, clean power", mark: "PSU" },
  { key: "case", label: "Case", dataCategory: "Casing", hint: "Bring it together", mark: "CASE" },
  { key: "cooler", label: "CPU cooler", dataCategory: "CPU Cooler", hint: "Stay cool", mark: "COOL" },
];

const money = (value: number) => `৳${new Intl.NumberFormat("en-BD").format(value)}`;

export default function Home() {
  const [selected, setSelected] = useState<Partial<Record<ComponentKey, Product>>>({});
  const [active, setActive] = useState<ComponentKey | null>(null);
  const [search, setSearch] = useState("");
  const [products, setProducts] = useState<Partial<Record<ComponentKey, Product[]>>>({});
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [productError, setProductError] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<"customer" | "admin" | null>(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [cartError, setCartError] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const [checkoutNotice, setCheckoutNotice] = useState<{ kind: "success" | "pending" | "cancelled" | "error"; text: string; orderId?: string } | null>(null);
  const [guestAiUsed, setGuestAiUsed] = useState(false);
  const [guestAiSession] = useState(() => crypto.randomUUID());
  const total = useMemo(() => Object.values(selected).reduce((sum, item) => sum + (item?.price ?? 0), 0), [selected]);
  const progress = Math.round((Object.keys(selected).length / categories.length) * 100);
  const activeProducts = active ? (products[active] ?? []).filter((p) => p.name.toLowerCase().includes(search.toLowerCase())) : [];

  useEffect(() => onAuthStateChanged(auth, async (firebaseUser) => {
    setUser(firebaseUser);
    if (!firebaseUser) { setRole(null); return; }
    const token = await firebaseUser.getIdToken();
    const response = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    if (response.ok) {
      const data = await response.json() as { user: { role: "customer" | "admin" } };
      setRole(data.user.role);
    }
  }), []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");
    if (checkout === "cancelled") {
      setCheckoutNotice({ kind: "cancelled", text: "Checkout was cancelled. Your cart is still available." });
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
    const sessionId = params.get("session_id");
    if (checkout !== "success" || !sessionId || !user) return;
    let active = true;
    const verify = async () => {
      try {
        const token = await user.getIdToken();
        const response = await fetch(`/api/orders/by-session/${encodeURIComponent(sessionId)}`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? "Could not verify the order.");
        if (!active) return;
        const paid = data.order.paymentStatus === "paid";
        setCheckoutNotice({ kind: paid ? "success" : "pending", text: paid ? "Payment confirmed. Your PC order has been placed." : "Stripe received your checkout. Payment confirmation is still processing; refresh shortly.", orderId: data.order.orderId });
      } catch (error) {
        if (active) setCheckoutNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not verify the order." });
      } finally {
        window.history.replaceState({}, "", window.location.pathname);
      }
    };
    void verify();
    return () => { active = false; };
  }, [user]);

  useEffect(() => {
    if (!active || products[active]) return;
    const category = categories.find((item) => item.key === active);
    if (!category) return;
    const controller = new AbortController();
    setLoadingProducts(true);
    setProductError("");
    fetch(`/api/products?category=${encodeURIComponent(category.dataCategory)}&limit=100`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Could not load products from PostgreSQL.");
        return response.json() as Promise<{ products: Product[] }>;
      })
      .then((data) => setProducts((current) => ({ ...current, [active]: data.products })))
      .catch((error: Error) => { if (error.name !== "AbortError") setProductError(error.message); })
      .finally(() => setLoadingProducts(false));
    return () => controller.abort();
  }, [active, products]);

  const reviewBuild = async () => {
    if (!user) { setAuthOpen(true); return; }
    setCartError("");
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/cart", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ items: Object.values(selected).map((item) => ({ productId: Number(item!.id), quantity: 1 })) }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "Could not save cart.");
      }
      setCartOpen(true);
    } catch (error) { setCartError(error instanceof Error ? error.message : "Could not save cart."); }
  };

  const openAi = () => setAiOpen(true);
  const applyAiBuild = (build: Product[]) => {
    const next: Partial<Record<ComponentKey, Product>> = {};
    for (const product of build) {
      const category = categories.find((item) => item.dataCategory.toLowerCase() === product.category.toLowerCase());
      if (category) next[category.key] = product;
    }
    setSelected(next); setAiOpen(false); document.getElementById("builder")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <main>
      {checkoutNotice && <div className={`checkout-notice ${checkoutNotice.kind}`} role="status"><div><b>{checkoutNotice.kind === "success" ? "Payment successful" : checkoutNotice.kind === "pending" ? "Payment processing" : checkoutNotice.kind === "cancelled" ? "Checkout cancelled" : "Checkout status unavailable"}</b><span>{checkoutNotice.text}</span>{checkoutNotice.orderId && <code>Order {checkoutNotice.orderId}</code>}</div><button aria-label="Dismiss checkout message" onClick={() => setCheckoutNotice(null)}>×</button></div>}
      <header className="topbar">
        <a className="brand" href="#"><span className="brand-mark">N</span><span>NEXRIG</span></a>
        <nav aria-label="Main navigation"><a href="#builder">Builder</a><a href="#about">About us</a><a href="https://www.ryans.com/pc-builder" target="_blank" rel="noreferrer">Data source ↗</a></nav>
        {user
          ? <div className="account"><span className="avatar">{(user.displayName ?? user.email ?? "U")[0].toUpperCase()}</span><span>{user.displayName ?? user.email}</span>{role === "admin" && <button className="admin-entry" onClick={() => setAdminOpen(true)}>Manage products</button>}<button className="ghost" onClick={() => signOut(auth)}>Sign out</button></div>
          : <button className="ghost" onClick={() => setAuthOpen(true)}>Sign in</button>}
      </header>

      <section className="hero">
        <div className="eyebrow"><span /> AI-guided. Expert checked.</div>
        <h1>Your perfect PC,<br /><em>without the guesswork.</em></h1>
        <p>Pick every part yourself or let our AI shape a compatible build around your budget, games, and creative work.</p>
        <div className="hero-actions"><a className="primary" href="#builder">Start building <b>→</b></a><button className="text-button" onClick={openAi}>Ask the AI <span>✦</span></button></div>
        <div className="trust"><span>✓ Compatibility checked</span><span>✓ Bangladesh pricing</span><span>✓ No hidden fees</span></div>
      </section>

      <section className="builder-shell" id="builder">
        <div className="builder-head">
          <div><div className="step">BUILD 01</div><h2>Choose your components</h2><p>Start anywhere. We’ll keep an eye on compatibility.</p></div>
          <div className="progress-box"><span>{Object.keys(selected).length} of {categories.length} selected</span><div className="progress"><i style={{ width: `${progress}%` }} /></div></div>
        </div>

        <div className="builder-grid">
          <div className="component-list">
            {categories.map((category, index) => {
              const item = selected[category.key];
              return <button className={`component-row ${item ? "chosen" : ""}`} key={category.key} onClick={() => { setActive(category.key); setSearch(""); }}>
                <span className="index">{String(index + 1).padStart(2, "0")}</span><span className="part-mark">{category.mark}</span>
                <span className="part-copy"><strong>{item?.name ?? category.label}</strong><small>{item ? item.description : category.hint}</small></span>
                {item ? <span className="row-price">{money(item.price)}<small>Change</small></span> : <span className="add">+</span>}
              </button>;
            })}
          </div>

          <aside className="summary">
            <div className="summary-label">YOUR BUILD</div><h3>{total ? "A solid start." : "Make it yours."}</h3>
            <p>{total ? "Every selected component is saved in this build." : "Select your first component to begin. Your running total and compatibility notes will appear here."}</p>
            <div className="summary-stat"><span>Estimated power</span><b>{selected.gpu ? "410 W" : "—"}</b></div>
            <div className="summary-stat"><span>Compatibility</span><b className="good">{Object.keys(selected).length > 1 ? "✓ Looks good" : "Pending"}</b></div>
            <div className="total"><span>Build total<small>VAT included where applicable</small></span><strong>{money(total)}</strong></div>
            <button className="checkout" disabled={!total} onClick={() => void reviewBuild()}>Review build <span>→</span></button>
            {cartError && <p className="summary-error">{cartError}</p>}
            <button className="ai-button" onClick={openAi}><span>✦</span><span><b>Need a hand?</b><small>Let AI complete this build</small></span><b>→</b></button>
          </aside>
        </div>
      </section>

      <section className="how" id="about"><div><div className="step">ABOUT US</div><h2>From idea to checkout,<br />with confidence.</h2><p>NexRig helps people in Bangladesh plan a complete PC using real catalog products, clear pricing, and practical component guidance.</p></div><div className="how-grid"><article><b>01</b><h3>Tell us your goal</h3><p>Gaming, editing, study—or a little of everything.</p></article><article><b>02</b><h3>Build with all computer components</h3><p>Choose every essential component for a complete PC in one place.</p></article><article><b>03</b><h3>Buy when ready</h3><p>Review live pricing, stock, and every selected specification.</p></article></div></section>

      <section className="data-note" id="data"><span>LIVE DATA, CLEARLY SOURCED</span><p>Initial catalog information is collected from public Ryans Computers component pages. Prices can change without notice; verify them at the source before purchase.</p><a href="https://www.ryans.com/pc-builder" target="_blank" rel="noreferrer">View source ↗</a></section>

      {active && <div className="modal-backdrop" onMouseDown={() => setActive(null)}><section className="picker" role="dialog" aria-modal="true" aria-label={`Select ${active}`} onMouseDown={(e) => e.stopPropagation()}>
        <header><div><div className="step">SELECT COMPONENT</div><h2>{categories.find((c) => c.key === active)?.label}</h2></div><button aria-label="Close" onClick={() => setActive(null)}>×</button></header>
        <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products…" aria-label="Search products" />
        <div className="product-list">
          {loadingProducts && <p className="picker-message">Loading products from PostgreSQL…</p>}
          {productError && <p className="picker-message error">{productError}</p>}
          {!loadingProducts && !productError && activeProducts.length === 0 && <p className="picker-message">No matching products found.</p>}
          {activeProducts.map((product) => <article key={product.id}><div className="product-mark">{categories.find((c) => c.key === active)?.mark}</div><div><h3>{product.name}</h3><p>{product.description}</p><a href={product.sourceUrl} target="_blank" rel="noreferrer">Ryans source ↗</a></div><strong>{money(product.price)}</strong><button onClick={() => { setSelected((current) => ({ ...current, [active]: product })); setActive(null); }}>Select</button></article>)}
        </div>
      </section></div>}
      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} />}
      {adminOpen && <AdminProducts categories={categories} onClose={() => setAdminOpen(false)} onCatalogChanged={(dataCategory) => {
        const match = categories.find((item) => item.dataCategory === dataCategory);
        if (match) setProducts((current) => { const next = { ...current }; delete next[match.key]; return next; });
      }} />}
      {cartOpen && <CartCheckout onClose={() => setCartOpen(false)} onRemoved={(productId) => setSelected((current) => Object.fromEntries(Object.entries(current).filter(([, product]) => product?.id !== productId)) as Partial<Record<ComponentKey, Product>>)} />}
      {aiOpen && <AiChat authenticated={Boolean(user)} guestSessionId={guestAiSession} guestUsed={guestAiUsed} onGuestUsed={() => setGuestAiUsed(true)} onRequireLogin={() => { setAiOpen(false); setAuthOpen(true); }} onClose={() => setAiOpen(false)} onApplyBuild={(build) => applyAiBuild(build as Product[])} />}
    </main>
  );
}
