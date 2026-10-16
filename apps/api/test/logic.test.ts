import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULE, isAgentActive } from "../src/agent/schedule";
import { DEFAULT_SHIPPING, quoteShipping, SHIPPING_PRESET_EC } from "../src/agent/shipping";
import { candidateSizes } from "../src/agent/sizes";

const TZ = "America/Guayaquil"; // UTC-5 todo el año
// 2026-10-07 es miércoles. Hora local HH:MM -> UTC = +5h.
const at = (iso: string, hhmm: string) => new Date(`${iso}T${hhmm}:00-05:00`);

describe("isAgentActive (17:00-08:00)", () => {
  it("activo en la noche y madrugada, inactivo de día", () => {
    expect(isAgentActive(DEFAULT_SCHEDULE, TZ, at("2026-10-07", "17:00"))).toBe(true);
    expect(isAgentActive(DEFAULT_SCHEDULE, TZ, at("2026-10-07", "23:59"))).toBe(true);
    expect(isAgentActive(DEFAULT_SCHEDULE, TZ, at("2026-10-08", "00:00"))).toBe(true);
    expect(isAgentActive(DEFAULT_SCHEDULE, TZ, at("2026-10-08", "07:59"))).toBe(true);
    expect(isAgentActive(DEFAULT_SCHEDULE, TZ, at("2026-10-08", "08:00"))).toBe(false);
    expect(isAgentActive(DEFAULT_SCHEDULE, TZ, at("2026-10-08", "12:00"))).toBe(false);
    expect(isAgentActive(DEFAULT_SCHEDULE, TZ, at("2026-10-08", "16:59"))).toBe(false);
  });

  it("el tramo de madrugada usa las ventanas del día anterior", () => {
    const s = {
      default: [{ start: "17:00", end: "08:00" }],
      byDay: { 6: [] }, // sábado sin bot
    };
    // viernes 2026-10-09 22:00 -> activo; sábado 10-10 03:00 usa viernes (activo)
    expect(isAgentActive(s, TZ, at("2026-10-09", "22:00"))).toBe(true);
    expect(isAgentActive(s, TZ, at("2026-10-10", "03:00"))).toBe(true);
    // sábado 22:00 -> sin ventanas; domingo 03:00 usa sábado (vacío)
    expect(isAgentActive(s, TZ, at("2026-10-10", "22:00"))).toBe(false);
    expect(isAgentActive(s, TZ, at("2026-10-11", "03:00"))).toBe(false);
  });

  it("ventana diurna normal", () => {
    const s = { default: [{ start: "09:00", end: "13:00" }] };
    expect(isAgentActive(s, TZ, at("2026-10-07", "10:00"))).toBe(true);
    expect(isAgentActive(s, TZ, at("2026-10-07", "13:00"))).toBe(false);
  });
});

describe("quoteShipping", () => {
  it("un negocio nuevo no cobra envío hasta configurarlo", () => {
    expect(quoteShipping("Quito", DEFAULT_SHIPPING).price).toBe(0);
  });
  it("Quito y valles hasta Tumbaco gratis", () => {
    expect(quoteShipping("Quito", SHIPPING_PRESET_EC).price).toBe(0);
    expect(quoteShipping("Tumbaco", SHIPPING_PRESET_EC).price).toBe(0);
    expect(quoteShipping("Cumbayá", SHIPPING_PRESET_EC).zone).toBe("gratis");
  });
  it("resto de Pichincha $3,50", () => {
    expect(quoteShipping("Cayambe", SHIPPING_PRESET_EC)).toMatchObject({ zone: "pichincha", price: 3.5 });
  });
  it("nacional Servientrega $6", () => {
    expect(quoteShipping("Guayaquil", SHIPPING_PRESET_EC)).toMatchObject({ zone: "nacional", price: 6, carrier: "Servientrega" });
  });
});

describe("candidateSizes", () => {
  it("años", () => {
    expect(candidateSizes("niña de 8 años")).toEqual(["8", "10"]);
    expect(candidateSizes("talla 14")).toEqual(["14", "16"]);
  });
  it("meses", () => {
    expect(candidateSizes("6 meses")).toEqual(["6M", "9M"]);
    expect(candidateSizes("2 meses")).toEqual(["3M", "6M"]);
  });
  it("sin dato", () => {
    expect(candidateSizes("algo bonito")).toEqual([]);
  });
});
