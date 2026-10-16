import { describe, expect, it } from "vitest";
import { searchTerms, variantTokens } from "../src/agent/search";
import { tzOffsetMinutes } from "../src/dashboard";
import { buildConfig } from "../src/plugins";
import type { CommercePlugin } from "../src/plugins/types";

const env = { SESSION_SECRET: "s".repeat(40) } as never;
const demo: CommercePlugin = {
  id: "demo", name: "Demo", description: "", fields: [
    { key: "baseUrl", label: "URL", type: "url", required: true },
    { key: "apiKey", label: "Clave", type: "secret", required: true },
  ],
};

describe("buildConfig (infraestructura de plugins)", () => {
  it("cifra secretos, limpia la URL y conserva el secreto anterior si llega vacío", async () => {
    const first = await buildConfig(env, demo, { baseUrl: "https://t.test///", apiKey: "k_a" }, {});
    expect(first.baseUrl).toBe("https://t.test");
    expect(first.apiKey.startsWith("enc:")).toBe(true);
    const again = await buildConfig(env, demo, { baseUrl: "https://t.test", apiKey: "" }, first);
    expect(again.apiKey).toBe(first.apiKey);
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
