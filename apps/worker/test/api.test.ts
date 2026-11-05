import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  SELF,
  applyD1Migrations,
  runInDurableObject,
} from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import type { D1Migration } from "@cloudflare/vitest-plugin";

const bindings = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const origin = "http://localhost:5173";
const get = (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  if ((!init?.method || init.method === "GET") && !headers.has("Authorization"))
    headers.set("Authorization", "Bearer synthetic-test-token");
  return SELF.fetch(`https://portal.test${path}`, { ...init, headers });
};
const authorize = { Authorization: "Bearer synthetic-test-token" };
beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS.slice(0, 2));
  await bindings.DB.batch([
    bindings.DB.prepare(
      "INSERT INTO products (id,name,description,stage,score) VALUES ('legacy','Legacy product','Existing brief','Live',90)",
    ),
    bindings.DB.prepare(
      "INSERT INTO approvals (id,product_id,action,priority,risk,status) VALUES ('legacy-decision','legacy','Publish','High','Low','approved')",
    ),
  ]);
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS.slice(2, 4));
  await bindings.DB.batch([
    bindings.DB.prepare(
      "INSERT INTO factory_runs(id,product_id,status,stage) VALUES ('old-run','legacy','blocked','Build')",
    ),
    bindings.DB.prepare(
      "INSERT INTO factory_outputs(id,run_id,engine,content) VALUES ('old-output','old-run','Specification','{}')",
    ),
    bindings.DB.prepare(
      "INSERT INTO activity(id,product_id,title,department) VALUES ('old-activity','legacy','Preserved event','STRAT')",
    ),
    bindings.DB.prepare(
      "INSERT INTO deployments(id,product_id,environment,status) VALUES ('old-deployment','legacy','test','succeeded')",
    ),
  ]);
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS.slice(4));
  for (const table of [
    "factory_runs",
    "factory_outputs",
    "activity",
    "deployments",
  ]) {
    expect(
      await bindings.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first(
        "count",
      ),
    ).toBe(1);
  }
  expect(
    await bindings.DB.prepare(
      "SELECT stage,score,division_id FROM products WHERE id='legacy'",
    ).first(),
  ).toEqual({ stage: "Live", score: 90, division_id: "max-games" });
  expect(
    await bindings.DB.prepare(
      "SELECT status FROM approvals WHERE id='legacy-decision'",
    ).first("status"),
  ).toBe("approved");
  expect(
    (await bindings.DB.prepare("PRAGMA foreign_key_check").all()).results,
  ).toEqual([]);
});
beforeEach(async () => {
  await bindings.DB.batch([
    ...[
      "compensation_jobs",
      "worker_operations",
      "product_telemetry",
      "intelligence_snapshots",
      "department_snapshots",
      "twin_relationships",
      "marketplace_downloads",
      "marketplace_reviews",
      "customer_library",
      "marketplace_orders",
      "marketplace_releases",
      "marketplace_creators",
    ].map((table) => bindings.DB.prepare(`DELETE FROM ${table}`)),
    bindings.DB.prepare("DELETE FROM workflow_approvals"),
    bindings.DB.prepare("DELETE FROM workflow_events"),
    bindings.DB.prepare("DELETE FROM deployments"),
    bindings.DB.prepare("DELETE FROM factory_outputs"),
    bindings.DB.prepare("DELETE FROM factory_runs"),
    bindings.DB.prepare("DELETE FROM activity"),
    bindings.DB.prepare("DELETE FROM approvals"),
    bindings.DB.prepare("DELETE FROM products"),
    bindings.DB.prepare("DELETE FROM virtual_processes"),
  ]);
  await bindings.DB.prepare(
    "INSERT INTO products (id,name,stage,score) VALUES ('one','One','Ready',80),('two','Two','Live',90)",
  ).run();
  await bindings.DB.prepare(
    "INSERT INTO approvals (id,product_id,action,priority,risk) VALUES ('001','one','Publish','High','Low')",
  ).run();
});

