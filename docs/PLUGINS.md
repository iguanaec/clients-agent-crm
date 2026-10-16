# Plugins

El núcleo (agente, CRM, catálogo propio, pedidos locales) no depende de ningún sistema externo. Un **plugin** conecta una fuente externa de
catálogo/pedidos. Cada negocio instala y configura los suyos en **Integraciones**; sus credenciales se guardan cifradas por negocio.

## Cómo encaja
- Los productos y variantes tienen `source` (`manual` o el id del plugin) y `external_id` (su id en el sistema externo). Los ids locales son
  estables entre sincronizaciones (upsert), así pedidos e historial no se rompen.
- El agente y el CRM **siempre leen el catálogo local**. El plugin lo mantiene al día (`syncCatalog`, cada 15 min o con el botón).
- Al **vender**, si el producto viene de un plugin que implementa `createOrder`, el pedido se crea allí (y de ahí sale el link de pago de
  tarjeta); si es del catálogo propio, el pedido es local y el stock se reserva en D1 (se devuelve si se rechaza).
- Al **cambiar stock** en el CRM de un producto de plugin, se escribe primero en el sistema externo; si lo rechaza, la copia local no cambia.
- Un plugin desactivado deja de actuar; sus productos siguen visibles pero ya no se pueden modificar desde el CRM hasta reactivarlo.

## Escribir uno
Implementa `CommercePlugin` (`apps/api/src/plugins/types.ts`) y regístralo en `plugins/index.ts`. Solo `id`, `name`, `description` y `fields` son
obligatorios; el núcleo llama únicamente lo que implementes:

| Método | Para qué |
|---|---|
| `test(ctx)` | Validar credenciales (botón «Probar conexión»). |
| `syncCatalog(ctx)` | Traer productos/variantes/stock a las tablas `products`/`variants` (ver `woocommerce/sync.ts`). |
| `getLiveStock(ctx, productExt, variantExt)` | Confirmar stock en vivo justo antes de vender. |
| `setStock(ctx, updates)` | Escribir stock en el sistema externo. |
| `createOrder(ctx, input)` | Crear el pedido externo; devolver `externalId` y, si hay, `paymentUrl`. |
| `refreshOrders(ctx, abiertos)` | Pasar pedidos pagados → `confirmado`, cancelados → `rechazado`. |
| `setOrderStatus(ctx, externalId, estado)` | Propagar «confirmar/rechazar» desde el CRM. |

`fields` describe el formulario de credenciales; los de tipo `secret` se cifran con AES‑GCM y no vuelven al navegador. Sin migraciones: la
configuración vive en `tenant_plugins.config`. Usa `importImageAsJpg` (`lib/images.ts`) para fotos: WhatsApp no acepta `.webp`.

Ideas: Shopify, Google Sheets, un ERP propio, pasarelas de pago que generen link para `createOrder`.

## WooCommerce
Claves REST de lectura/escritura (WooCommerce → Ajustes → Avanzado → REST API). Productos simples y variables; la variante se nombra con el
atributo *Talla/Size/Tamaño* (si no existe, con todas sus opciones). Transferencia crea el pedido `on-hold` (habilita *bacs* en la tienda);
tarjeta lo crea `pending` y entrega `payment_url`. Los productos que dejan de estar publicados quedan en stock 0.
