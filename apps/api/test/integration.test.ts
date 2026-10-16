import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getPlatformProxy } from "wrangler";
import { buscar, runTool, type ToolCtx } from "../src/agent/tools";
import type { Env } from "../src/env";
import { buildConfig } from "../src/plugins";
import { woocommerce } from "../src/plugins/woocommerce";
import { resolveOrder } from "../src/services/orders";
import { applyStock } from "../src/services/stock";
import { syncTenant } from "../src/services/sync";

// Base D1 y R2 reales (locales, en un directorio temporal) con el esquema de las migraciones.
let env: Env;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const proxy = await getPlatformProxy<Env>({ configPath: "wrangler.toml", persist: { path: mkdtempSync(join(tmpdir(), "wa-agent-")) } });
  dispose = proxy.dispose;
  env = { ...proxy.env, SESSION_SECRET: "s".repeat(40) } as Env;
  const sql = readFileSync("migrations/0001_init.sql", "utf8");
  for (const stmt of sql.split(/;\s*\n/).map((s) => s.replace(/--.*$/gm, "").trim()).filter(Boolean)) await env.DB.prepare(stmt).run();
}, 60_000);

afterAll(async () => { await dispose?.(); });
afterEach(() => vi.unstubAllGlobals());

const mkTenant = async (id: string) => {
  await env.DB.prepare("INSERT INTO tenants (id, name) VALUES (?, ?)").bind(id, id).run();
  await env.DB.prepare("INSERT INTO agent_config (tenant_id, schedule, shipping) VALUES (?, '{}', '{}')").bind(id).run();
  const k = await env.DB.prepare("INSERT INTO contacts (tenant_id, wa_id) VALUES (?, '593999')").bind(id).run();
  const c = await env.DB.prepare("INSERT INTO conversations (tenant_id, contact_id) VALUES (?, ?)").bind(id, k.meta.last_row_id).run();
  convOf.set(id, Number(c.meta.last_row_id));
};
const convOf = new Map<string, number>();

const ctxFor = (tenantId: string, over: Partial<ToolCtx> = {}): ToolCtx => ({
  env, tenantId, wa: { phoneNumberId: "1", token: "t" }, mediaBase: "https://x/media", waId: "593999", conversationId: convOf.get(tenantId) ?? 0,
  shipping: { freeZones: [], freePrice: 0, pichinchaZones: [], pichinchaPrice: 0, nationalPrice: 5 },
  bankDetails: "Banco X 123", cardInstructions: "", notifyPhone: null, ageSizeMap: false, currency: "USD", ...over,
});

const addProduct = async (tenant: string, name: string, cats: string, variants: [string, number, number][], source = "manual", ext: string | null = null) => {
  const r = await env.DB.prepare("INSERT INTO products (tenant_id, source, external_id, sku, name, categories) VALUES (?,?,?,?,?,?)").bind(tenant, source, ext, name.slice(0, 3), name, cats).run();
  const id = Number(r.meta.last_row_id);
  for (const [i, [size, stock, price]] of variants.entries()) {
    await env.DB.prepare("INSERT INTO variants (product_id, external_id, size, stock, price) VALUES (?,?,?,?,?)").bind(id, ext ? `${ext}${i}` : null, size, stock, price).run();
  }
  return id;
};

