import type { Env } from "./types";
import { customer, readObject } from "./customer-auth";

const GRANT_TTL_SECONDS = 15 * 60;
const MAX_CUSTOMER_ID_LENGTH = 128;
const MAX_RELEASE_ID_LENGTH = 120;
const encoder = new TextEncoder();

type AuditEvent =
  | "GRANT_ISSUED"
  | "RESOLVED_SUCCESS"
  | "EXPIRED"
  | "INVALID_SIGNATURE";

interface Release {
  id: string;
  title: string;
  download_ref: string;
}

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store, private" },
  });
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Invalid signature encoding");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function signingSecret(env: Env) {
  // Do not fall back to a public development value or reuse an unrelated secret.
  if (!env.DOWNLOADS_SECRET || encoder.encode(env.DOWNLOADS_SECRET).byteLength < 32)
    return null;
  return env.DOWNLOADS_SECRET;
}

async function signGrant(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

async function verifyGrant(secret: string, payload: string, signature: string) {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlDecode(signature),
      encoder.encode(payload),
    );
  } catch {
    return false;
  }
}

function auditMetadata(request: Request) {
  // CF-Connecting-IP is set by Cloudflare. Do not trust caller-controlled X-Forwarded-For.
  const ip = request.headers.get("CF-Connecting-IP")?.slice(0, 64) ?? null;
  const userAgent = request.headers.get("User-Agent")?.slice(0, 256) ?? null;
  return { ip, userAgent };
}

