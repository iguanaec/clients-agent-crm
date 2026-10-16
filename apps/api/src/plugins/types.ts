import type { Env } from "../env";

/**
 * Contrato de un plugin de comercio. El núcleo (agente + CRM + catálogo propio) funciona sin ninguno;
 * un plugin añade una fuente de catálogo/pedidos externa. Todo es opcional salvo `id`, `name` y `fields`:
 * el núcleo solo llama lo que el plugin implementa.
 */
export interface PluginField {
  key: string;
  label: string;
  type: "text" | "url" | "secret";
  required?: boolean;
  help?: string;
}

export interface PluginCtx {
  env: Env;
  tenantId: string;
  /** Configuración del tenant con los secretos ya descifrados. */
  config: Record<string, string>;
}

export interface ExternalOrderInput {
  items: { productExternalId: string; variantExternalId: string | null; quantity: number }[];
  name: string;
  phone: string;
  address: string;
  city: string;
  shippingTotal: number;
  method: "tarjeta" | "transferencia";
  note?: string;
}

export interface ExternalOrder {
  externalId: string;
  paymentUrl?: string;
}

export interface StockUpdate {
  productExternalId: string;
  variantExternalId: string | null; // null = producto simple
  stock: number;
}

export interface StockResult { variantExternalId: string | null; ok: boolean; error?: string }

export interface CommercePlugin {
  id: string;
  name: string;
  description: string;
  fields: PluginField[];
  /** Comprueba las credenciales y devuelve un mensaje legible. Lanza si fallan. */
  test?(ctx: PluginCtx): Promise<string>;
  /** Trae catálogo y stock al catálogo propio. */
  syncCatalog?(ctx: PluginCtx): Promise<{ products: number; variants: number }>;
  /** Stock en vivo de una variante (la copia local puede tener atraso). */
  getLiveStock?(ctx: PluginCtx, productExternalId: string, variantExternalId: string | null): Promise<number>;
  /** Escribe stock en el sistema externo (fuente de verdad). */
  setStock?(ctx: PluginCtx, updates: StockUpdate[]): Promise<StockResult[]>;
  /** Crea el pedido en el sistema externo. Con `paymentUrl` el agente puede cobrar con tarjeta. */
  createOrder?(ctx: PluginCtx, input: ExternalOrderInput): Promise<ExternalOrder>;
  /** Estado de los pedidos abiertos -> confirmado / rechazado. Devuelve cuántos cambiaron. */
  refreshOrders?(ctx: PluginCtx, openOrders: { id: number; externalId: string }[]): Promise<{ id: number; status: "confirmado" | "rechazado" }[]>;
  setOrderStatus?(ctx: PluginCtx, externalId: string, status: "confirmado" | "rechazado"): Promise<void>;
}
