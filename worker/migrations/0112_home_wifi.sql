-- Home → Internet: the house's Wi-Fi networks (2026-10-12). Main + guest
-- etc. The password is AES-GCM field-encrypted with CLOUD_ACCOUNT_ENC_KEY
-- (cryptoField.ts) and only returned by GET /api/home/network/wifi/:id/password,
-- which the page calls to show it or draw the join-by-QR code.
CREATE TABLE home_wifi_networks (
  id TEXT PRIMARY KEY,
  ssid TEXT NOT NULL,             -- Network Name
  password_enc TEXT,              -- encrypted; NULL = open network / not saved
  security TEXT NOT NULL DEFAULT 'WPA' CHECK (security IN ('WPA', 'WEP', 'nopass')),
  hidden INTEGER NOT NULL DEFAULT 0,
  label TEXT,                     -- "Main", "Guest"…
  plan TEXT,                      -- "Verizon Fios 1 Gig"
  download_mbps REAL,
  upload_mbps REAL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
