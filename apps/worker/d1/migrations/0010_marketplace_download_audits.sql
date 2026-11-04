-- Marketplace download grant audit trail. Keep customer identifiers tied to the
-- existing customer_accounts table used by the public Marketplace auth flow.
CREATE TABLE IF NOT EXISTS marketplace_download_audits (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL REFERENCES marketplace_releases(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'GRANT_ISSUED',
    'RESOLVED_SUCCESS',
    'EXPIRED',
    'INVALID_SIGNATURE'
  )),
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_download_audits_customer
  ON marketplace_download_audits(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_download_audits_release
  ON marketplace_download_audits(release_id, created_at DESC);