describe("Worker API and D1 integration", () => {
  it("aggregates real dashboard values and reports no health sample truthfully", async () => {
    const response = await get("/api/dashboard");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projects: 2,
      activeProducts: 1,
      readyToPublish: 1,
      approvals: 1,
      health: null,
    });
    await bindings.DB.prepare(
      "INSERT INTO virtual_processes (pid,owner_id,state,last_heartbeat_epoch,context_vector) VALUES ('p1','local','READY',1,'{}'),('p2','local','PANICKED',1,'{}')",
    ).run();
    expect(
      ((await (await get("/api/dashboard")).json()) as { health: number })
        .health,
    ).toBe(50);
  });
  it("serves products, ranking, pipeline and approval join", async () => {
    expect(await (await get("/api/products")).json()).toHaveLength(2);
    expect(await (await get("/api/products/one")).json()).toMatchObject({
      id: "one",
      stage: "Ready",
      score: 80,
    });
    expect(await (await get("/api/portfolio")).json()).toMatchObject([
      { id: "two" },
      { id: "one" },
    ]);
    const pipeline = (await (await get("/api/pipeline")).json()) as {
      stage: string;
      products: unknown[];
    }[];
    expect(pipeline).toHaveLength(14);
    expect(
      pipeline.find((row) => row.stage === "Ready")?.products,
    ).toHaveLength(1);
    expect(await (await get("/api/approvals")).json()).toMatchObject([
      { id: "001", project: "One", action: "Publish" },
    ]);
    expect(await (await get("/api/analytics")).json()).toHaveLength(2);
    expect(await (await get("/api/governance")).json()).toEqual([
      { status: "pending", count: 1 },
    ]);
    expect(await (await get("/api/telemetry")).json()).toEqual([]);
  });
  it("rejects unauthorized decisions and fails closed when configuration is absent", async () => {
    expect(
      (await get("/api/approvals/001/approve", { method: "POST" })).status,
    ).toBe(401);
    expect(
      (
        await get("/api/approvals/001/approve", {
          method: "POST",
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
    const response = await worker.fetch(
      new Request("https://portal.test/api/approvals/001/approve", {
        method: "POST",
      }),
      { ...bindings, GOVERNOR_API_TOKEN: undefined },
      createExecutionContext(),
    );
    expect(response.status).toBe(401);
    expect(
      await bindings.DB.prepare(
        "SELECT status FROM approvals WHERE id = '001'",
      ).first("status"),
    ).toBe("pending");
  });
  it("allows only one concurrent decision and updates the pending count", async () => {
    const responses = await Promise.all(
      ["approve", "reject"].map((action) =>
        get(`/api/approvals/001/${action}`, {
          method: "POST",
          headers: authorize,
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(await (await get("/api/approvals")).json()).toEqual([]);
    expect(await (await get("/api/dashboard")).json()).toMatchObject({
      approvals: 0,
    });
  });
  it("persists rejection and distinguishes missing approvals", async () => {
    expect(
      await (
        await get("/api/approvals/001/reject", {
          method: "POST",
          headers: authorize,
        })
      ).json(),
    ).toEqual({ success: true, status: "rejected" });
    expect(
      await bindings.DB.prepare(
        "SELECT status FROM approvals WHERE id = '001'",
      ).first("status"),
    ).toBe("rejected");
    expect(
      (
        await get("/api/approvals/missing/approve", {
          method: "POST",
          headers: authorize,
        })
      ).status,
    ).toBe(404);
  });
  it("handles CORS preflight, errors and rejects unapproved origins", async () => {
    const preflight = await get("/api/approvals/001/approve", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Headers": "Authorization",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    );
    expect(
      (
        await get("/api/products", {
          headers: { Origin: "https://untrusted.test" },
        })
      ).status,
    ).toBe(403);
    const error = await get("/api/products/missing", {
      headers: { Origin: origin },
    });
    expect(error.status).toBe(404);
    expect(error.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(error.headers.get("Cache-Control")).toBe("no-store");
    expect((await get("/api/unknown")).status).toBe(404);
    expect(
      (await get("/api/products", { method: "POST", headers: authorize }))
        .status,
    ).toBe(405);
    expect((await get("/api/products/%ZZ")).status).toBe(400);
  });
  it("keeps the existing health and Durable Object IPC response contract", async () => {
    expect(await (await get("/")).json()).toMatchObject({
      status: "ONLINE",
      kernel: "Portal-OS1 Tier 1 Edge Kernel",
    });
    const envelope = {
      jsonrpc: "2.0",
      source_pid: "client_pwa_root",
      target_pid: "kernel_root",
      method: "agent.cognitive.sync",
      params: {},
    };
    const response = await get("/api/kernel/ipc", {
      method: "POST",
      body: JSON.stringify(envelope),
      headers: { ...authorize, "Content-Type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "SUCCESS",
      received_envelope: envelope,
    });
  });
});

// Rest of file omitted for brevity; this is the corrected assertion only.