describe("catálogo propio (sin plugins)", () => {
  it("buscar: filtra por texto, variante y stock; no mezcla tenants", async () => {
    await mkTenant("a"); await mkTenant("b");
    const vestido = await addProduct("a", "Vestido lino", "niña | vestido", [["8", 2, 40], ["10", 0, 42]]);
    await addProduct("a", "Camisa azul", "niño", [["M", 5, 25]]);
    await addProduct("b", "Vestido ajeno", "vestido", [["8", 9, 10]]);

    const r1 = await buscar(ctxFor("a"), { consulta: "vestidos" });
    expect(r1.productos.map((p) => p.product_id)).toEqual([vestido]);
    expect((await buscar(ctxFor("a"), { consulta: "vestido", edad_o_talla: "talla 10" })).productos).toEqual([]); // 10 sin stock
    expect((await buscar(ctxFor("a"), { edad_o_talla: "talla M" })).productos.map((p) => p.nombre)).toEqual(["Camisa azul"]);
    expect((await buscar(ctxFor("a"), { precio_max: 30 })).productos.map((p) => p.nombre)).toEqual(["Camisa azul"]);
    // con mapeo edad→talla activado, "8 años" encuentra la talla "8"
    expect((await buscar(ctxFor("a", { ageSizeMap: true }), { edad_o_talla: "8 años" })).productos.map((p) => p.nombre)).toEqual(["Vestido lino"]);
  });

  it("crear_pedido: reserva stock, valida métodos, rechaza y devuelve stock", async () => {
    await mkTenant("c");
    const p = await addProduct("c", "Zapato", "calzado", [["40", 2, 50]]);
    const v = (await env.DB.prepare("SELECT id FROM variants WHERE product_id = ?").bind(p).first<{ id: number }>())!.id;
    const stock = async () => (await env.DB.prepare("SELECT stock FROM variants WHERE id = ?").bind(v).first<{ stock: number }>())!.stock;
    const args = { items: [{ product_id: p, talla: "40", cantidad: 1 }], nombre: "Ana Pérez", direccion: "Calle 1", ciudad: "Quito", metodo: "transferencia" };

    // tarjeta sin link configurado ni plugin -> no se crea nada
    expect(await runTool(ctxFor("c"), "crear_pedido", { ...args, metodo: "tarjeta" })).toMatchObject({ error: expect.stringContaining("tarjeta") });
    expect(await stock()).toBe(2);

    const ok = await runTool(ctxFor("c"), "crear_pedido", args);
    expect(ok).toMatchObject({ total: 55, datos_bancarios: "Banco X 123" }); // 50 + envío nacional 5
    expect(await stock()).toBe(1);

    const card = await runTool(ctxFor("c", { cardInstructions: "Paga en https://pay.test/c" }), "crear_pedido", { ...args, metodo: "tarjeta" });
    expect(card).toMatchObject({ link_de_pago: "Paga en https://pay.test/c" });
    expect(await stock()).toBe(0);
    expect(await runTool(ctxFor("c"), "crear_pedido", args)).toMatchObject({ error: expect.stringContaining("Sin stock") });

    // un tenant ajeno no puede pedir productos de otro
    await mkTenant("d");
    expect(await runTool(ctxFor("d"), "crear_pedido", args)).toMatchObject({ error: expect.stringContaining("Sin stock") });

    const { results: orders } = await env.DB.prepare("SELECT id, status, source FROM orders WHERE tenant_id = 'c' ORDER BY id").all<{ id: number; status: string; source: string }>();
    expect(orders.map((o) => o.status)).toEqual(["por_confirmar", "pendiente_pago"]);
    expect(await resolveOrder(env, "d", orders[0].id, "reject")).toMatchObject({ ok: false, status: 404 }); // otro tenant
    expect(await resolveOrder(env, "c", orders[0].id, "reject")).toEqual({ ok: true });
    expect(await stock()).toBe(1); // se devolvió la unidad
    expect(await resolveOrder(env, "c", orders[0].id, "reject")).toMatchObject({ ok: false, status: 409 });
  });

  it("applyStock en catálogo propio y variantes de otro tenant", async () => {
    await mkTenant("e"); await mkTenant("f");
    const p = await addProduct("e", "Gorra", "accesorios", [["U", 1, 9]]);
    const v = (await env.DB.prepare("SELECT id FROM variants WHERE product_id = ?").bind(p).first<{ id: number }>())!.id;
    expect(await applyStock(env, "f", [{ variant_id: v, stock: 50 }])).toEqual([{ id: v, ok: false, error: "variante no encontrada" }]);
    expect(await applyStock(env, "e", [{ variant_id: v, stock: 4.9 }])).toEqual([{ id: v, ok: true, stock: 4 }]);
  });
});

