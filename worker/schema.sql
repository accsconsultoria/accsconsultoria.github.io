-- Esquema D1 do checkout. Aplicar com:
--   npx wrangler d1 execute checkout --remote --file=schema.sql
-- Não há nenhum campo de cartão: o pagamento acontece inteiramente no Mercado Pago.

CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL,
  email         TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'BRL',
  status        TEXT NOT NULL DEFAULT 'created',
  preference_id TEXT,
  payment_id    TEXT,
  created_at    INTEGER NOT NULL,
  paid_at       INTEGER,
  delivered_at  INTEGER,
  delivery_claim INTEGER,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_events (
  payment_id    TEXT NOT NULL,
  status        TEXT NOT NULL,
  detail        TEXT,
  received_at   INTEGER NOT NULL,
  PRIMARY KEY (payment_id, status)
);

CREATE TABLE IF NOT EXISTS download_links (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id),
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    INTEGER NOT NULL,
  max_downloads INTEGER NOT NULL,
  downloads     INTEGER NOT NULL DEFAULT 0,
  revoked       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_links_order ON download_links(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