async function logAudit(
  env: Env,
  request: Request,
  customerId: string,
  releaseId: string,
  eventType: AuditEvent,
) {
  const { ip, userAgent } = auditMetadata(request);
  await env.DB.prepare(
    `INSERT INTO marketplace_download_audits
      (id, customer_id, release_id, event_type, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), customerId, releaseId, eventType, ip, userAgent)
    .run();
}

async function logInvalidAttemptIfKnown(
  env: Env,
  request: Request,
  customerId: string,
  releaseId: string,
) {
  // The audit table has foreign keys. Avoid turning arbitrary query strings into
  // failed inserts; record forged attempts when both referenced records exist.
  const known = await env.DB.prepare(
    `SELECT 1 FROM customer_accounts c CROSS JOIN marketplace_releases r
     WHERE c.id=? AND r.id=? LIMIT 1`,
  )
    .bind(customerId, releaseId)
    .first();
  if (known) await logAudit(env, request, customerId, releaseId, "INVALID_SIGNATURE");
}

async function activeEntitlement(env: Env, customerId: string, releaseId: string) {
  return env.DB.prepare(
    `SELECT 1
     FROM customer_library l
     JOIN marketplace_orders o
       ON o.customer_id=l.customer_id AND o.release_id=l.release_id
     JOIN marketplace_releases r ON r.id=l.release_id
     WHERE l.customer_id=? AND l.release_id=? AND o.status='paid'
       AND r.withdrawn_at IS NULL
     LIMIT 1`,
  )
    .bind(customerId, releaseId)
    .first();
}

export async function createMarketplaceDownloadGrant(
  request: Request,
  env: Env,
  releaseId: string,
): Promise<Response> {
  const secret = signingSecret(env);
  if (!secret) return json({ error: "Secure downloads are not configured" }, 503);

  const user = await customer(request, env);
  if (!user) return json({ error: "Sign in to your MAX account" }, 401);
  if (!releaseId || releaseId.length > MAX_RELEASE_ID_LENGTH)
    return json({ error: "Choose a product" }, 400);

  const release = await env.DB.prepare(
    `SELECT id, title, download_ref FROM marketplace_releases
     WHERE id=? AND withdrawn_at IS NULL`,
  )
    .bind(releaseId)
    .first<Release>();
  if (!release) return json({ error: "Product not found" }, 404);
  if (!(await activeEntitlement(env, user.id, releaseId)))
    return json({ error: "This product is not in your library" }, 403);

  const expiresAt = Math.floor(Date.now() / 1000) + GRANT_TTL_SECONDS;
  const payload = `${user.id}:${releaseId}:${expiresAt}`;
  const signature = await signGrant(secret, payload);
  const grantUrl = new URL("/api/downloads/resolve", request.url);
  grantUrl.searchParams.set("uid", user.id);
  grantUrl.searchParams.set("rel", releaseId);
  grantUrl.searchParams.set("exp", String(expiresAt));
  grantUrl.searchParams.set("sig", signature);

  // Fail closed: never issue a usable grant if its issuance cannot be audited.
  await logAudit(env, request, user.id, releaseId, "GRANT_ISSUED");

  return json({
    success: true,
    url: grantUrl.toString(),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  });
}

export async function resolveMarketplaceDownloadGrant(
  request: Request,
  env: Env,
): Promise<Response> {
  const secret = signingSecret(env);
  if (!secret) return new Response("Secure downloads are not configured", { status: 503 });
  if (request.method !== "GET")
    return new Response("Method not allowed", { status: 405 });

  const url = new URL(request.url);
  const customerId = url.searchParams.get("uid") ?? "";
  const releaseId = url.searchParams.get("rel") ?? "";
  const exp = url.searchParams.get("exp") ?? "";
  const signature = url.searchParams.get("sig") ?? "";
  if (
    !customerId || customerId.length > MAX_CUSTOMER_ID_LENGTH ||
    !releaseId || releaseId.length > MAX_RELEASE_ID_LENGTH ||
    !/^\d{1,12}$/.test(exp) || !/^[A-Za-z0-9_-]{43}$/.test(signature)
  )
    return new Response("Invalid download parameters", { status: 400 });

  const expiresAt = Number(exp);
  const payload = `${customerId}:${releaseId}:${exp}`;
  if (!(await verifyGrant(secret, payload, signature))) {
    await logInvalidAttemptIfKnown(env, request, customerId, releaseId);
    return new Response("Invalid signature", { status: 403 });
  }

  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    await logAudit(env, request, customerId, releaseId, "EXPIRED");
    return new Response("Download link has expired", { status: 410 });
  }
  // Also reject otherwise valid tokens that exceed the issued grant lifetime.
  if (expiresAt > now + GRANT_TTL_SECONDS)
    return new Response("Invalid download expiry", { status: 403 });

  const release = await env.DB.prepare(
    `SELECT r.id, r.title, r.download_ref FROM marketplace_releases r
     WHERE r.id=? AND r.withdrawn_at IS NULL`,
  )
    .bind(releaseId)
    .first<Release>();
  if (!release) return new Response("Release asset not found", { status: 404 });

  // Re-check entitlement at resolution time so refunds, revocations, and
  // withdrawals take effect even if a grant was issued shortly beforehand.
  if (!(await activeEntitlement(env, customerId, releaseId)))
    return new Response("Download entitlement is no longer active", { status: 403 });
  if (!env.DOWNLOADS)
    return new Response("Download provider is unavailable", { status: 503 });

  const grant = await env.DOWNLOADS.fetch("https://downloads.internal/grant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerId,
      releaseId,
      reference: release.download_ref,
      expiresIn: 300,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!grant.ok)
    return new Response("Download could not be prepared", { status: 503 });
  const result = (await grant.json()) as { url?: unknown };
  if (typeof result.url !== "string")
    return new Response("Invalid download provider response", { status: 503 });
  let target: URL;
  try {
    target = new URL(result.url);
  } catch {
    return new Response("Invalid download provider response", { status: 503 });
  }
  if (target.protocol !== "https:" || target.username || target.password)
    return new Response("Invalid download provider response", { status: 503 });

  // Record both the operational download and audit event before redirecting.
  // If either D1 write fails, no provider URL is disclosed to the caller.
  const { ip, userAgent } = auditMetadata(request);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO marketplace_downloads(id,customer_id,release_id) VALUES (?,?,?)",
    ).bind(crypto.randomUUID(), customerId, releaseId),
    env.DB.prepare(
      `INSERT INTO marketplace_download_audits
        (id, customer_id, release_id, event_type, ip_address, user_agent)
       VALUES (?, ?, ?, 'RESOLVED_SUCCESS', ?, ?)`,
    ).bind(crypto.randomUUID(), customerId, releaseId, ip, userAgent),
  ]);

  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      "Cache-Control": "no-store, private",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function grantFromRequest(request: Request, env: Env) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  const body = await readObject(request);
  if (typeof body.releaseId !== "string")
    return json({ error: "Choose a product" }, 400);
  return createMarketplaceDownloadGrant(request, env, body.releaseId);
}
