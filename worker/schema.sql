-- Esquema D1 do checkout. Aplicar em CADA ambiente (banco novo; nenhum banco existe ainda):
--   produção:     npx wrangler d1 execute accs-checkout-db --remote --env producao --file=schema.sql
--   homologação:  npx wrangler d1 execute pub-checkout-db-homolog --remote --env homologacao --file=schema.sql
-- Não há nenhum campo de cartão: o pagamento acontece inteiramente no Mercado Pago.
-- Histórico financeiro (payment_events e valores dos pedidos) nunca é apagado pelo sistema.

CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,
  slug               TEXT NOT NULL,
  email              TEXT NOT NULL,
  amount_cents       INTEGER NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'BRL',
  -- created | pending | paid | rejected | cancelled | refunded
  status             TEXT NOT NULL DEFAULT 'created',
  preference_id      TEXT,
  payment_id         TEXT,
  -- valor já reembolsado (reembolso parcial não revoga o acesso automaticamente)
  refunded_cents     INTEGER NOT NULL DEFAULT 0,
  -- 1 = nenhuma NOVA entrega enquanto houver disputa/análise (links já enviados continuam)
  delivery_suspended INTEGER NOT NULL DEFAULT 0,
  -- NULL | needs_review | resolved  (decisão do proprietário registrada em review_note)
  review_status      TEXT,
  review_reason      TEXT,
  review_note        TEXT,
  created_at         INTEGER NOT NULL,
  paid_at            INTEGER,
  delivered_at       INTEGER,
  delivery_claim     INTEGER,
  last_reconcile     INTEGER,
  anonymized_at      INTEGER,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_events (
  payment_id     TEXT NOT NULL,
  status         TEXT NOT NULL,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  order_id       TEXT,
  amount_cents   INTEGER,
  detail         TEXT,
  received_at    INTEGER NOT NULL,
  PRIMARY KEY (payment_id, status, refunded_cents)
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

-- Limitação de requisições (chaves são hashes; linhas expiram em minutos/horas)
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket     TEXT PRIMARY KEY,
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_links_order ON download_links(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_review ON orders(review_status);
CREATE INDEX IF NOT EXISTS idx_events_order ON payment_events(order_id);
CREATE INDEX IF NOT EXISTS idx_rate_expires ON rate_limits(expires_at);
