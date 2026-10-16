# Plugins

El núcleo (WhatsApp coexistente, CRM, agente, catálogo propio, pedidos locales) **no depende de ningún sistema externo** y no trae plugins
instalados. Esta infraestructura queda lista para conectar una fuente externa de catálogo/pedidos más adelante (Shopify, una hoja de cálculo,
un ERP, una tienda como WooCommerce…). Cada negocio instalaría y configuraría los suyos en **Integraciones**, con credenciales cifradas por negocio.
Mientras no haya ninguno registrado, la sección «Plugins» ni siquiera aparece en el CRM.

## Cómo encaja
- Productos y variantes tienen `source` (`manual` o el id del plugin) y `external_id`. El agente y el CRM **siempre leen el catálogo local**;
  el plugin lo mantiene al día con `syncCatalog` (cada 15 min por el cron, o con el botón «Sincronizar ahora»).
- Al **vender**, si el producto viene de un plugin con `createOrder`, el pedido se crea allí (y de ahí sale el link de pago de tarjeta);
  si es del catálogo propio, el pedido es local y el stock se reserva en D1 (se devuelve al rechazar).
- Al **cambiar stock** en el CRM de un producto de plugin, se escribe primero en el sistema externo; si lo rechaza, la copia local no cambia.

## Escribir uno
Implementa `CommercePlugin` (`apps/api/src/plugins/types.ts`) y regístralo en `plugins/index.ts`. Solo `id`, `name`, `description` y `fields` son
obligatorios; el núcleo llama únicamente lo que implementes: `test`, `syncCatalog`, `getLiveStock`, `setStock`, `createOrder`, `refreshOrders`,
`setOrderStatus`. Los `fields` de tipo `secret` se cifran con AES‑GCM y no vuelven al navegador; no hacen falta migraciones (la configuración vive en
`tenant_plugins.config`). Para fotos usa `importImageAsJpg` (`lib/images.ts`): WhatsApp no acepta `.webp`.
Para cada plugin conviene replicar el estilo de prueba de `test/integration.test.ts` (D1/R2 locales + API externa simulada).
