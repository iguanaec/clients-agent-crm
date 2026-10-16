import type { Env } from "../env";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { woocommerce } from "./woocommerce";
import type { CommercePlugin, PluginCtx } from "./types";

/** Para añadir un plugin nuevo: implementar `CommercePlugin` y registrarlo aquí. */
export const PLUGINS: Record<string, CommercePlugin> = {
  [woocommerce.id]: woocommerce,
};

export const getPlugin = (id: string) => PLUGINS[id];

interface PluginRow { plugin_id: string; enabled: number; config: string; last_sync_at: string | null; last_error: string | null }

const parse = (s: string): Record<string, string> => { try { return JSON.parse(s) as Record<string, string>; } catch { return {}; } };

export async function loadCtx(env: Env, tenantId: string, row: Pick<PluginRow, "config">): Promise<PluginCtx> {
  const config = parse(row.config);
  return { env, tenantId, config: await decryptConfig(env, config) };
}

async function decryptConfig(env: Env, config: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) out[k] = (await decryptSecret(env, v)) ?? "";
  return out;
}

/** Plugins habilitados del tenant, con su configuración descifrada. */
export async function activePlugins(env: Env, tenantId: string): Promise<{ plugin: CommercePlugin; ctx: PluginCtx }[]> {
  const { results } = await env.DB.prepare("SELECT plugin_id, enabled, config FROM tenant_plugins WHERE tenant_id = ? AND enabled = 1 ORDER BY plugin_id")
    .bind(tenantId).all<PluginRow>();
  const out: { plugin: CommercePlugin; ctx: PluginCtx }[] = [];
  for (const r of results) {
    const plugin = PLUGINS[r.plugin_id];
    if (plugin) out.push({ plugin, ctx: await loadCtx(env, tenantId, r) });
  }
  return out;
}

/** El plugin (habilitado) que firma un producto/pedido, según su `source`. */
export async function pluginFor(env: Env, tenantId: string, source: string) {
  if (source === "manual") return null;
  return (await activePlugins(env, tenantId)).find((p) => p.plugin.id === source) ?? null;
}

/** Valores a guardar: los campos `secret` se cifran; si llega vacío se conserva el valor anterior. */
export async function buildConfig(env: Env, plugin: CommercePlugin, incoming: Record<string, string>, previous: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const f of plugin.fields) {
    const given = (incoming[f.key] ?? "").trim();
    if (f.type === "secret") out[f.key] = given ? await encryptSecret(env, given) : (previous[f.key] ?? "");
    else out[f.key] = f.type === "url" ? given.replace(/\/+$/, "") : given;
  }
  return out;
}

export async function listForTenant(env: Env, tenantId: string) {
  const { results } = await env.DB.prepare("SELECT plugin_id, enabled, config, last_sync_at, last_error FROM tenant_plugins WHERE tenant_id = ?")
    .bind(tenantId).all<PluginRow>();
  return Object.values(PLUGINS).map((p) => {
    const row = results.find((r) => r.plugin_id === p.id);
    const config = row ? parse(row.config) : {};
    return {
      id: p.id, name: p.name, description: p.description,
      capabilities: { sync: !!p.syncCatalog, stock: !!p.setStock, orders: !!p.createOrder },
      installed: !!row, enabled: !!row?.enabled, last_sync_at: row?.last_sync_at ?? null, last_error: row?.last_error ?? null,
      fields: p.fields.map((f) => ({
        ...f,
        // Los secretos nunca salen del servidor: solo se informa si ya hay uno guardado.
        value: f.type === "secret" ? "" : (config[f.key] ?? ""),
        has_value: !!config[f.key],
      })),
    };
  });
}
