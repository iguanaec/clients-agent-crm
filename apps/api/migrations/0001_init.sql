-- Cada negocio (cliente) es un tenant con sus propios usuarios, WhatsApp, catálogo e integraciones.
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  wa_phone_number_id TEXT UNIQUE,
  wa_access_token TEXT,          -- cifrado (lib/crypto); si es NULL se usa WA_ACCESS_TOKEN del entorno
  gemini_api_key TEXT,           -- cifrado; si es NULL se usa GEMINI_API_KEY del entorno
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','agent')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_tenant ON users(tenant_id);

-- Una fila por tenant; `schedule` y `shipping` son JSON editables desde el CRM.
CREATE TABLE agent_config (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  timezone TEXT NOT NULL DEFAULT 'America/Guayaquil',
  schedule TEXT NOT NULL,
  shipping TEXT NOT NULL,
  brand_prompt TEXT NOT NULL DEFAULT '',
  policies TEXT NOT NULL DEFAULT '',
  bank_details TEXT NOT NULL DEFAULT '',
  card_instructions TEXT NOT NULL DEFAULT '',   -- link/indicaciones de pago con tarjeta cuando no hay plugin que genere el link
  notify_phone TEXT,
  test_mode INTEGER NOT NULL DEFAULT 1,
  test_whitelist TEXT NOT NULL DEFAULT '[]',
  human_pause_minutes INTEGER NOT NULL DEFAULT 720,
  age_size_map INTEGER NOT NULL DEFAULT 0,      -- 1 = traducir "8 años" a tallas de ropa infantil
  currency TEXT NOT NULL DEFAULT 'USD',
  model TEXT NOT NULL DEFAULT 'gemini-3.1-flash-lite'
);

-- Plugins activados por tenant (p. ej. woocommerce). Los campos secretos de `config` van cifrados.
CREATE TABLE tenant_plugins (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  plugin_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}',
  last_sync_at TEXT,
  last_error TEXT,
  PRIMARY KEY (tenant_id, plugin_id)
);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  wa_id TEXT NOT NULL,
  name TEXT,
  ad_referral TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, wa_id)
);

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  state TEXT NOT NULL DEFAULT 'bot' CHECK (state IN ('bot','humano','cerrada')),
  bot_paused_until TEXT,
  summary TEXT NOT NULL DEFAULT '',
  last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
  handoff_sent INTEGER NOT NULL DEFAULT 0,
  last_seen_msg_id INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_conv_contact ON conversations(contact_id, last_message_at DESC);
CREATE INDEX idx_conv_tenant ON conversations(tenant_id, last_message_at DESC);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  wa_message_id TEXT UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  author TEXT NOT NULL CHECK (author IN ('cliente','bot','humano','app')),
  type TEXT NOT NULL DEFAULT 'text',
  body TEXT,
  media_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_msg_conv ON messages(conversation_id, id);

-- Catálogo propio. `source` = 'manual' o el id del plugin que lo sincroniza; `external_id` es el id en ese sistema.
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  source TEXT NOT NULL DEFAULT 'manual',
  external_id TEXT,
  sku TEXT,
  name TEXT NOT NULL,
  description TEXT,
  categories TEXT,
  url TEXT,
  images TEXT NOT NULL DEFAULT '[]', -- JSON: claves R2 (jpg)
  agent_visible INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, source, external_id)
);
CREATE INDEX idx_products_tenant ON products(tenant_id, name);

CREATE TABLE variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  external_id TEXT,
  size TEXT NOT NULL,               -- talla / presentación / variante
  stock INTEGER NOT NULL DEFAULT 0,
  price REAL NOT NULL,
  sale_price REAL,
  UNIQUE (product_id, external_id)
);
CREATE INDEX idx_var_product ON variants(product_id, size);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  conversation_id INTEGER REFERENCES conversations(id),
  source TEXT NOT NULL DEFAULT 'manual',   -- 'manual' o el plugin que creó el pedido externo
  external_id TEXT,
  payment_url TEXT,
  method TEXT NOT NULL CHECK (method IN ('tarjeta','transferencia')),
  status TEXT NOT NULL DEFAULT 'pendiente',
  total REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_orders_tenant ON orders(tenant_id, id DESC);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL,
  variant_id INTEGER,
  size TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  price REAL NOT NULL
);
CREATE INDEX idx_items_order ON order_items(order_id);

-- Qué hizo el agente (búsquedas, fotos, pedidos, derivaciones): alimenta el dashboard.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  conversation_id INTEGER,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_tenant ON events(tenant_id, type, created_at);

CREATE TABLE quick_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL
);
