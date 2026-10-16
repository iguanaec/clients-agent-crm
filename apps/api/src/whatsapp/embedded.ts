import type { Env } from "../env";

const GRAPH = "https://graph.facebook.com/v23.0";

export const embeddedAvailable = (env: Env) => !!(env.META_APP_ID && env.META_CONFIG_ID && env.WA_APP_SECRET);

export interface Connected {
  token: string;
  phoneNumberId: string;
  displayPhone: string | null;
  verifiedName: string | null;
}

/**
 * Cierra el Embedded Signup (modo coexistencia: el número sigue en la app WhatsApp Business del celular):
 * 1) canjea el `code` por un token de negocio, 2) suscribe nuestra app a la WABA del cliente para que sus mensajes lleguen
 * al webhook, 3) lee el número visible. Lanza un Error con mensaje legible si Meta rechaza algún paso.
 */
export async function completeEmbeddedSignup(env: Env, p: { code: string; phoneNumberId?: string; wabaId: string }): Promise<Connected> {
  if (!embeddedAvailable(env)) throw new Error("Embedded Signup no está configurado en la plataforma (META_APP_ID, META_CONFIG_ID y WA_APP_SECRET).");

  const tokenRes = await fetch(`${GRAPH}/oauth/access_token?${new URLSearchParams({
    client_id: env.META_APP_ID!, client_secret: env.WA_APP_SECRET, code: p.code,
  })}`);
  if (!tokenRes.ok) throw new Error(`Meta no aceptó el código de autorización (${tokenRes.status}). Vuelve a intentarlo.`);
  const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
  if (!token) throw new Error("Meta no devolvió un token de acceso.");
  const auth = { Authorization: `Bearer ${token}` };

  const sub = await fetch(`${GRAPH}/${p.wabaId}/subscribed_apps`, { method: "POST", headers: auth });
  if (!sub.ok) throw new Error(`No se pudo suscribir la app a tu cuenta de WhatsApp Business (${sub.status}): ${(await sub.text()).slice(0, 200)}`);

  // En coexistencia el navegador a veces no entrega el phone_number_id: se resuelve desde la WABA si tiene un solo número.
  let phoneNumberId = p.phoneNumberId;
  let d: { display_phone_number?: string; verified_name?: string } = {};
  if (phoneNumberId) {
    const info = await fetch(`${GRAPH}/${phoneNumberId}?fields=display_phone_number,verified_name`, { headers: auth });
    if (info.ok) d = (await info.json()) as typeof d;
  } else {
    const list = await fetch(`${GRAPH}/${p.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`, { headers: auth });
    const nums = list.ok ? ((await list.json()) as { data?: ({ id: string } & typeof d)[] }).data ?? [] : [];
    if (nums.length !== 1) throw new Error(nums.length ? "Tu cuenta tiene varios números; conecta de nuevo eligiendo uno." : "No se encontró ningún número en tu cuenta de WhatsApp Business.");
    phoneNumberId = nums[0].id;
    d = nums[0];
  }
  return { token, phoneNumberId, displayPhone: d.display_phone_number ?? null, verifiedName: d.verified_name ?? null };
}
