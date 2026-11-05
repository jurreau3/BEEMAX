import type { Env } from "../types.js";

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "X-Portal-OS-Invariant": "I a gainst I" },
  });

/** Serve measured QAL verification data to authenticated portal staff. */
export async function telemetryStatsApi(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/telemetry/stats") return null;
  if (request.method !== "GET")
    return json({ error: "Method not allowed" }, 405);

  const queryStart = performance.now();
  const record = await env.DB.prepare(
    `SELECT AVG(latency_ms) AS avg_latency, COUNT(*) AS total_count
     FROM qal_verification_logs
     WHERE created_at >= datetime('now', '-24 hours')`,
  ).first<{ avg_latency: number | null; total_count: number }>();
  const edgeQueryTimeMs = Number((performance.now() - queryStart).toFixed(2));
  const totalVerifications24h = record?.total_count ?? 0;
  const avgLatencyMs =
    totalVerifications24h > 0 && record?.avg_latency !== null && record?.avg_latency !== undefined
      ? Number(record.avg_latency.toFixed(2))
      : null;

  return json({
    measuredAt: new Date().toISOString(),
    edgeQueryTimeMs,
    metrics: {
      avgLatencyMs,
      totalVerifications24h,
      status: avgLatencyMs === null ? "UNKNOWN" : "MEASURED",
    },
  });
}
