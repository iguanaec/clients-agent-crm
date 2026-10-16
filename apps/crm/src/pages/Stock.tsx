import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, del, money, post, productImg, put, toJpeg, type PluginInfo, type Product, type Variant } from "../api";

type Filter = "todos" | "bajo" | "agotado" | "oculto" | "mas_vendidos";
type Save = "saving" | "ok" | "error";

const sizeOrder = (s: string) => {
  const m = s.match(/^(\d+)M$/i);
  if (m) return Number(m[1]) / 100; // meses primero: 0M < 3M < ... < 24M
  const n = Number(s);
  return Number.isFinite(n) ? n : 999;
};
const total = (p: Product) => p.variants.reduce((a, v) => a + Math.max(0, v.stock), 0);
const tone = (n: number) => (n <= 0 ? "out" : n <= 2 ? "low" : "ok");

function csvEscape(s: string | number) {
  const t = String(s);
  return /[",\n;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** Lector CSV mínimo: acepta coma o punto y coma, y comillas. */
function parseCsv(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function VariantRow({ v, state, onSave, dest }: { v: Variant; state?: Save; onSave: (stock: number) => void; dest: string }) {
  const [val, setVal] = useState(String(v.stock));
  useEffect(() => setVal(String(v.stock)), [v.stock]);
  const commit = (n: number) => { const x = Math.max(0, Math.floor(n)); setVal(String(x)); if (x !== v.stock) onSave(x); };
  return (
    <div className={`vrow ${tone(v.stock)}`}>
      <span className="vsize">{v.size}</span>
      <button onClick={() => commit(Number(val) - 1)} aria-label="Restar uno">−</button>
      <input type="number" min={0} value={val} onChange={(e) => setVal(e.target.value)}
        onBlur={() => commit(Number(val))} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
      <button onClick={() => commit(Number(val) + 1)} aria-label="Sumar uno">＋</button>
      <button className="link" onClick={() => commit(0)}>Agotar</button>
      <span className="vprice">{v.sale_price ? <><s>{money(v.price)}</s> {money(v.sale_price)}</> : money(v.price)}</span>
      <span className={`vstate ${state ?? ""}`}>{state === "saving" ? "Guardando…" : state === "ok" ? `✓ Guardado${dest}` : state === "error" ? "No se guardó" : ""}</span>
    </div>
  );
}

/** Alta de un producto del catálogo propio. */
function NewProduct({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ name: "", sku: "", categories: "", description: "" });
  const [vs, setVs] = useState([{ size: "Única", stock: "1", price: "" }]);
  const [err, setErr] = useState("");
  const save = async () => {
    if (!f.name.trim()) return setErr("Falta el nombre.");
    if (vs.some((v) => !(Number(v.price) >= 0) || v.price === "")) return setErr("Cada opción necesita precio.");
    try {
      await post("/products", { ...f, variants: vs.map((v) => ({ size: v.size, stock: Number(v.stock) || 0, price: Number(v.price) })) });
      onDone();
    } catch { setErr("No se pudo crear."); }
  };
  return (
    <div className="panel pform">
      <h3>Nuevo producto</h3>
      <div className="grid2">
        <input placeholder="Nombre *" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input placeholder="SKU / código" value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} />
      </div>
      <input placeholder="Categorías (separadas por |): niña | vestido" value={f.categories} onChange={(e) => setF({ ...f, categories: e.target.value })} />
      <textarea rows={2} placeholder="Descripción (el agente la usa para recomendar)" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      <strong className="small">Opciones (talla, color, presentación…)</strong>
      {vs.map((v, i) => (
        <div key={i} className="vedit" style={{ gridTemplateColumns: "1.4fr .7fr .7fr auto" }}>
          <input placeholder="Opción (ej. 8, M, Azul)" value={v.size} onChange={(e) => setVs(vs.map((x, j) => j === i ? { ...x, size: e.target.value } : x))} />
          <input type="number" min={0} placeholder="Stock" value={v.stock} onChange={(e) => setVs(vs.map((x, j) => j === i ? { ...x, stock: e.target.value } : x))} />
          <input type="number" min={0} step="0.01" placeholder="Precio" value={v.price} onChange={(e) => setVs(vs.map((x, j) => j === i ? { ...x, price: e.target.value } : x))} />
          <button className="link" disabled={vs.length === 1} onClick={() => setVs(vs.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div className="row tight">
        <button onClick={() => setVs([...vs, { size: "", stock: "1", price: vs[vs.length - 1]?.price ?? "" }])}>＋ Otra opción</button>
        <span className="spacer" />
        <button onClick={onDone}>Cancelar</button>
        <button className="primary" onClick={save}>Crear producto</button>
      </div>
      {err && <p className="err small">{err}</p>}
      <p className="muted small">Después de crearlo puedes subir las fotos desde su ficha.</p>
    </div>
  );
}

/** Edición completa de un producto del catálogo propio: datos, opciones, fotos. */
function ProductEditor({ p, reload }: { p: Product; reload: () => void }) {
  const [f, setF] = useState({ name: p.name, sku: p.sku ?? "", categories: p.categories ?? "", description: p.description ?? "", url: p.url ?? "" });
  const [err, setErr] = useState("");
  const [nv, setNv] = useState({ size: "", stock: "0", price: "" });
  const guard = async (fn: () => Promise<unknown>) => {
    setErr("");
    try { await fn(); reload(); } catch (e) {
      const code = (e as { code?: string }).code;
      setErr(code === "has_orders" ? "Tiene pedidos en el historial: mejor desmarca «El agente puede ofrecerlo»." : code === "max_photos" ? "Máximo 4 fotos." : "No se pudo guardar.");
    }
  };
  const photo = (file: File | undefined) => file && guard(async () => {
    const form = new FormData();
    form.append("file", new File([await toJpeg(file)], "foto.jpg", { type: "image/jpeg" }));
    await api(`/products/${p.id}/photos`, { method: "POST", body: form });
  });
  return (
    <div className="pform">
      <div className="grid2">
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Nombre" />
        <input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} placeholder="SKU" />
      </div>
      <input value={f.categories} onChange={(e) => setF({ ...f, categories: e.target.value })} placeholder="Categorías (separadas por |)" />
      <textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Descripción" />
      <input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="Enlace al producto (opcional)" />
      <div className="row tight"><button onClick={() => guard(() => put(`/products/${p.id}`, f))}>Guardar datos</button></div>

      <strong className="small">Opciones y precios</strong>
      {p.variants.map((v) => <VariantFields key={v.id} v={v} guard={guard} />)}
      <div className="vedit" style={{ gridTemplateColumns: "1.4fr .7fr .7fr auto" }}>
        <input placeholder="Nueva opción" value={nv.size} onChange={(e) => setNv({ ...nv, size: e.target.value })} />
        <input type="number" min={0} placeholder="Stock" value={nv.stock} onChange={(e) => setNv({ ...nv, stock: e.target.value })} />
        <input type="number" min={0} step="0.01" placeholder="Precio" value={nv.price} onChange={(e) => setNv({ ...nv, price: e.target.value })} />
        <button disabled={!nv.size.trim() || nv.price === ""} onClick={() => guard(async () => { await post(`/products/${p.id}/variants`, { size: nv.size, stock: Number(nv.stock), price: Number(nv.price) }); setNv({ size: "", stock: "0", price: "" }); })}>＋</button>
      </div>

      <strong className="small">Fotos (las que ve el cliente por WhatsApp)</strong>
      <div className="photos">
        {p.image_keys.map((k) => (
          <div key={k} className="ph-item"><img src={productImg(k)} alt="" /><button className="danger" title="Quitar" onClick={() => guard(() => del(`/products/${p.id}/photos`, { key: k }))}>✕</button></div>
        ))}
        {p.image_keys.length < 4 && <label className="button-like" style={{ margin: 0 }}>＋ Foto<input type="file" accept="image/*" hidden onChange={(e) => { photo(e.target.files?.[0]); e.target.value = ""; }} /></label>}
      </div>
      <div className="row tight">
        <span className="spacer" />
        <button className="danger" onClick={() => confirm(`¿Eliminar «${p.name}» del catálogo?`) && guard(() => del(`/products/${p.id}`))}>Eliminar producto</button>
      </div>
      {err && <p className="err small">{err}</p>}
    </div>
  );
}

function VariantFields({ v, guard }: { v: Variant; guard: (fn: () => Promise<unknown>) => void }) {
  const [f, setF] = useState({ size: v.size, price: String(v.price), sale: v.sale_price == null ? "" : String(v.sale_price) });
  return (
    <div className="vedit">
      <input value={f.size} onChange={(e) => setF({ ...f, size: e.target.value })} />
      <input type="number" min={0} step="0.01" value={f.price} title="Precio" onChange={(e) => setF({ ...f, price: e.target.value })} />
      <input type="number" min={0} step="0.01" value={f.sale} placeholder="Oferta" title="Precio de oferta" onChange={(e) => setF({ ...f, sale: e.target.value })} />
      <button onClick={() => guard(() => put(`/variants/${v.id}`, { size: f.size, price: Number(f.price), sale_price: f.sale === "" ? null : Number(f.sale) }))}>Guardar</button>
      <button className="link" title="Quitar opción" onClick={() => guard(() => del(`/variants/${v.id}`))}>✕</button>
    </div>
  );
}

export default function Stock() {
  const [items, setItems] = useState<Product[]>([]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("todos");
  const [open, setOpen] = useState<number | null>(null);
  const [saves, setSaves] = useState<Record<number, Save>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => api<Product[]>("/catalog").then(setItems), []);
  useEffect(() => { load(); api<PluginInfo[]>("/plugins").then(setPlugins).catch(() => {}); }, [load]);
  const syncable = plugins.filter((p) => p.installed && p.enabled && p.capabilities.sync);
  const pluginName = (id: string) => plugins.find((p) => p.id === id)?.name ?? id;

  const counts = useMemo(() => ({
    out: items.reduce((a, p) => a + p.variants.filter((v) => v.stock <= 0).length, 0),
    low: items.reduce((a, p) => a + p.variants.filter((v) => v.stock >= 1 && v.stock <= 2).length, 0),
    hidden: items.filter((p) => !p.agent_visible).length,
  }), [items]);

  const shown = useMemo(() => {
    const t = q.toLowerCase();
    let r = items.filter((p) => `${p.name} ${p.sku} ${p.categories ?? ""}`.toLowerCase().includes(t));
    if (filter === "bajo") r = r.filter((p) => p.variants.some((v) => v.stock >= 1 && v.stock <= 2));
    if (filter === "agotado") r = r.filter((p) => p.variants.some((v) => v.stock <= 0));
    if (filter === "oculto") r = r.filter((p) => !p.agent_visible);
    if (filter === "mas_vendidos") r = r.filter((p) => p.sold_30d > 0).sort((a, b) => b.sold_30d - a.sold_30d);
    return r;
  }, [items, q, filter]);

  const saveStock = async (p: Product, v: Variant, stock: number) => {
    setSaves((s) => ({ ...s, [v.id]: "saving" }));
    try {
      await put(`/variants/${v.id}/stock`, { stock });
      setItems((all) => all.map((x) => x.id !== p.id ? x : { ...x, variants: x.variants.map((y) => y.id === v.id ? { ...y, stock } : y) }));
      setSaves((s) => ({ ...s, [v.id]: "ok" }));
    } catch {
      setSaves((s) => ({ ...s, [v.id]: "error" }));
    }
    setTimeout(() => setSaves((s) => { const { [v.id]: _drop, ...rest } = s; return rest; }), 3000);
  };

  const toggleVisible = async (p: Product) => {
    const visible = !p.agent_visible;
    setItems((all) => all.map((x) => x.id === p.id ? { ...x, agent_visible: visible ? 1 : 0 } : x));
    await post(`/products/${p.id}/visible`, { visible });
  };

  const exhaust = async (p: Product) => {
    if (!confirm(`¿Poner en 0 todas las opciones de "${p.name}"?${p.source === "manual" ? "" : ` Se actualiza ${pluginName(p.source)}.`}`)) return;
    for (const v of p.variants) if (v.stock !== 0) await saveStock(p, v, 0);
  };

  const sync = async () => {
    setBusy(true); setNote("");
    try {
      const out: string[] = [];
      for (const p of syncable) {
        const r = await post<{ products: number; variants: number }>(`/plugins/${p.id}/sync`);
        out.push(`${p.name}: ${r.products} productos, ${r.variants} opciones`);
      }
      setNote(`Sincronizado — ${out.join(" · ")}.`);
      await load();
    } catch (e) { setNote(`Error al sincronizar: ${(e as Error).message}`); }
    setBusy(false);
  };

  const exportCsv = () => {
    const lines = [["sku", "producto", "talla", "stock", "precio", "categoria"].join(",")];
    for (const p of items) for (const v of [...p.variants].sort((a, b) => sizeOrder(a.size) - sizeOrder(b.size)))
      lines.push([p.sku ?? "", p.name, v.size, v.stock, v.price, p.categories ?? ""].map(csvEscape).join(","));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" }));
    a.download = `stock-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  const importCsv = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setNote("");
    try {
      const rows = parseCsv(await file.text());
      const head = rows[0].map((h) => h.trim().toLowerCase());
      const iSku = head.indexOf("sku"), iSize = head.findIndex((h) => h === "talla" || h === "size" || h === "opcion"), iStock = head.indexOf("stock");
      const iName = head.findIndex((h) => h === "producto" || h === "nombre" || h === "name"), iPrice = head.findIndex((h) => h === "precio" || h === "price"), iCat = head.findIndex((h) => h === "categoria" || h === "categorias");
      if (iSku < 0 || iSize < 0 || iStock < 0) throw new Error("El CSV debe tener las columnas sku, talla y stock (puedes exportar uno de ejemplo).");
      const data = rows.slice(1).map((r) => ({
        sku: r[iSku], size: r[iSize], stock: Number(r[iStock]),
        ...(iName >= 0 && iPrice >= 0 ? { name: r[iName], price: Number(String(r[iPrice]).replace(",", ".")), categories: iCat >= 0 ? r[iCat] : undefined } : {}),
      })).filter((r) => r.sku && r.size && Number.isFinite(r.stock));
      let updated = 0, created = 0; const problems: string[] = [];
      for (let i = 0; i < data.length; i += 40) {
        setNote(`Importando ${Math.min(i + 40, data.length)} de ${data.length}…`);
        const r = await post<{ updated: number; created: number; failed: { id: number; error?: string }[]; notFound: string[] }>("/stock/import", data.slice(i, i + 40));
        updated += r.updated; created += r.created;
        problems.push(...r.notFound.map((n) => `No existe: ${n}`), ...r.failed.map((f) => `Rechazó la variante ${f.id}: ${f.error ?? ""}`));
      }
      setNote(`Importación lista: ${updated} opciones actualizadas, ${created} nuevas.${problems.length ? ` Revisar: ${problems.slice(0, 5).join(" · ")}${problems.length > 5 ? ` (+${problems.length - 5})` : ""}` : ""}`);
      await load();
    } catch (e) { setNote(`Error: ${(e as Error).message}`); }
    setBusy(false);
  };

  return (
    <div className="stock">
      <div className="dash-head">
        <h2>Catálogo y stock</h2>
        <div className="row tight">
          <button className="primary" onClick={() => setCreating(true)}>＋ Nuevo producto</button>
          {syncable.length > 0 && <button disabled={busy} onClick={sync}>{busy ? "Trabajando…" : `Sincronizar (${syncable.map((p) => p.name).join(", ")})`}</button>}
          <button onClick={exportCsv}>Exportar CSV</button>
          <button disabled={busy} onClick={() => fileRef.current?.click()}>Importar CSV</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => { importCsv(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
      </div>
      <p className="muted small">El stock que cambies aquí lo usa el agente de inmediato{syncable.length ? ` y se guarda en ${syncable.map((p) => p.name).join(", ")}` : ""}. El CSV necesita <code>sku, talla, stock</code>; con <code>producto, precio</code> (y <code>categoria</code>) también crea productos nuevos.</p>
      {note && <p className="note">{note}</p>}
      {creating && <NewProduct onDone={() => { setCreating(false); load(); }} />}

      <div className="row tight wrap">
        <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nombre, SKU o categoría" />
        <div className="seg">
          {([["todos", `Todos (${items.length})`], ["bajo", `Stock bajo (${counts.low})`], ["agotado", `Con agotados (${counts.out})`], ["mas_vendidos", "Más vendidos"], ["oculto", `Ocultos (${counts.hidden})`]] as [Filter, string][]).map(([k, label]) => (
            <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
      </div>

      <div className="plist">
        {shown.map((p) => (
          <div key={p.id} className={`prod ${p.agent_visible ? "" : "hidden"}`}>
            <div className="prow" onClick={() => setOpen(open === p.id ? null : p.id)}>
              {p.image ? <img src={productImg(p.image)} alt="" loading="lazy" /> : <div className="ph thumb" />}
              <div className="pinfo">
                <strong>{p.name}</strong>
                <small className="muted">{p.source !== "manual" && <span className="srcpill">{pluginName(p.source)}</span>} {p.sku}{p.categories ? ` · ${p.categories}` : ""}{p.sold_30d ? ` · ${p.sold_30d} vendidas en 30 días` : ""}</small>
                <div className="chips">
                  {[...p.variants].sort((a, b) => sizeOrder(a.size) - sizeOrder(b.size)).map((v) => <span key={v.id} className={`chip ${tone(v.stock)}`}>{v.size}: {v.stock}</span>)}
                </div>
              </div>
              <div className="ptotal"><strong>{total(p)}</strong><small>unidades</small></div>
            </div>
            {open === p.id && (
              <div className="pedit">
                {[...p.variants].sort((a, b) => sizeOrder(a.size) - sizeOrder(b.size)).map((v) => (
                  <VariantRow key={v.id} v={v} state={saves[v.id]} onSave={(n) => saveStock(p, v, n)} dest={p.source === "manual" ? "" : ` en ${pluginName(p.source)}`} />
                ))}
                <div className="row tight pfoot">
                  <label className="check"><input type="checkbox" checked={!!p.agent_visible} onChange={() => toggleVisible(p)} /> El agente puede ofrecerlo por WhatsApp</label>
                  <span className="spacer" />
                  {p.url && <a href={p.url} target="_blank" rel="noreferrer">Ver en la tienda ↗</a>}
                  <button className="danger" onClick={() => exhaust(p)}>Agotar todas las opciones</button>
                </div>
                {p.source === "manual"
                  ? <ProductEditor p={p} reload={load} />
                  : <p className="muted small">Nombre, precio y fotos se editan en {pluginName(p.source)}; aquí se cambia el stock y la visibilidad para el agente.</p>}
              </div>
            )}
          </div>
        ))}
        {!shown.length && <p className="muted pad">{items.length ? "Ningún producto coincide con el filtro." : "Aún no hay productos. Crea el primero con «Nuevo producto», impórtalos por CSV o instala un plugin en Integraciones."}</p>}
      </div>
    </div>
  );
}
