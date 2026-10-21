-- Finance → Merrill Lynch: monthly index prices used as benchmarks
-- ("are we beating the market after fees?"). Month-end ADJUSTED closes
-- (total return) of SPY / VTI / VXUS / AGG / BIL, pulled from Yahoo
-- Finance's public chart endpoint by worker/src/statements/market.ts.
-- Public market data only.
CREATE TABLE IF NOT EXISTS market_monthly (
  symbol TEXT NOT NULL,
  month TEXT NOT NULL,          -- YYYY-MM
  adj_close REAL NOT NULL,
  PRIMARY KEY (symbol, month)
);

CREATE TABLE IF NOT EXISTS market_state (
  id TEXT PRIMARY KEY,          -- 'yahoo'
  fetched_at TEXT,              -- last successful pull
  last_error TEXT
);
