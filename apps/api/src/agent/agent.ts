import type { Env } from "../env";
import { sendText } from "../whatsapp/client";
import { generate, type Content } from "./llm";
import { runTool, TOOL_DECLS, type ToolCtx } from "./tools";

const MAX_STEPS = 6;

export function buildSystemPrompt(businessName: string, brand: string, policies: string): string {
  return `Eres el asistente de ventas de ${businessName} por WhatsApp. Ayudas a la persona a elegir y cerrar la compra por este chat.

Flujo: 1) pregunta lo que necesite (producto, talla o edad, ocasión) si falta; 2) usa buscar_productos y luego enviar_fotos con 2-3 opciones que SÍ tengan stock; 3) confirma producto y talla/opción; 4) pide nombre, dirección y ciudad; 5) cotiza envío con cotizar_envio; 6) ofrece los métodos de pago disponibles y usa crear_pedido.

Reglas estrictas:
- Nunca inventes productos, precios, tallas ni stock: solo lo que devuelvan las herramientas.
- Si no hay stock de lo pedido, dilo y ofrece alternativas de la búsqueda.
- Si no sabes algo, hay un reclamo o piden hablar con una persona, usa derivar_a_humano.
- Si la persona envía un comprobante de transferencia, agradécele y avisa que el equipo lo confirmará.
- No prometas fechas de entrega exactas.
- Solo hablas de ${businessName} y sus productos; ante otros temas, redirige amablemente.
${policies}
${brand}`.trim();
}

/** Procesa un turno: arma el historial, deja que el modelo llame herramientas y responde por WhatsApp. */
export async function respond(
  env: Env,
  ctx: ToolCtx,
  geminiKey: string,
  model: string,
  system: string,
  history: { author: string; body: string | null }[],
  image?: { mimeType: string; data: string },
): Promise<string> {
  const contents: Content[] = history.map((m) => ({
    role: m.author === "cliente" ? "user" : "model",
    parts: [{ text: m.body ?? "" }],
  }));
  if (image) {
    const last = contents[contents.length - 1];
    if (last?.role === "user") last.parts.push({ inlineData: image });
  }

  let final = "";
  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await generate(geminiKey, model, system, contents, TOOL_DECLS);
    if (!r.calls.length) { final = r.text; break; }

    contents.push({ role: "model", parts: r.parts }); // conserva firmas de razonamiento de Gemini 3
    const responses = [];
    for (const c of r.calls) {
      responses.push({ functionResponse: { name: c.name, response: await runTool(ctx, c.name, c.args) } });
    }
    contents.push({ role: "user", parts: responses });
  }

  if (!final) final = "Un momento por favor, una persona del equipo le escribirá enseguida.";
  await sendText(ctx.wa, ctx.waId, final);
  return final;
}
