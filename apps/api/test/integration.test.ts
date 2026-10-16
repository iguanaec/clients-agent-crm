import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { buscar, runTool, type ToolCtx } from "../src/agent/tools";
import type { Env } from "../src/env";
import { resolveOrder } from "../src/services/orders";
import { applyStock } from "../src/services/stock";

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

describe("catálogo propio", () => {
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

describe("WhatsApp coexistente: el CRM ve todo aunque el agente esté apagado", () => {
  const payload = (field: string, value: Record<string, unknown>) => ({ entry: [{ changes: [{ field, value: { metadata: { phone_number_id: "555001" }, ...value } }] }] });
  const rows = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).all<Record<string, unknown>>().then((r) => r.results);

  it("mensaje entrante y eco del celular se guardan; el agente apagado no responde; el eco pausa al bot", async () => {
    await mkTenant("co");
    await env.DB.prepare("UPDATE tenants SET wa_phone_number_id = '555001' WHERE id = 'co'").run();
    // enabled = 0 es el valor por defecto del esquema
    expect((await env.DB.prepare("SELECT enabled FROM agent_config WHERE tenant_id='co'").first<{ enabled: number }>())!.enabled).toBe(0);

    const { handleWebhook } = await import("../src/whatsapp/webhook");
    const calls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: string) => { calls.push(String(u)); return new Response("{}", { status: 200 }); }) as typeof fetch;
    try {
      await handleWebhook(env, payload("messages", { contacts: [{ wa_id: "593911", profile: { name: "Luisa" } }], messages: [{ id: "wamid.IN1", from: "593911", type: "text", text: { body: "Hola, ¿tienen vestidos?" } }] }), "https://x");
      // el mismo mensaje reenviado por Meta no se duplica
      await handleWebhook(env, payload("messages", { messages: [{ id: "wamid.IN1", from: "593911", type: "text", text: { body: "Hola, ¿tienen vestidos?" } }] }), "https://x");
      await handleWebhook(env, payload("smb_message_echoes", { message_echoes: [{ id: "wamid.ECHO1", to: "593911", type: "text", text: { body: "Hola Luisa, sí tenemos" } }] }), "https://x");
    } finally { globalThis.fetch = orig; }

    expect(calls).toEqual([]); // ninguna llamada a Gemini ni a Meta: el agente está apagado
    const msgs = await rows("SELECT m.direction, m.author, m.body FROM messages m JOIN conversations v ON v.id=m.conversation_id WHERE v.tenant_id='co' ORDER BY m.id");
    expect(msgs).toEqual([
      { direction: "in", author: "cliente", body: "Hola, ¿tienen vestidos?" },
      { direction: "out", author: "app", body: "Hola Luisa, sí tenemos" },
    ]);
    const conv = (await rows("SELECT bot_paused_until, state FROM conversations WHERE tenant_id='co'"))[0];
    expect(conv.bot_paused_until).toBeTruthy(); // el eco desde el celular pausa al bot en ese chat
    expect((await rows("SELECT name FROM contacts WHERE tenant_id='co'"))[0].name).toBe("Luisa");
  });

  it("un número desconocido no crea nada", async () => {
    const { handleWebhook } = await import("../src/whatsapp/webhook");
    await handleWebhook(env, { entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "999" }, messages: [{ id: "wamid.X", from: "1", type: "text", text: { body: "hi" } }] } }] }] }, "https://x");
    expect(await rows("SELECT 1 FROM messages WHERE wa_message_id = 'wamid.X'")).toEqual([]);
  });
});
