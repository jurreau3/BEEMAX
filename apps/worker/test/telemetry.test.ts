import {
  env,
  SELF,
  applyD1Migrations,
} from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Env } from "../src/types";

const bindings = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const call = (path: string, init?: RequestInit) =>
  SELF.fetch(`https://portal.test${path}`, init);

beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await bindings.DB.prepare("DELETE FROM qal_verification_logs").run();
});

describe("GET /api/telemetry/stats", () => {
  it("requires staff authentication and rejects unsupported methods", async () => {
    expect((await call("/api/telemetry/stats")).status).toBe(401);
    const response = await call("/api/telemetry/stats", {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-test-token" },
    });
    expect(response.status).toBe(405);
  });

  it("returns unknown metrics when there are no recent verification records", async () => {
    const response = await call("/api/telemetry/stats", {
      headers: { Authorization: "Bearer synthetic-test-token" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Portal-OS-Invariant")).toBe("I a gainst I");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      metrics: {
        avgLatencyMs: null,
        totalVerifications24h: 0,
        status: "UNKNOWN",
      },
    });
  });

  it("calculates average latency and count from recent D1 records only", async () => {
    await bindings.DB.batch([
      bindings.DB.prepare(
        "INSERT INTO qal_verification_logs (request_path,signature_payload,verification_status,latency_ms,created_at) VALUES ('/qal','test','SUCCESS',4,datetime('now','-1 hour'))",
      ),
      bindings.DB.prepare(
        "INSERT INTO qal_verification_logs (request_path,signature_payload,verification_status,latency_ms,created_at) VALUES ('/qal','test','FAILED',8,datetime('now','-2 hours'))",
      ),
      bindings.DB.prepare(
        "INSERT INTO qal_verification_logs (request_path,signature_payload,verification_status,latency_ms,created_at) VALUES ('/qal','old','SUCCESS',100,datetime('now','-48 hours'))",
      ),
    ]);
    const response = await call("/api/telemetry/stats", {
      headers: { Authorization: "Bearer synthetic-test-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      metrics: {
        avgLatencyMs: 6,
        totalVerifications24h: 2,
        status: "MEASURED",
      },
    });
  });
});
