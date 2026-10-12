-- Bedford Bee merch store (Fourthwall), 2026-10-12. worker/src/bee/merch.ts.
-- Orders come from Fourthwall's Open API (API user pasted in Settings →
-- Bedford Bee, encrypted with CLOUD_ACCOUNT_ENC_KEY) and/or the orders CSV
-- export dropped in the Drive "Bedford Bee" folder. One row per order,
-- keyed by Fourthwall's order id; an API row is richer (items, costs, UTM)
-- and wins over a CSV row, except the CSV's refunded amount.

ALTER TABLE bee_keys ADD COLUMN fw_user_enc TEXT;
ALTER TABLE bee_keys ADD COLUMN fw_pass_enc TEXT;
ALTER TABLE bee_keys ADD COLUMN fw_shop_json TEXT;
ALTER TABLE bee_keys ADD COLUMN fw_last_sync_at TEXT;
ALTER TABLE bee_keys ADD COLUMN fw_last_full_at TEXT;
ALTER TABLE bee_keys ADD COLUMN fw_last_error TEXT;

CREATE TABLE bee_fw_orders (
  id TEXT PRIMARY KEY,
  friendly_id TEXT,
  type TEXT,                    -- 'Order' (export "type"; API orders are 'Order')
  created_at TEXT NOT NULL,     -- ISO instant
  day TEXT NOT NULL,            -- Eastern YYYY-MM-DD
  status TEXT,                  -- CONFIRMED … DELIVERED, COMPLETED, CANCELLED
  email TEXT,
  name TEXT,                    -- buyer (billing) name, else shipping name
  ship_name TEXT,
  phone TEXT,
  address TEXT,                 -- buyer's billing street
  city TEXT,
  state TEXT,
  zip TEXT,
  ship_city TEXT,
  ship_state TEXT,
  marketing_opt_in INTEGER,
  merchandise REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  refunded REAL NOT NULL DEFAULT 0,
  shipping REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  donation REAL NOT NULL DEFAULT 0,
  gift_cards REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  items_cost REAL,              -- Σ variant cost × qty; NULL when Fourthwall didn't say
  items_json TEXT,              -- [{ name, variant, sku, qty, price, cost }]
  promo_code TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  source TEXT NOT NULL,         -- 'api' | 'csv'
  contact_id TEXT,              -- linked contact; 'none' = Mike deleted it
  updated_at TEXT
);
CREATE INDEX idx_bee_fw_orders_day ON bee_fw_orders(day);
CREATE INDEX idx_bee_fw_orders_email ON bee_fw_orders(email);
CREATE INDEX idx_bee_fw_orders_contact ON bee_fw_orders(contact_id);
