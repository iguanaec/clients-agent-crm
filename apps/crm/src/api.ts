const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin storage */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* sin storage */ } },
};

export const session = {
  get base() { return store.get("crm_base") ?? import.meta.env.VITE_API_URL ?? ""; },
  get token() { return store.get("crm_token") ?? ""; },
  save(base: string, token: string) { if (base) store.set("crm_base", base.replace(/\/$/, "")); store.set("crm_token", token); },
  clear() { store.del("crm_token"); },
};

/** Zona horaria del negocio (la entrega /me al iniciar sesión); se usa para mostrar horas. */
export const biz = { timezone: "America/Guayaquil", currency: "USD" };

export interface ConnStatus { connected: boolean; display_phone: string | null; agent_enabled: boolean }
export interface Me {
  user: { id: number; email: string; name: string | null; role: "owner" | "agent" };
  tenant: { id: string; name: string; timezone: string; currency: string };
}

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(body);
  }
  get code(): string {
    try { return (JSON.parse(this.body) as { error?: string }).error ?? this.body; } catch { return this.body; }
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isForm = init.body instanceof FormData;
  const res = await fetch(`${session.base}/api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${session.token}`, ...(isForm ? {} : { "Content-Type": "application/json" }), ...(init.headers ?? {}) },
  });
  if (res.status === 401 && !path.startsWith("/auth/")) { session.clear(); location.reload(); }
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json() as Promise<T>;
}

export const post = <T,>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const put = <T,>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const del = <T,>(path: string, body?: unknown) =>
  api<T>(path, { method: "DELETE", body: body === undefined ? undefined : JSON.stringify(body) });

export async function mediaUrl(key: string): Promise<string> {
  const res = await fetch(`${session.base}/api/media/${key}`, { headers: { Authorization: `Bearer ${session.token}` } });
  return URL.createObjectURL(await res.blob());
}

/** Convierte cualquier imagen del navegador (webp, png, jpg) a JPEG de hasta 1600 px: WhatsApp no acepta webp. */
export async function toJpeg(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("No se pudo convertir la imagen"))), "image/jpeg", 0.88));
}

/** Fotos del catálogo: públicas en el propio Worker, sin token. */
export const productImg = (key: string | null) => (key ? `${session.base}/media/${key}` : "");

export interface Conversation {
  id: number; state: "bot" | "humano" | "cerrada"; bot_paused_until: string | null; last_message_at: string;
  wa_id: string; name: string | null; last_body: string | null; last_type: string | null; unread: number; last_in: string | null;
}
export interface Message { id: number; direction: "in" | "out"; author: "cliente" | "bot" | "humano" | "app"; type: string; body: string | null; media_key: string | null; created_at: string }
export interface Order {
  id: number; source: string; external_id: string | null; payment_url: string | null; method: string; status: string; total: number; created_at: string;
  name: string | null; wa_id: string | null; items: string | null; receipt_key: string | null;
}
export interface Variant { id: number; product_id: number; size: string; stock: number; price: number; sale_price: number | null }
export interface Product {
  id: number; source: string; sku: string; name: string; description: string | null; categories: string | null; url: string | null; image: string | null; image_keys: string[];
  agent_visible: number; updated_at: string; variants: Variant[]; sold_30d: number;
}
export interface Config {
  tenant_id: string; enabled: number; timezone: string; schedule: string; shipping: string; brand_prompt: string; policies: string;
  bank_details: string; card_instructions: string; notify_phone: string | null; test_mode: number; test_whitelist: string;
  human_pause_minutes: number; age_size_map: number; currency: string; model: string;
}
export interface PluginField { key: string; label: string; type: "text" | "url" | "secret"; required?: boolean; help?: string; value: string; has_value: boolean }
export interface PluginInfo {
  id: string; name: string; description: string; capabilities: { sync: boolean; stock: boolean; orders: boolean };
  installed: boolean; enabled: boolean; last_sync_at: string | null; last_error: string | null; fields: PluginField[];
}
export interface QuickReply { id: number; title: string; body: string }

export interface Dashboard {
  days: number;
  kpis: {
    conversations: number; botOnly: number; mixed: number; humanOnly: number; derived: number;
    messagesIn: number; botMessages: number; humanMessages: number;
    orders: number; confirmedOrders: number; revenue: number; pendingRevenue: number; conversion: number; avgTicket: number;
    firstReplyBotSec: number | null; firstReplyHumanSec: number | null; fromAds: number; ordersFromAds: number;
  };
  funnel: { label: string; value: number }[];
  daily: { date: string; conversations: number; bot: number; human: number; orders: number; revenue: number }[];
  hourly: number[];
  topSold: { name: string; qty: number; revenue: number }[];
  topShown: { name: string; shown: number; sold: number }[];
  unmet: { query: string; count: number }[];
  sizes: { size: string; count: number }[];
  payment: { method: string; orders: number; total: number }[];
  stock: { out: number; low: number; hidden: number };
}

export const money = (n: number) => {
  const v = n.toLocaleString("es-EC", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return biz.currency === "USD" ? `$${v}` : `${v} ${biz.currency}`;
};
export const pct = (n: number) => `${Math.round(n * 100)}%`;
export function dur(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
}
/** La base guarda UTC "YYYY-MM-DD HH:MM:SS"; se muestra en la zona horaria del negocio. */
export function localTime(utc: string, withDate = false): string {
  const d = new Date(utc.replace(" ", "T") + "Z");
  return d.toLocaleString("es-EC", { timeZone: biz.timezone, hour: "2-digit", minute: "2-digit", ...(withDate ? { day: "2-digit", month: "short" } : {}) });
}
