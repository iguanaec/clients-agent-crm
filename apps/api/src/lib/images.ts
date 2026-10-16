import type { Env } from "../env";

/**
 * WhatsApp solo acepta JPG/PNG y muchas tiendas sirven .webp. Descarga la imagen, la convierte a JPG con el
 * binding de Cloudflare Images y la guarda en R2 (el propio Worker la sirve en /media). Devuelve la clave R2.
 */
export async function importImageAsJpg(env: Env, tenantId: string, productId: number, idx: number, src: string): Promise<string | null> {
  const key = `${tenantId}/products/${productId}-${idx}.jpg`;
  if (await env.MEDIA.head(key)) return key;
  const res = await fetch(src);
  if (!res.ok || !res.body) {
    console.warn("photo download failed", src, res.status);
    return null;
  }
  try {
    const out = await env.IMAGES.input(res.body)
      .transform({ width: 1080, fit: "scale-down" })
      .output({ format: "image/jpeg", quality: 85 });
    await env.MEDIA.put(key, await out.response().arrayBuffer(), { httpMetadata: { contentType: "image/jpeg" } });
    return key;
  } catch (e) {
    console.warn("jpg conversion failed", src, e);
    return null;
  }
}
