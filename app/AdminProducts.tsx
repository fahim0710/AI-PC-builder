import { type FormEvent, useEffect, useState } from "react";
import { auth } from "./firebase";

type Product = { id: string; name: string; price: number; description: string; category: string };
type Category = { label: string; dataCategory: string };

async function adminFetch(url: string, options: RequestInit = {}) {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("Please sign in again.");
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...options.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "Admin request failed.");
  }
  return response;
}

export function AdminProducts({ categories, onClose, onCatalogChanged }: {
  categories: Category[]; onClose: () => void; onCatalogChanged: (category: string) => void;
}) {
  const [category, setCategory] = useState(categories[0].dataCategory);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ name: "", description: "", price: "", imageUrl: "", sourceUrl: "" });

  const loadProducts = async () => {
    setLoading(true); setMessage("");
    try {
      const response = await fetch(`/api/products?category=${encodeURIComponent(category)}&limit=100`);
      const data = await response.json() as { products: Product[] };
      setProducts(data.products);
    } catch { setMessage("Could not load products."); }
    finally { setLoading(false); }
  };
  useEffect(() => { void loadProducts(); }, [category]);

  const addProduct = async (event: FormEvent) => {
    event.preventDefault(); setMessage("Adding product…");
    try {
      await adminFetch("/api/admin/products", { method: "POST", body: JSON.stringify({ ...form, category, price: Number(form.price) }) });
      setForm({ name: "", description: "", price: "", imageUrl: "", sourceUrl: "" });
      setMessage("Product added successfully."); onCatalogChanged(category); await loadProducts();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not add product."); }
  };

  const hideProduct = async (product: Product) => {
    if (!window.confirm(`Remove “${product.name}” from the customer catalog?`)) return;
    setMessage("Removing product…");
    try {
      await adminFetch(`/api/admin/products/${product.id}`, { method: "DELETE" });
      setProducts((current) => current.filter((item) => item.id !== product.id));
      onCatalogChanged(category); setMessage("Product removed from the catalog.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not remove product."); }
  };

  return <div className="modal-backdrop admin-backdrop" onMouseDown={onClose}>
    <section className="admin-modal" role="dialog" aria-modal="true" aria-label="Manage products" onMouseDown={(e) => e.stopPropagation()}>
      <header><div><div className="step">ADMIN CONTROL</div><h2>Manage products</h2></div><button aria-label="Close" onClick={onClose}>×</button></header>
      <div className="admin-layout">
        <form className="admin-form" onSubmit={addProduct}>
          <h3>Add a product</h3>
          <label>Category<select value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((item) => <option key={item.dataCategory}>{item.dataCategory}</option>)}</select></label>
          <label>Product name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} /></label>
          <label>Price (BDT)<input type="number" min="0" step="1" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} required /></label>
          <label>Description<textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label>Image URL <small>optional</small><input type="url" value={form.imageUrl} onChange={(e) => setForm({ ...form, imageUrl: e.target.value })} /></label>
          <label>Source URL <small>optional</small><input type="url" value={form.sourceUrl} onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })} /></label>
          <button className="auth-submit">Add product</button>
          {message && <p className="admin-message" role="status">{message}</p>}
        </form>
        <div className="admin-products"><h3>{category} products</h3>{loading ? <p>Loading…</p> : products.map((product) => <article key={product.id}><div><strong>{product.name}</strong><small>৳{product.price.toLocaleString("en-BD")}</small></div><button onClick={() => void hideProduct(product)}>Remove</button></article>)}</div>
      </div>
    </section>
  </div>;
}
