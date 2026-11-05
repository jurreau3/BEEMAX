# Cryptographic Identity Kernel

## Purpose and authority

The D1 migration `apps/worker/d1/migrations/0012_cryptographic_identity.sql` establishes the persistence schema for the ICV identity layer: a root public-key anchor, identity public keys and lifecycle states, verification evidence, and identity-bound sessions. It supports the MAX Institute identity policy and must preserve identity continuity and traceability.

This schema stores public keys only. Private keys and bearer credentials must remain outside D1. `token_id` is an opaque token reference, not a bearer token. Verification payloads and IP addresses may contain sensitive or personal data; restrict access, define retention, and include only approved data in audit exports.

The bootstrap root key value `ED25519_MASTER_SOVEREIGN_KEY_PLACEHOLDER` is deliberately not a valid production trust anchor. Production activation is blocked until an approved root public key is provisioned and its provenance, approval, and recovery procedure are recorded. The schema alone does not implement signature verification, token issuance, authorization, key rotation, or root-key recovery.

## Data relationships and lifecycle

- `system_invariant` records the root authority anchor and enforcement setting.
- `cryptographic_identities` records public keys with constrained roles and `PENDING`, `ACTIVE`, or `REVOKED` status.
- `qal_verification_logs` records verification outcomes and latency; deleting an identity retains the log and nulls its identity reference.
- `sovereign_sessions` binds an opaque session identifier to an identity and expires explicitly; deleting an identity cascades to its sessions.

Identity changes and verification events must be traceable to an approved actor and policy. Do not treat the `latency_ms` field or the QAL name as evidence of a guaranteed performance target or quantum-resistant cryptography: this migration uses the declared Ed25519 algorithm default.

## Acceptance checks

- Apply the migration to a clean D1 database and verify the four tables, indexes, root seed row, and foreign-key enforcement.
- Verify invalid identity roles, statuses, verification outcomes, and session `is_active` values are rejected by constraints.
- Verify deleting an identity preserves verification logs with a null `identity_id` and removes its sessions.
- Verify duplicate public keys are rejected and an expired or revoked identity cannot be treated as active by application authorization.
- Verify production deployment rejects the bootstrap placeholder and requires documented root-key provenance, approval, backup/recovery, monitoring, and audit-export handling.
