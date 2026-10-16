import { afterEach, describe, expect, it, vi } from "vitest";
import { searchTerms, variantTokens } from "../src/agent/search";
import { tzOffsetMinutes } from "../src/dashboard";
import { buildConfig, PLUGINS } from "../src/plugins";
import { woocommerce } from "../src/plugins/woocommerce";
import { variantLabel } from "../src/plugins/woocommerce/sync";
import type { PluginCtx } from "../src/plugins/types";

const env = { SESSION_SECRET: "s".repeat(40) } as never;
const ctx: PluginCtx = { env, tenantId: "t1", config: { baseUrl: "https://tienda.test", consumerKey: "ck", consumerSecret: "cs" } };

afterEach(() => vi.unstubAllGlobals());

describe("registro de plugins", () => {
  it("woocommerce implementa el contrato completo y declara sus credenciales", () => {
    const p = PLUGINS.woocommerce;
    for (const fn of ["test", "syncCatalog", "getLiveStock", "setStock", "createOrder", "refreshOrders", "setOrderStatus"] as const) expect(typeof p[fn]).toBe("function");
    expect(p.fields.filter((f) => f.type === "secret").map((f) => f.key)).toEqual(["consumerKey", "consumerSecret"]);
  });
});

describe("buildConfig", () => {
  it("cifra secretos, limpia la URL y conserva el secreto anterior si llega vacío", async () => {
    const first = await buildConfig(env, woocommerce, { baseUrl: "https://t.test///", consumerKey: "ck_a", consumerSecret: "cs_a" }, {});
    expect(first.baseUrl).toBe("https://t.test");
    expect(first.consumerKey.startsWith("enc:")).toBe(true);
    const again = await buildConfig(env, woocommerce, { baseUrl: "https://t.test", consumerKey: "", consumerSecret: "" }, first);
    expect(again.consumerKey).toBe(first.consumerKey);
  });
});

describe("variantLabel", () => {
  it("usa la talla; si no hay, junta las opciones", () => {
    expect(variantLabel([{ name: "Color", option: "Azul" }, { name: "Talla", option: "8" }])).toBe("8");
    expect(variantLabel([{ name: "Color", option: "Azul" }, { name: "Material", option: "Lino" }])).toBe("Azul / Lino");
    expect(variantLabel([])).toBeNull();
  });
});

describe("woocommerce (API simulada)", () => {
  const stub = (handler: (url: string, init: RequestInit) => unknown) =>
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => new Response(JSON.stringify(handler(url, init)), { status: 200 })));

  it("createOrder: tarjeta -> pending con link; transferencia -> on-hold; simple usa variation_id 0", async () => {
    let body: Record<string, unknown> = {};
    stub((_u, init) => { body = JSON.parse(init.body as string); return { id: 55, payment_url: "https://t.test/pay/55" }; });
    const card = await woocommerce.createOrder!(ctx, {
      items: [{ productExternalId: "10", variantExternalId: "10", quantity: 1 }, { productExternalId: "11", variantExternalId: "112", quantity: 2 }],
      name: "Ana Pérez", phone: "593999", address: "Calle 1", city: "Quito", shippingTotal: 3.5, method: "tarjeta",
    });
    expect(card).toEqual({ externalId: "55", paymentUrl: "https://t.test/pay/55" });
    expect(body.status).toBe("pending");
    expect(body.line_items).toEqual([{ product_id: 10, variation_id: 0, quantity: 1 }, { product_id: 11, variation_id: 112, quantity: 2 }]);
    await woocommerce.createOrder!(ctx, { items: [], name: "Ana", phone: "1", address: "x", city: "y", shippingTotal: 0, method: "transferencia" });
    expect(body.status).toBe("on-hold");
  });

  it("setStock: agrupa variaciones por producto y reporta errores por variante", async () => {
    const calls: string[] = [];
    stub((url) => { calls.push(url); return url.includes("/variations/batch") ? { update: [{ id: 112 }, { id: 113, error: { message: "no existe" } }] } : {}; });
    const r = await woocommerce.setStock!(ctx, [
      { productExternalId: "11", variantExternalId: "112", stock: 3 },
      { productExternalId: "11", variantExternalId: "113", stock: 0 },
      { productExternalId: "10", variantExternalId: "10", stock: 5 },
    ]);
    expect(r).toEqual(expect.arrayContaining([
      { variantExternalId: "112", ok: true }, { variantExternalId: "113", ok: false, error: "no existe" }, { variantExternalId: "10", ok: true },
    ]));
    expect(calls.filter((u) => u.includes("/variations/batch")).length).toBe(1);
  });

  it("refreshOrders traduce estados de Woo", async () => {
    const status: Record<string, string> = { "1": "processing", "2": "cancelled", "3": "on-hold" };
    stub((url) => ({ status: status[url.split("/orders/")[1]] }));
    const r = await woocommerce.refreshOrders!(ctx, [{ id: 1, externalId: "1" }, { id: 2, externalId: "2" }, { id: 3, externalId: "3" }]);
    expect(r).toEqual([{ id: 1, status: "confirmado" }, { id: 2, status: "rechazado" }]);
  });
});

describe("búsqueda del agente", () => {
  it("normaliza acentos, quita conectores y plurales", () => {
    expect(searchTerms("Vestidos de Bautizo para niña")).toEqual(["vestido", "bautizo", "nina"]);
    expect(variantTokens("talla M")).toEqual(["m"]);
  });
});

describe("tzOffsetMinutes", () => {
  it("Guayaquil -300, UTC 0, zona inválida 0", () => {
    expect(tzOffsetMinutes("America/Guayaquil")).toBe(-300);
    expect(tzOffsetMinutes("UTC")).toBe(0);
    expect(tzOffsetMinutes("No/Existe")).toBe(0);
  });
});
