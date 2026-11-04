# Audited Marketplace download grants

The Marketplace Worker supports short-lived download grants at `POST /api/downloads` (when `DOWNLOADS_SECRET` is configured) and `POST /api/downloads/grant`. Both authenticate the existing `max_session` cookie, require a paid order plus a customer-library record, and issue a 15-minute HMAC-SHA256 signed URL. `GET /api/downloads/resolve` verifies the signature and expiry, re-checks entitlement and release availability, and asks the trusted `DOWNLOADS` service binding for a provider-native download URL. The provider URL is not stored in D1 or returned until audit writes succeed.

## Required production setup

1. Apply migration `0010_marketplace_download_audits.sql` to the Marketplace D1 database.
2. Provision a dedicated random secret of at least 32 bytes with `wrangler secret put DOWNLOADS_SECRET --config wrangler.marketplace.toml`. Do not put this value in TOML, source control, or reuse `GOVERNOR_API_TOKEN`.
3. Configure the `DOWNLOADS` service binding to a trusted adapter that validates the reference and returns a short-lived HTTPS URL. If the binding or secret is unavailable, the audited resolve endpoint fails closed.
4. Restrict access to the audit table to the Worker identity, define a retention period and privacy-review process for IP address and User-Agent fields, and test backup/export and access procedures before production rollout.

Audit events include `GRANT_ISSUED`, `RESOLVED_SUCCESS`, `EXPIRED`, and `INVALID_SIGNATURE`. The schema references the repository's existing `customer_accounts` table (not a nonexistent `customers` table). IP collection uses only Cloudflare's `CF-Connecting-IP`; caller-controlled `X-Forwarded-For` is deliberately ignored. User-Agent is truncated to 256 characters. Audit writes are fail-closed for grant issuance and successful resolution; invalid attempts are recorded only when both foreign-key records exist.

When `DOWNLOADS_SECRET` is not set, the existing `/api/downloads` trusted-adapter flow remains available for compatibility. Production must provision the secret and use the audited flow; `/api/downloads/grant` always requires it. This compatibility mode is transitional and does not provide the new D1 audit guarantees.
