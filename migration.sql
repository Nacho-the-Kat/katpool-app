CREATE TABLE IF NOT EXISTS uphold_connections (
  id SERIAL PRIMARY KEY,
  uphold_id VARCHAR(255) NOT NULL,
  access_token TEXT,
  access_expiry TIMESTAMP,
  refresh_token TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(uphold_id)
);

CREATE TABLE IF NOT EXISTS uphold_payout_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES uphold_connections(id) ON DELETE CASCADE,
  asset_code VARCHAR(50) NOT NULL, -- E.g., 'BTC', 'USD', 'ETH'
  network VARCHAR(50), -- E.g., 'bitcoin', 'ethereum'
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS uphold_payments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES uphold_connections(id) ON DELETE SET NULL,
  amount BIGINT NOT NULL,
  kas_amount BIGINT NOT NULL,
  asset_code VARCHAR(50) NOT NULL,
  network VARCHAR(50),
  uphold_transaction_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);