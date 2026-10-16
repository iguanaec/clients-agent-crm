export interface ShippingConfig {
  /** Sectores con envío gratis (Quito y valles hasta Tumbaco). */
  freeZones: string[];
  freePrice: number;
  /** Resto de Pichincha. */
  pichinchaZones: string[];
  pichinchaPrice: number;
  /** Servientrega a nivel nacional. */
  nationalPrice: number;
}

/** Por defecto un negocio nuevo no cobra ni zonifica el envío; se configura en el CRM → Agente. */
export const DEFAULT_SHIPPING: ShippingConfig = {
  freeZones: [], freePrice: 0, pichinchaZones: [], pichinchaPrice: 0, nationalPrice: 0,
};

/** Plantilla de ejemplo (Quito / Pichincha / nacional) que el CRM ofrece como punto de partida. */
export const SHIPPING_PRESET_EC: ShippingConfig = {
  freeZones: ["quito", "cumbaya", "tumbaco", "puembo", "pifo", "tababela", "conocoto", "san rafael", "sangolqui", "los chillos", "guangopolo", "alangasi", "la armenia"],
  freePrice: 0,
  pichinchaZones: ["cayambe", "machachi", "mejia", "tabacundo", "pedro moncayo", "san miguel de los bancos", "pedro vicente maldonado", "puerto quito", "rumiñahui", "calacali", "nono", "pomasqui", "san antonio"],
  pichinchaPrice: 3.5,
  nationalPrice: 6,
};

export interface Quote {
  zone: "gratis" | "pichincha" | "nacional";
  price: number;
  carrier: string;
}

const normalize = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

const matches = (place: string, zones: string[]) =>
  zones.some((z) => place === normalize(z) || place.includes(normalize(z)));

export function quoteShipping(place: string, cfg: ShippingConfig = DEFAULT_SHIPPING): Quote {
  const p = normalize(place);
  if (matches(p, cfg.freeZones)) return { zone: "gratis", price: cfg.freePrice, carrier: "Entrega local" };
  if (matches(p, cfg.pichinchaZones)) return { zone: "pichincha", price: cfg.pichinchaPrice, carrier: "Entrega Pichincha" };
  return { zone: "nacional", price: cfg.nationalPrice, carrier: "Servientrega" };
}
