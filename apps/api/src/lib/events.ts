import type { Env } from "../env";

export type EventType = "buscar" | "fotos" | "pedido" | "derivar";

/** Registro de lo que hace el agente; nunca debe tumbar una respuesta. */
export async function logEvent(env: Env, tenantId: string, conversationId: number | null, type: EventType, data: Record<string, unknown>) {
  try {
    await env.DB.prepare("INSERT INTO events (tenant_id, conversation_id, type, data) VALUES (?,?,?,?)")
      .bind(tenantId, conversationId, type, JSON.stringify(data)).run();
  } catch (e) {
    console.warn("logEvent failed", type, e);
  }
}
