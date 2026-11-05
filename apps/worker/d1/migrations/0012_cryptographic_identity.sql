-- Core D1 schema for the cryptographic identity and access-control layer.
-- Target: Cloudflare D1 (SQLite).
-- Replace the bootstrap public-key placeholder through the approved key
-- provisioning process before production use; never store private keys here.
PRAGMA foreign_keys = ON;

-- 1. System invariant and root authority anchor.
CREATE TABLE IF NOT EXISTS system_invariant (
    id TEXT PRIMARY KEY DEFAULT ('inv_' || hex(randomblob(8))),
    invariant_phrase TEXT NOT NULL DEFAULT 'I a gainst I',
    master_public_key TEXT NOT NULL,
    algorithm TEXT NOT NULL DEFAULT 'Ed25519',
    enforcement_level TEXT NOT NULL DEFAULT 'STRICT',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Bootstrap anchor only; the placeholder is not a production key.
INSERT OR IGNORE INTO system_invariant (id, invariant_phrase, master_public_key, enforcement_level)
VALUES ('inv_root_001', 'I a gainst I', 'ED25519_MASTER_SOVEREIGN_KEY_PLACEHOLDER', 'STRICT');

-- 2. Public identity keys and their lifecycle state.
CREATE TABLE IF NOT EXISTS cryptographic_identities (
    id TEXT PRIMARY KEY DEFAULT ('kid_' || hex(randomblob(8))),
    identity_name TEXT NOT NULL,
    public_key TEXT NOT NULL UNIQUE,
    key_role TEXT NOT NULL CHECK(key_role IN ('ROOT', 'STAFF', 'NODE', 'AGENT', 'STOREFRONT')),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'REVOKED', 'PENDING')),
    metadata TEXT, -- JSON metadata; do not put secrets or private keys here.
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP
);

-- 3. Verification evidence for signed requests.
CREATE TABLE IF NOT EXISTS qal_verification_logs (
    id TEXT PRIMARY KEY DEFAULT ('qal_' || hex(randomblob(8))),
    identity_id TEXT,
    request_path TEXT NOT NULL,
    signature_payload TEXT NOT NULL,
    verification_status TEXT NOT NULL CHECK(verification_status IN ('SUCCESS', 'FAILED', 'EXPIRED')),
    latency_ms REAL NOT NULL,
    ip_address TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (identity_id) REFERENCES cryptographic_identities(id) ON DELETE SET NULL
);

-- 4. Sessions reference identities; token_id is an opaque identifier, not a
-- bearer credential. Store only a suitably protected token reference here.
CREATE TABLE IF NOT EXISTS sovereign_sessions (
    token_id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL,
    scopes TEXT NOT NULL, -- Comma-separated or JSON list of authorized domains.
    edge_node_id TEXT,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    FOREIGN KEY (identity_id) REFERENCES cryptographic_identities(id) ON DELETE CASCADE
);

-- Indexes for identity, verification, and active-session lookups.
CREATE INDEX IF NOT EXISTS idx_crypto_identities_pubkey ON cryptographic_identities(public_key);
CREATE INDEX IF NOT EXISTS idx_qal_logs_status ON qal_verification_logs(verification_status);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sovereign_sessions(is_active, expires_at);