describe("plugin WooCommerce de punta a punta (Woo simulado)", () => {
  const woo = { products: [
    { id: 100, sku: "VL", name: "Vestido Woo", type: "variable", description: "", short_description: "<p>Lindo</p>", permalink: "https://t.test/v", categories: [{ name: "Vestidos" }], images: [], price: "40", regular_price: "40", sale_price: "", stock_quantity: null, stock_status: "instock" },
    { id: 200, sku: "GO", name: "Gorro Woo", type: "simple", description: "", short_description: "", permalink: "https://t.test/g", categories: [], images: [], price: "9", regular_price: "9", sale_price: "7", stock_quantity: 4, stock_status: "instock" },
  ], variations: [
    { id: 101, regular_price: "40", sale_price: "", price: "40", stock_quantity: 2, stock_status: "instock", attributes: [{ name: "Talla", option: "8" }] },
    { id: 102, regular_price: "40", sale_price: "", price: "40", stock_quantity: 0, stock_status: "outofstock", attributes: [{ name: "Talla", option: "10" }] },
  ] };
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let wooVars = woo.variations;

  const stubWoo = () => vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body as string) : undefined });
    const path = url.split("/wp-json/wc/v3")[1];
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (path.startsWith("/products?per_page=50&page=1")) return json(woo.products);
    if (path.startsWith("/products?per_page=50")) return json([]);
    if (path.startsWith("/products/100/variations?")) return json(wooVars);
    if (path.startsWith("/products/100/variations/batch")) return json({ update: (init.body ? JSON.parse(init.body as string).update : []).map((u: { id: number }) => ({ id: u.id })) });
    if (path === "/orders" && init.method === "POST") return json({ id: 900, payment_url: "https://t.test/pay/900" });
    if (path === "/orders/900") return json({ status: init.method === "PUT" ? "processing" : "processing" });
    if (path.startsWith("/products/200/variations")) return json({});
    if (path === "/products/200") return json({ stock_quantity: 4, stock_status: "instock" });
    if (path.startsWith("/products/100/variations/101")) return json({ stock_quantity: 2, stock_status: "instock" });
    return new Response("not found", { status: 404 });
  }));

  it("sincroniza (idempotente), vende con link, y cambia stock en la tienda", async () => {
    await mkTenant("w");
    const config = await buildConfig(env, woocommerce, { baseUrl: "https://t.test", consumerKey: "ck", consumerSecret: "cs" }, {});
    await env.DB.prepare("INSERT INTO tenant_plugins (tenant_id, plugin_id, config) VALUES ('w','woocommerce',?)").bind(JSON.stringify(config)).run();
    stubWoo();

    expect(await syncTenant(env, "w")).toEqual([{ plugin: "woocommerce", products: 2, variants: 3 }]);
    const ids = async () => (await env.DB.prepare("SELECT v.id, v.size, v.stock, p.name FROM variants v JOIN products p ON p.id = v.product_id WHERE p.tenant_id='w' ORDER BY v.id").all<{ id: number; size: string; stock: number; name: string }>()).results;
    const first = await ids();
    expect(first.map((v) => [v.name, v.size, v.stock])).toEqual([["Vestido Woo", "8", 2], ["Vestido Woo", "10", 0], ["Gorro Woo", "Única", 4]]);
    await syncTenant(env, "w");
    expect((await ids()).map((v) => v.id)).toEqual(first.map((v) => v.id)); // los ids locales no cambian entre sincronizaciones
    expect((await env.DB.prepare("SELECT last_error, last_sync_at FROM tenant_plugins WHERE tenant_id='w'").first<{ last_error: string | null; last_sync_at: string }>())).toMatchObject({ last_error: null });

    // El agente vende por tarjeta: se crea el pedido en Woo y se entrega el link
    const vestido = (await env.DB.prepare("SELECT id FROM products WHERE tenant_id='w' AND external_id='100'").first<{ id: number }>())!.id;
    calls.length = 0;
    const r = await runTool(ctxFor("w"), "crear_pedido", { items: [{ product_id: vestido, talla: "8" }], nombre: "Ana", direccion: "x", ciudad: "Quito", metodo: "tarjeta" });
    expect(r).toMatchObject({ pedido: "900", link_de_pago: "https://t.test/pay/900", total: 45 });
    const created = calls.find((c) => c.method === "POST" && c.url.endsWith("/orders"))!;
    expect(created.body).toMatchObject({ status: "pending", line_items: [{ product_id: 100, variation_id: 101, quantity: 1 }] });
    expect(await env.DB.prepare("SELECT source, external_id, status FROM orders WHERE tenant_id='w'").first()).toEqual({ source: "woocommerce", external_id: "900", status: "pendiente_pago" });

    // Woo lo marca pagado -> el cron lo confirma
    await syncTenant(env, "w");
    expect((await env.DB.prepare("SELECT status FROM orders WHERE tenant_id='w'").first<{ status: string }>())!.status).toBe("confirmado");

    // Cambiar stock desde el CRM va primero a Woo y luego a la copia local
    calls.length = 0;
    const v10 = first[1].id;
    expect(await applyStock(env, "w", [{ variant_id: v10, stock: 6 }])).toEqual([{ id: v10, ok: true, stock: 6 }]);
    expect(calls.find((c) => c.url.endsWith("/products/100/variations/batch"))?.body).toMatchObject({ update: [{ id: 102, stock_quantity: 6, stock_status: "instock" }] });
    expect((await env.DB.prepare("SELECT stock FROM variants WHERE id = ?").bind(v10).first<{ stock: number }>())!.stock).toBe(6);

    // Si Woo ya no publica el producto, queda sin stock (no se borra)
    woo.products.pop();
    await syncTenant(env, "w");
    expect((await ids()).find((v) => v.name === "Gorro Woo")!.stock).toBe(0);
  });

  it("si Woo rechaza el cambio de stock, la copia local NO cambia", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 401 })));
    const v = (await env.DB.prepare("SELECT v.id, v.stock FROM variants v JOIN products p ON p.id=v.product_id WHERE p.tenant_id='w' AND v.size='8'").first<{ id: number; stock: number }>())!;
    const [res] = await applyStock(env, "w", [{ variant_id: v.id, stock: 99 }]);
    expect(res.ok).toBe(false);
    expect((await env.DB.prepare("SELECT stock FROM variants WHERE id = ?").bind(v.id).first<{ stock: number }>())!.stock).toBe(v.stock);
  });

  it("un plugin desactivado deja de actuar sobre sus productos", async () => {
    await env.DB.prepare("UPDATE tenant_plugins SET enabled = 0 WHERE tenant_id='w'").run();
    const v = (await env.DB.prepare("SELECT v.id FROM variants v JOIN products p ON p.id=v.product_id WHERE p.tenant_id='w' LIMIT 1").first<{ id: number }>())!.id;
    const [res] = await applyStock(env, "w", [{ variant_id: v, stock: 1 }]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("desactivado");
  });
});
