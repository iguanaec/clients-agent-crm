import type { Env } from "../env";
import { decryptSecret } from "../lib/crypto";
import { waAuthFor, type WaAuth } from "../whatsapp/client";

export interface TenantRow {
  id: string;
  name: string;
  wa_phone_number_id: string | null;
  wa_access_token: string | null;
  gemini_api_key: string | null;
  enabled: number;
  timezone: string;
  schedule: string;
  shipping: string;
  brand_prompt: string;
  policies: string;
  bank_details: string;
  card_instructions: string;
  notify_phone: string | null;
  test_mode: number;
  test_whitelist: string;
  human_pause_minutes: number;
  age_size_map: number;
  currency: string;
  model: string;
}

const SELECT = `SELECT t.id, t.name, t.wa_phone_number_id, t.wa_access_token, t.gemini_api_key, c.* FROM tenants t JOIN agent_config c ON c.tenant_id = t.id`;

export const loadTenantByPhone = (env: Env, phoneNumberId: string) =>
  env.DB.prepare(`${SELECT} WHERE t.wa_phone_number_id = ?`).bind(phoneNumberId).first<TenantRow>();

export const loadTenant = (env: Env, id: string) =>
  env.DB.prepare(`${SELECT} WHERE t.id = ?`).bind(id).first<TenantRow>();

export const tenantWa = (env: Env, t: TenantRow): Promise<WaAuth | null> => waAuthFor(env, t);

export async function geminiKey(env: Env, t: TenantRow): Promise<string> {
  return (await decryptSecret(env, t.gemini_api_key)) || env.GEMINI_API_KEY || "";
}
