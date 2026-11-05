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

describe("Command centre operations", () => {
  it("serves divisions, runtime and intelligence from D1", async () => {
    expect(await (await get("/api/divisions")).json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "max-games" }),
        expect.objectContaining({ id: "max-apps", name: "MAX Apps" }),
        expect.objectContaining({ id: "quantum-xr" }),
      ]),
    );
    expect(await (await get("/api/system-health")).json()).toMatchObject({
      status: "Operational",
      services: [
        { name: "Worker API", status: "Operational" },
        { name: "D1 database", status: "Operational" },
        { name: "Durable Objects", status: "Configured" },
        { name: "Product runtime", status: "No telemetry" },
      ],
    });
    expect(await (await get("/api/processes")).json()).toEqual([]);
    expect(await (await get("/api/deployments")).json()).toEqual([]);
    expect(await (await get("/api/runtime")).json()).toMatchObject({
      processes: [],
    });
    expect(await (await get("/api/departments")).json()).toHaveLength(8);
    expect(await (await get("/api/forecasts")).json()).toMatchObject({
      divisions: expect.arrayContaining([
        expect.objectContaining({ id: "max-games", revenue: 0, products: 2 }),
      ]),
    });
    expect(await (await get("/api/recommendations")).json()).toMatchObject([
      { productId: "one" },
    ]);
    expect(await (await get("/api/overview")).json()).toMatchObject({
      portfolioScore: 85,
      revenue: 0,
    });
  });
  it("requires authorization for every command and validates intake", async () => {
    for (const path of [
      "/api/intake",
      "/api/divisions",
      "/api/factory/one/run",
      "/api/approvals/001/override",
    ]) {
      expect((await get(path, { method: "POST" })).status).toBe(401);
    }
    const post = (body: unknown) =>
      get("/api/intake", {
        method: "POST",
        headers: { ...authorize, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post(null)).status).toBe(400);
    expect(
      (
        await post({
          name: "Example",
          description: "A",
          divisionId: "max-games",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          name: "Example",
          description: "A sufficiently detailed product brief",
          divisionId: "missing",
        })
      ).status,
    ).toBe(400);
    expect((await get("/api/intake")).status).toBe(405);
  });
  it("creates future divisions and persists product intake", async () => {
    const created = await get("/api/divisions", {
      method: "POST",
      headers: authorize,
      body: JSON.stringify({ name: "MAX Future" }),
    });
    expect(created.status).toBe(201);
    const division = (await created.json()) as { id: string };
    const intake = await get("/api/intake", {
      method: "POST",
      headers: authorize,
      body: JSON.stringify({
        name: "Future idea",
        description: "A detailed synthetic brief for a future product",
        divisionId: division.id,
      }),
    });
    expect(intake.status).toBe(201);
    const { id } = (await intake.json()) as { id: string };
    await runInDurableObject(
      bindings.FACTORY_ACTOR!.get(bindings.FACTORY_ACTOR!.idFromName(id)),
      async (_instance, ctx) => {
        await ctx.storage.deleteAlarm();
      },
    );
    expect(await (await get(`/api/products/${id}`)).json()).toMatchObject({
      divisionId: division.id,
      stage: expect.stringMatching(
        /^(Idea|Discovery|Specification|Architecture|Simulation|Build)$/,
      ),
      revenue: 0,
      status: "On track",
    });
    expect(await (await get("/api/activity")).json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: id, department: "STRAT" }),
      ]),
    );
    expect(
      (
        await get("/api/divisions", {
          method: "POST",
          headers: authorize,
          body: JSON.stringify({ name: "MAX Future" }),
        })
      ).status,
    ).toBe(409);
  });
  it("requires an override reason, preserves finality and exposes history", async () => {
    const post = (body: unknown) =>
      get("/api/approvals/001/override", {
        method: "POST",
        headers: authorize,
        body: JSON.stringify(body),
      });
    expect((await post({ reason: "short" })).status).toBe(400);
    expect(
      (await post({ reason: "Governor accepts the documented exception." }))
        .status,
    ).toBe(200);
    expect(
      (
        await post({
          reason: "A repeated exception cannot change a final decision.",
        })
      ).status,
    ).toBe(409);
    expect(await (await get("/api/decisions")).json()).toMatchObject([
      {
        status: "overridden",
        note: "Governor accepts the documented exception.",
      },
    ]);
    expect(await (await get("/api/products/one")).json()).toMatchObject({
      stage: "Ready",
    });
  });
  it("serializes durable automation and blocks truthfully without an executor", async () => {
    const id = crypto.randomUUID();
    await bindings.DB.prepare(
      "INSERT INTO products(id,name,description,stage) VALUES (?,'Automation test','Concrete test brief describing an executable project','Idea')",
    )
      .bind(id)
      .run();
    const post = () =>
      get(`/api/factory/${id}/run`, { method: "POST", headers: authorize });
    const responses = await Promise.all([post(), post()]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    const stub = bindings.FACTORY_ACTOR!.get(
      bindings.FACTORY_ACTOR!.idFromName(id),
    );
    for (let i = 0; i < 7; i++)
      await runInDurableObject(stub, async (instance: any, ctx) => {
        await instance.alarm();
        await ctx.storage.deleteAlarm();
      });
    expect(await (await get(`/api/products/${id}`)).json()).toMatchObject({
      stage: "Build",
      status: "Attention",
    });
    const transitions = (await (
      await get(`/api/factory/${id}/transitions`)
    ).json()) as { toStage: string }[];
    expect(transitions.map((t) => t.toStage)).toEqual([
      "Idea",
      "Discovery",
      "Specification",
      "Architecture",
      "Simulation",
      "Build",
      "Build",
    ]);
    expect(await (await get("/api/factory")).json()).toMatchObject([
      { productId: id, status: "blocked", stage: "Build" },
    ]);
    expect((await post()).status).toBe(200);
    await runInDurableObject(stub, async (_instance, ctx) => {
      await ctx.storage.deleteAlarm();
    });
    expect(
      (
        await get("/api/factory/missing/run", {
          method: "POST",
          headers: authorize,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await get("/api/factory/two/run", {
          method: "POST",
          headers: authorize,
        })
      ).status,
    ).toBe(409);
  });
});

describe("ICVS execution and recovery", () => {
  async function start() {
    const id = crypto.randomUUID();
    await bindings.DB.prepare(
      "INSERT INTO products(id,name,description,stage) VALUES (?,'Executor contract test','Verify a supplied brief against an immutable build artifact','Idea')",
    )
      .bind(id)
      .run();
    await get(`/api/factory/${id}/run`, { method: "POST", headers: authorize });
    const stub = bindings.FACTORY_ACTOR!.get(
      bindings.FACTORY_ACTOR!.idFromName(id),
    );
    await runInDurableObject(stub, async (_instance, ctx) => {
      await ctx.storage.deleteAlarm();
    });
    return { id, stub };
  }
  // Test-only executor fixture; never used by application code or seeded into D1 outside tests.
  async function drive(stub: DurableObjectStub, wrongDigest = false) {
    await runInDurableObject(stub, async (instance: any, ctx) => {
      instance.env.ICVS_EXECUTOR = {
        fetch: async (_url: string, init: RequestInit) => {
          const request = JSON.parse(init.body as string);
          expect(init.headers).toMatchObject({
            "Idempotency-Key": request.operationId,
          });
          if (request.stage === "Package")
            return Response.json({
              operationId: request.operationId,
              artifact: "https://test.invalid/artifact",
              digest: "a".repeat(64),
              slug: `product-${request.productId}`,
              title: "Verified test product",
              summary: "Public test product description",
              type: "app",
              priceMinor: 0,
              currency: "USD",
              creator: {
                id: "fixture-creator",
                slug: "fixture-creator",
                name: "Fixture Creator",
                bio: "Synthetic test creator",
              },
            });
          return Response.json({
            operationId: request.operationId,
            artifact: "https://test.invalid/artifact",
            digest: (wrongDigest && request.stage === "QA" ? "b" : "a").repeat(
              64,
            ),
            checks:
              request.stage === "QA"
                ? [
                    {
                      requirement: "brief",
                      passed: true,
                      report: "https://test.invalid/report",
                    },
                  ]
                : [],
          });
        },
      };
      await instance.alarm();
      await ctx.storage.deleteAlarm();
    });
  }
  for (const action of ["approve", "reject", "override"]) {
    it(`automatically verifies execution and handles ${action} with an audit trail`, async () => {
      const { id, stub } = await start();
      for (let i = 0; i < 9; i++) await drive(stub);
      const approval = await bindings.DB.prepare(
        "SELECT id FROM approvals WHERE product_id=? AND status='pending'",
      )
        .bind(id)
        .first<{ id: string }>();
      expect(approval).not.toBeNull();
      expect(await (await get(`/api/products/${id}`)).json()).toMatchObject({
        stage: "Package",
      });
      const responses = await Promise.all(
        [1, 2].map(() =>
          get(`/api/approvals/${approval!.id}/${action}`, {
            method: "POST",
            headers: authorize,
            body: JSON.stringify({
              reason: "Governor reviewed the verified evidence.",
            }),
          }),
        ),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await (await get(`/api/products/${id}`)).json()).toMatchObject({
        stage: action === "reject" ? "Archived" : "Ready",
        score: action === "reject" ? 0 : 100,
      });
      if (action === "reject") {
        expect(
          await bindings.DB.prepare(
            "SELECT COUNT(*) AS count FROM compensation_jobs WHERE product_id=?",
          )
            .bind(id)
            .first("count"),
        ).toBe(1);
        expect(
          await bindings.DB.prepare(
            "SELECT plan FROM compensation_jobs WHERE product_id=?",
          )
            .bind(id)
            .first("plan"),
        ).toEqual(expect.stringContaining("packageDigest"));
      }
      const events = (await (
        await get(`/api/factory/${id}/transitions`)
      ).json()) as any[];
      expect(events.map((e) => e.sequence)).toEqual(
        events.map((_, i) => i + 1),
      );
      expect(events.filter((e) => e.actor === "governor")).toMatchObject([
        {
          actor: "governor",
          engine: action === "reject" ? "Archive" : "Promotion",
        },
      ]);
      expect(
        (await bindings.DB.prepare("PRAGMA foreign_key_check").all()).results,
      ).toEqual([]);
    });
  }
  it("publishes an approved package and replays a failed catalog projection without republishing", async () => {
    const { id, stub } = await start();
    for (let i = 0; i < 9; i++) await drive(stub);
    const approval = await bindings.DB.prepare(
      "SELECT id FROM approvals WHERE product_id=? AND status='pending'",
    )
      .bind(id)
      .first<{ id: string }>();
    expect(
      (
        await get(`/api/approvals/${approval!.id}/approve`, {
          method: "POST",
          headers: authorize,
        })
      ).status,
    ).toBe(200);
    await bindings.DB.exec(
      "CREATE TRIGGER fail_catalog BEFORE INSERT ON marketplace_releases BEGIN SELECT RAISE(FAIL, 'test catalog failure'); END;",
    );
    await runInDurableObject(stub, async (instance: any, ctx) => {
      let calls = 0;
      instance.env.ICVS_PUBLISHER = {
        fetch: async (_url: string, init: RequestInit) => {
          calls++;
          const input = JSON.parse(init.body as string);
          expect(input.approvalId).toBe(approval!.id);
          return Response.json({
            operationId: input.operationId,
            packageDigest: input.packageDigest,
            downloadReference: "test-download",
            receipt: "https://test.invalid/release",
          });
        },
      };
      await instance.alarm();
      expect(calls).toBe(1);
      expect((await ctx.storage.get<any>("workflow")).pending).toBeDefined();
      await instance.env.DB.exec("DROP TRIGGER fail_catalog;");
      await instance.alarm();
      await instance.alarm();
      expect(calls).toBe(1);
      expect((await ctx.storage.get<any>("workflow")).pending).toBeUndefined();
      await ctx.storage.deleteAlarm();
    });
    expect(
      await bindings.DB.prepare("SELECT stage FROM products WHERE id=?")
        .bind(id)
        .first("stage"),
    ).toBe("Published");
    expect(
      await bindings.DB.prepare(
        "SELECT COUNT(*) AS n FROM marketplace_releases WHERE product_id=?",
      )
        .bind(id)
        .first("n"),
    ).toBe(1);
    expect(
      await bindings.DB.prepare(
        "SELECT COUNT(*) AS n FROM deployments WHERE product_id=?",
      )
        .bind(id)
        .first("n"),
    ).toBe(1);
  });
  it("retains legacy workflow completion at Ready without automatic publication", async () => {
    const { id, stub } = await start();
    await runInDurableObject(stub, async (_instance, ctx) => {
      const state = await ctx.storage.get<any>("workflow");
      delete state.version;
      await ctx.storage.put("workflow", state);
    });
    for (let i = 0; i < 9; i++) await drive(stub);
    const approval = await bindings.DB.prepare(
      "SELECT id FROM approvals WHERE product_id=?",
    )
      .bind(id)
      .first<{ id: string }>();
    await get(`/api/approvals/${approval!.id}/approve`, {
      method: "POST",
      headers: authorize,
    });
    await runInDurableObject(stub, async (instance: any, ctx) => {
      await instance.alarm();
      expect((await ctx.storage.get<any>("workflow")).status).toBe("completed");
      await ctx.storage.deleteAlarm();
    });
    expect(
      await bindings.DB.prepare("SELECT stage FROM products WHERE id=?")
        .bind(id)
        .first("stage"),
    ).toBe("Ready");
    expect(
      await bindings.DB.prepare(
        "SELECT id FROM marketplace_releases WHERE product_id=?",
      )
        .bind(id)
        .first(),
    ).toBeNull();
  });
  it("blocks QA for a different artifact and never creates a promotion request", async () => {
    const { id, stub } = await start();
    for (let i = 0; i < 9; i++) await drive(stub, true);
    expect(await (await get(`/api/products/${id}`)).json()).toMatchObject({
      stage: "QA",
      status: "Attention",
    });
    expect(
      await bindings.DB.prepare("SELECT id FROM approvals WHERE product_id=?")
        .bind(id)
        .first(),
    ).toBeNull();
  });
  it("replays a durable journal after D1 projection fails without duplicate events", async () => {
    const { id, stub } = await start();
    await bindings.DB.exec(
      "CREATE TRIGGER fail_icvs BEFORE INSERT ON workflow_events BEGIN SELECT RAISE(FAIL, 'test projection unavailable'); END;",
    );
    await drive(stub);
    await runInDurableObject(stub, async (_instance, ctx) => {
      expect((await ctx.storage.get<any>("workflow")).pending).toBeDefined();
    });
    await bindings.DB.exec("DROP TRIGGER fail_icvs;");
    await drive(stub);
    const events = (
      await bindings.DB.prepare(
        "SELECT sequence FROM workflow_events WHERE product_id=? ORDER BY sequence",
      )
        .bind(id)
        .all<{ sequence: number }>()
    ).results;
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
    await runInDurableObject(stub, async (_instance, ctx) => {
      expect((await ctx.storage.get<any>("workflow")).pending).toBeUndefined();
    });
  });
  it("serializes portfolio resource allocation and reclaims expired leases", async () => {
    const stub = bindings.FACTORY_ACTOR!.get(
      bindings.FACTORY_ACTOR!.idFromName("allocation-test"),
    );
    const send = (path: string, owner: string) =>
      stub.fetch(`https://factory.internal/${path}`, {
        method: "POST",
        body: JSON.stringify({ owner }),
      });
    const results = await Promise.all(
      ["one", "two", "three"].map((owner) => send("allocate", owner)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 429]);
    expect((await send("allocate", "one")).status).toBe(200);
    await send("release", "one");
    expect((await send("allocate", "three")).status).toBe(200);
    await runInDurableObject(stub, async (_instance, ctx) => {
      await ctx.storage.put("leases", { expired: Date.now() - 1 });
    });
    expect((await send("allocate", "four")).status).toBe(200);
  });
});

describe("ICVS upgrade and terminal recovery", () => {
  it("adopts an existing Build handoff without duplicating the run or losing artifacts", async () => {
    const id = crypto.randomUUID();
    await bindings.DB.batch([
      bindings.DB.prepare(
        "INSERT INTO products(id,name,description,stage) VALUES (?,'Existing handoff','An existing detailed brief awaiting actual execution','Build')",
      ).bind(id),
      bindings.DB.prepare(
        "INSERT INTO factory_runs(id,product_id,status,stage) VALUES (?,?,'blocked','Build')",
      ).bind(id, id),
      bindings.DB.prepare(
        "INSERT INTO factory_outputs(id,run_id,engine,content) VALUES (?,?,'Specification','{}')",
      ).bind(id, id),
    ]);
    const response = await get(`/api/factory/${id}/run`, {
      method: "POST",
      headers: authorize,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id, stage: "Build" });
    const stub = bindings.FACTORY_ACTOR!.get(
      bindings.FACTORY_ACTOR!.idFromName(id),
    );
    await runInDurableObject(stub, async (_instance, ctx) => {
      await ctx.storage.deleteAlarm();
    });
    expect(
      await bindings.DB.prepare(
        "SELECT COUNT(*) AS count FROM factory_runs WHERE product_id=?",
      )
        .bind(id)
        .first("count"),
    ).toBe(1);
    expect(
      await bindings.DB.prepare("SELECT id FROM factory_outputs WHERE id=?")
        .bind(id)
        .first("id"),
    ).toBe(id);
  });
  it("retains the retry alarm until a terminal journal is projected", async () => {
    const id = crypto.randomUUID();
    await bindings.DB.prepare(
      "INSERT INTO products(id,name,description,stage) VALUES (?,'Terminal recovery','A detailed requirement for terminal journal recovery','Idea')",
    )
      .bind(id)
      .run();
    await get(`/api/factory/${id}/run`, { method: "POST", headers: authorize });
    const stub = bindings.FACTORY_ACTOR!.get(
      bindings.FACTORY_ACTOR!.idFromName(id),
    );
    // Inject the exact crash boundary (DO committed; terminal D1 batch not committed).
    await runInDurableObject(stub, async (_instance, ctx) => {
      await ctx.storage.deleteAlarm();
      const state = await ctx.storage.get<any>("workflow");
      state.sequence++;
      state.stage = "Archived";
      state.status = "completed";
      state.message = "Archive recovery";
      state.pending = {
        id: `${state.id}:${state.sequence}`,
        sequence: state.sequence,
        from: "Idea",
        to: "Archived",
        engine: "Archive",
        actor: "governor",
        reason: state.message,
        evidence: { deleted: false },
        at: new Date().toISOString(),
      };
      await ctx.storage.put("workflow", state);
    });
    await bindings.DB.exec(
      "CREATE TRIGGER terminal_failure BEFORE INSERT ON workflow_events BEGIN SELECT RAISE(FAIL, 'test unavailable'); END;",
    );
    await runInDurableObject(stub, async (instance: any, ctx) => {
      await instance.alarm();
      expect(await ctx.storage.getAlarm()).not.toBeNull();
      expect((await ctx.storage.get<any>("workflow")).pending).toBeDefined();
    });
    await bindings.DB.exec("DROP TRIGGER terminal_failure;");
    await runInDurableObject(stub, async (instance: any, ctx) => {
      await instance.alarm();
      expect(await ctx.storage.getAlarm()).toBeNull();
      expect((await ctx.storage.get<any>("workflow")).pending).toBeUndefined();
    });
    expect(await (await get(`/api/products/${id}`)).json()).toMatchObject({
      stage: "Archived",
    });
  });
});

// Public/customer flows use a separate entry point; fixtures stay in isolated test D1.
import marketplaceWorker from "../src/marketplace-worker";
import { sha256 } from "../src/access";
import { randomToken } from "../src/customer-auth";
import { validatePackage, validatePublication } from "../../../icvs/releases";
const marketOrigin = "https://max.test";
async function market(
  path: string,
  init: RequestInit = {},
  extra: Partial<Env> = {},
) {
  const headers = new Headers(init.headers);
  if (init.method === "POST") headers.set("Origin", marketOrigin);
  return marketplaceWorker.fetch(
    new Request(`${marketOrigin}${path}`, { ...init, headers }),
    { ...bindings, MARKETPLACE_ORIGIN: marketOrigin, ...extra },
  );
}
async function customerFixture() {
  const id = crypto.randomUUID(),
    token = randomToken();
  await bindings.DB.batch([
    bindings.DB.prepare(
      "INSERT INTO customer_accounts(id,identity_subject,name) VALUES (?,?,'Test Customer')",
    ).bind(id, id),
    bindings.DB.prepare("INSERT INTO customer_sessions VALUES (?,?,?)").bind(
      await sha256(token),
      id,
      Date.now() + 60000,
    ),
  ]);
  return { id, headers: { Cookie: `max_session=${token}` } };
}
async function releaseFixture(price = 0) {
  await bindings.DB.batch([
    bindings.DB.prepare(
      "INSERT INTO marketplace_creators(id,slug,name,bio) VALUES ('creator','creator','Test Creator','Public biography')",
    ),
    bindings.DB.prepare(
      "INSERT INTO marketplace_releases(id,product_id,slug,title,summary,type,creator_id,price_minor,currency,artifact,digest,download_ref) VALUES ('release','one','public-game','Public game','A public game description','app','creator',?, 'USD', 'https://test.invalid/artifact', 'a'.repeat(64), 'private-download-reference')",
    ).bind(price),
  ]);
}

describe("Ecosystem access boundaries", () => {
  it("denies anonymous and customer access to every operational surface", async () => {
    for (const path of [
      "/",
      "/api/dashboard",
      "/api/products",
      "/api/portfolio",
      "/api/approvals",
      "/api/analytics",
      "/api/forecasts",
      "/api/recommendations",
      "/api/revenue",
      "/api/publishing",
      "/api/departments",
      "/api/runtime",
      "/api/system-health",
      "/api/telemetry",
      "/api/processes",
      "/api/factory",
      "/api/decisions",
      "/api/kernel/ipc",
    ])
      expect(
        (await SELF.fetch(`https://portal.test${path}`)).status,
        path,
      ).toBe(401);
    const customer = await customerFixture();
    expect(
      (
        await SELF.fetch("https://portal.test/api/products", {
          headers: customer.headers,
        })
      ).status,
    ).toBe(401);
  });
  it("allows named operators to read operations while denying governor decisions", async () => {
    const extra = {
      STAFF_CREDENTIALS: JSON.stringify([
        {
          id: "operator-test",
          role: "Operator",
          tokenSha256: await sha256("operator-key"),
        },
      ]),
    };
    const read = new Request("https://portal.test/api/session", {
      headers: { Authorization: "Bearer operator-key" },
    });
    expect(
      await (
        await worker.fetch(
          read,
          { ...bindings, ...extra },
          createExecutionContext(),
        )
      ).json(),
    ).toEqual({ id: "operator-test", role: "Operator" });
    const mutation = new Request(
      "https://portal.test/api/approvals/001/approve",
      { method: "POST", headers: { Authorization: "Bearer operator-key" } },
    );
    expect(
      (
        await worker.fetch(
          mutation,
          { ...bindings, ...extra },
          createExecutionContext(),
        )
      ).status,
    ).toBe(403);
    expect(
      await bindings.DB.prepare(
        "SELECT status FROM approvals WHERE id='001'",
      ).first("status"),
    ).toBe("pending");
  });
  it("publishes only allowlisted catalog fields and denies private paths on public API", async () => {
    await releaseFixture();
    const result = (await (await market("/api/products")).json()) as {
      items: Record<string, unknown>[];
    };
    expect(result.items).toHaveLength(1);
    expect(Object.keys(result.items[0]).sort()).toEqual(
      [
        "id",
        "slug",
        "title",
        "summary",
        "type",
        "priceMinor",
        "currency",
        "publishedAt",
        "creatorName",
        "creatorSlug",
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /private-download|private.test|productId|score|workflow/,
    );
    for (const path of [
      "/api/dashboard",
      "/api/telemetry",
      "/api/kernel/ipc",
      "/api/revenue",
      "/api/factory",
    ])
      expect((await market(path)).status).toBe(404);
    expect((await market("/api/products?limit=1000")).status).toBe(400);
    expect(await (await market("/api/apps")).json()).toMatchObject({
      items: [],
    });
    await bindings.DB.prepare(
      "UPDATE marketplace_releases SET withdrawn_at=CURRENT_TIMESTAMP",
    ).run();
    expect((await market("/api/products/public-game")).status).toBe(404);
    expect(await (await market("/api/games")).json()).toMatchObject({
      items: [],
    });
  });
  it("blocks cross-origin mutations and malformed request bodies", async () => {
    expect(
      (
        await marketplaceWorker.fetch(
          new Request(`${marketOrigin}/api/auth/start`, {
            method: "POST",
            headers: { Origin: "https://evil.test" },
          }),
          { ...bindings, MARKETPLACE_ORIGIN: marketOrigin },
        )
      ).status,
    ).toBe(403);
    const user = await customerFixture();
    expect(
      (
        await market("/api/account", {
          method: "POST",
          headers: user.headers,
          body: "invalid",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await market("/api/account", {
          method: "POST",
          headers: user.headers,
          body: JSON.stringify({ name: "x".repeat(20000) }),
        })
      ).status,
    ).toBe(400);
  });
});

describe("Marketplace customer ownership and commerce", () => {
  it("verifies login state once and creates a customer-only session", async () => {
    let state = "";
    const identity = {
      fetch: async (url: string, init: RequestInit) => {
        const input = JSON.parse(init.body as string);
        if (url.endsWith("/start")) {
          state = input.state;
          return Response.json({
            url: `https://identity.test/login?state=${state}`,
          });
        }
        return Response.json({
          subject: "verified-subject",
          name: "Verified Customer",
        });
      },
    } as unknown as Fetcher;
    await market(
      "/api/auth/start",
      { method: "POST" },
      { CUSTOMER_IDENTITY: identity },
    );
    const wrong = await market(
      "/api/auth/complete",
      {
        method: "POST",
        headers: { Cookie: `max_login=${state}` },
        body: JSON.stringify({ state: "bad", code: "valid" }),
      },
      { CUSTOMER_IDENTITY: identity },
    );
    expect(wrong.status).toBe(400);
    const init = {
      method: "POST",
      headers: { Cookie: `max_login=${state}` },
      body: JSON.stringify({ state, code: "valid" }),
    };
    const completed = await market("/api/auth/complete", init, {
      CUSTOMER_IDENTITY: identity,
    });
    expect(completed.status).toBe(200);
    const cookie = completed.headers
      .get("Set-Cookie")!
      .match(/max_session=([a-f0-9]{64})/)![0];
    expect(
      await (
        await market("/api/account", { headers: { Cookie: cookie } })
      ).json(),
    ).toMatchObject({ name: "Verified Customer" });
    expect(
      (
        await market("/api/auth/complete", init, {
          CUSTOMER_IDENTITY: identity,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await SELF.fetch("https://portal.test/api/session", {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(401);
    await market("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(
      (await market("/api/account", { headers: { Cookie: cookie } })).status,
    ).toBe(401);
  });
  it("deduplicates free acquisitions, scopes libraries, and verifies downloads and reviews", async () => {
    await releaseFixture();
    const user = await customerFixture(),
      stranger = await customerFixture();
    expect(
      (
        await market("/api/downloads", {
          method: "POST",
          body: JSON.stringify({ releaseId: "release" }),
        })
      ).status,
    ).toBe(401);
    const buy = () =>
      market("/api/orders", {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({ releaseId: "release" }),
      });
    const results = await Promise.all([buy(), buy()]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(
      await bindings.DB.prepare(
        "SELECT COUNT(*) AS n FROM marketplace_orders",
      ).first("n"),
    ).toBe(1);
    expect(
      await (await market("/api/library", { headers: user.headers })).json(),
    ).toHaveLength(1);
    expect(
      await (
        await market("/api/library", { headers: stranger.headers })
      ).json(),
    ).toEqual([]);
    expect(
      (
        await market("/api/downloads", {
          method: "POST",
          headers: stranger.headers,
          body: JSON.stringify({ releaseId: "release" }),
        })
      ).status,
    ).toBe(403);
    const downloads = {
      fetch: async (_url: string, init: RequestInit) => {
        expect(JSON.parse(init.body as string)).toMatchObject({
          customerId: user.id,
          reference: "private-download-reference",
          expiresIn: 300,
        });
        return Response.json({ url: "https://downloads.test/signed-grant" });
      },
    } as unknown as Fetcher;
    expect(
      await (
        await market(
          "/api/downloads",
          {
            method: "POST",
            headers: user.headers,
            body: JSON.stringify({ releaseId: "release" }),
          },
          { DOWNLOADS: downloads },
        )
      ).json(),
    ).toEqual({ url: "https://downloads.test/signed-grant" });
    expect(
      (
        await market("/api/reviews", {
          method: "POST",
          headers: user.headers,
          body: JSON.stringify({
            releaseId: "release",
            rating: 6,
            body: "Great product",
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await market("/api/reviews", {
          method: "POST",
          headers: user.headers,
          body: JSON.stringify({
            releaseId: "release",
            rating: 5,
            body: "Great product",
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      await (await market("/api/products/public-game")).json(),
    ).toMatchObject({ reviews: [{ rating: 5, body: "Great product" }] });
    await market("/api/library/release", {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({ hidden: true }),
    });
    expect(
      await (await market("/api/library", { headers: user.headers })).json(),
    ).toEqual([]);
    expect(
      await (
        await market("/api/library?hidden=true", { headers: user.headers })
      ).json(),
    ).toHaveLength(1);
  });
  it("accepts only correlated provider payment evidence and revokes refunded download access", async () => {
    await releaseFixture(1999);
    const user = await customerFixture(),
      stranger = await customerFixture();
    let orderId = "",
      status = "paid",
      amount = 1998;
    const payments = {
      fetch: async (url: string, init?: RequestInit) => {
        if (url.endsWith("/checkout")) {
          const b = JSON.parse(init!.body as string);
          expect(b.amount).toBe(1999);
          orderId = b.orderId;
          return Response.json({
            id: "provider-order",
            url: "https://pay.test/checkout",
          });
        }
        return Response.json({ orderId, amount, currency: "USD", status });
      },
    } as unknown as Fetcher;
    const order = await market(
      "/api/orders",
      {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({ releaseId: "release", priceMinor: 1 }),
      },
      { PAYMENTS: payments },
    );
    expect(order.status).toBe(200);
    expect(
      (
        await market(
          `/api/orders/${orderId}`,
          { headers: stranger.headers },
          { PAYMENTS: payments },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await market(
          `/api/orders/${orderId}`,
          { headers: user.headers },
          { PAYMENTS: payments },
        )
      ).status,
    ).toBe(503);
    expect(
      await (await market("/api/library", { headers: user.headers })).json(),
    ).toEqual([]);
    amount = 1999;
    expect(
      await (
        await market(
          `/api/orders/${orderId}`,
          { headers: user.headers },
          { PAYMENTS: payments },
        )
      ).json(),
    ).toMatchObject({ status: "paid" });
    await market(
      `/api/orders/${orderId}`,
      { headers: user.headers },
      { PAYMENTS: payments },
    );
    expect(
      await bindings.DB.prepare(
        "SELECT COUNT(*) AS n FROM customer_library",
      ).first("n"),
    ).toBe(1);
    status = "refunded";
    await market(
      `/api/orders/${orderId}`,
      { headers: user.headers },
      { PAYMENTS: payments },
    );
    expect(
      (
        await market(
          "/api/downloads",
          {
            method: "POST",
            headers: user.headers,
            body: JSON.stringify({ releaseId: "release" }),
          },
          { PAYMENTS: payments },
        )
      ).status,
    ).toBe(403);
    expect(
      await (await market("/api/library", { headers: user.headers })).json(),
    ).toEqual([]);
    expect(await (await get("/api/revenue")).json()).toMatchObject({
      currencies: [{ currency: "USD", paidMinor: 0, refundedMinor: 1999 }],
    });
  });
});

describe("Release evidence and department projections", () => {
  it("rejects altered package artifacts and uncorrelated publishing receipts", () => {
    const build = {
      operationId: "run:Build",
      artifact: "https://test.invalid/artifact",
      digest: "a".repeat(64),
      checks: [],
    };
    const qa = {
      ...build,
      operationId: "run:QA",
      checks: [
        {
          requirement: "brief",
          passed: true,
          report: "https://test.invalid/report",
        },
      ],
    };
    expect(() =>
      validatePackage(
        {
          operationId: "run:Package",
          artifact: build.artifact,
          digest: "b".repeat(64),
        },
        "run:Package",
        build,
        qa,
      ),
    ).toThrow();
    expect(() =>
      validatePublication(
        {
          operationId: "wrong",
          packageDigest: "digest",
          downloadReference: "ref",
          receipt: "https://test.invalid/receipt",
        },
        "run:Publish",
        "digest",
      ),
    ).toThrow();
  });
  it("reports truthful missing capacity and all department operating fields", async () => {
    const departments = (await (
      await get("/api/departments")
    ).json()) as Record<string, unknown>[];
    expect(departments).toHaveLength(8);
    for (const d of departments) {
      expect(d).toHaveProperty("health");
      expect(d).toHaveProperty("capacity", null);
      expect(d).toHaveProperty("workload");
      expect(d).toHaveProperty("backlog");
      expect(d).toHaveProperty("kpis");
      expect(d).toHaveProperty("forecasts");
      expect(d).toHaveProperty("recommendations");
    }
  });
});

import { captureIntelligence } from "../src/universe-api";
import {
  executeTracked,
  reconcileCompensation,
  validateCompensation,
} from "../src/execution";
import { topology, spatialScene, scenes } from "../../../portal-os/universe";
describe("MAX Universe v2", () => {
  const post = (path: string, body: unknown) =>
    get(path, {
      method: "POST",
      headers: authorize,
      body: JSON.stringify(body),
    });
  it("keeps twins, graph, XR and marketplace intelligence private", async () => {
    for (const path of [
      "/api/ecosystem",
      "/api/intelligence",
      "/api/twin/graph",
      "/api/xr/ecosystem-galaxy",
      "/api/marketplace/operations",
      "/api/execution-workers",
    ]) {
      expect((await SELF.fetch(`https://portal.test${path}`)).status).toBe(401);
      expect((await market(path)).status).toBe(404);
    }
    const result = (await (await get("/api/ecosystem")).json()) as any;
    expect(result.summary).toMatchObject({
      products: 2,
      portfolioScore: 85,
      observedGrowthPct: null,
    });
    expect(result.summary.divisions).toBe(result.divisions.length);
    expect(result.divisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "max-apps" }),
        expect.objectContaining({ id: "quantum-xr" }),
      ]),
    );
    expect(result.rankings.health).toEqual([]);
    expect(result.products.find((p: any) => p.id === "one")).toMatchObject({
      users: null,
      health: null,
      previousRevenue: null,
    });
  });
  it("records immutable telemetry and excludes stale samples from current health", async () => {
    const body = {
      productId: "one",
      source: "test-sensor",
      observedAt: new Date().toISOString(),
      users: 45,
      health: 62,
    };
    expect((await post("/api/twin/telemetry", body)).status).toBe(201);
    expect((await post("/api/twin/telemetry", body)).status).toBe(200);
    expect(
      (await post("/api/twin/telemetry", { ...body, users: 1000 })).status,
    ).toBe(409);
    expect(
      (await post("/api/twin/telemetry", { ...body, health: 101 })).status,
    ).toBe(400);
    expect(
      (await post("/api/twin/telemetry", { ...body, users: -1 })).status,
    ).toBe(400);
    const twin = (await (await get("/api/twin/products/one")).json()) as any;
    expect(twin.product).toMatchObject({ users: 45, health: 62, risk: 25 });
    await bindings.DB.prepare(
      "UPDATE product_telemetry SET observed_at=? WHERE product_id='one'",
    )
      .bind(new Date(Date.now() - 2 * 86400000).toISOString())
      .run();
    const stale = (await (await get("/api/twin/products/one")).json()) as any;
    expect(stale.product).toMatchObject({ users: null, health: null, risk: 0 });
    expect(stale.product.telemetryAt).not.toBeNull();
  });
  it("maps dependencies, cycles and audited relationship retirement without changing lifecycle", async () => {
    expect(
      (
        await post("/api/twin/relationships", {
          id: "dep",
          sourceId: "one",
          targetId: "two",
          source: "test",
          relation: "depends_on",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await post("/api/twin/relationships", {
          id: "reverse",
          sourceId: "two",
          targetId: "one",
          source: "test",
          relation: "depends_on",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await post("/api/twin/relationships", {
          id: "self",
          sourceId: "one",
          targetId: "one",
          source: "test",
          relation: "depends_on",
        })
      ).status,
    ).toBe(400);
    await bindings.DB.prepare(
      "UPDATE products SET status='Attention' WHERE id='two'",
    ).run();
    const twin = (await (await get("/api/twin/products/one")).json()) as any;
    expect(twin.product).toMatchObject({
      stage: "Ready",
      blockedDependencies: ["two"],
      risk: 25,
    });
    const g = (await (
      await get("/api/twin/topology?root=product:one&depth=2")
    ).json()) as any;
    expect(g.nodes.some((n: any) => n.id === "product:two")).toBe(true);
    expect(new Set(g.nodes.map((n: any) => n.id)).size).toBe(g.nodes.length);
    expect(
      (await get("/api/twin/topology?root=product:one&depth=9")).status,
    ).toBe(400);
    expect((await get("/api/twin/topology?root=missing")).status).toBe(404);
    expect(
      (
        await post("/api/twin/relationships/dep/retire", {
          reason: "Upstream integration removed this dependency.",
        })
      ).status,
    ).toBe(200);
    expect(
      await bindings.DB.prepare(
        "SELECT retired_at FROM twin_relationships WHERE id='dep'",
      ).first("retired_at"),
    ).not.toBeNull();
    expect(
      ((await (await get("/api/twin/products/one")).json()) as any).product
        .dependencies,
    ).toEqual([]);
  });
  it("captures daily history idempotently and computes comparable revenue growth and server scenarios", async () => {
    await bindings.DB.prepare(
      "UPDATE products SET revenue=120 WHERE id='one'",
    ).run();
    await bindings.DB.prepare(
      "INSERT INTO intelligence_snapshots(product_id,day,revenue,score,stage,status) VALUES ('one',date('now','-8 days'),100,80,'Ready','On track'),('two',date('now','-8 days'),0,90,'Live','On track')",
    ).run();
    await captureIntelligence(bindings);
    await captureIntelligence(bindings);
    expect(
      await bindings.DB.prepare(
        "SELECT COUNT(*) AS count FROM intelligence_snapshots WHERE day=date('now')",
      ).first("count"),
    ).toBe(2);
    const u = (await (await get("/api/intelligence")).json()) as any;
    expect(u.products.find((p: any) => p.id === "one").observedGrowthPct).toBe(
      20,
    );
    expect(
      u.products.find((p: any) => p.id === "two").observedGrowthPct,
    ).toBeNull();
    expect(u.summary.observedGrowthPct).toBe(20);
    const forecasts = (await (
      await get("/api/intelligence/forecasts?months=3&growth=10")
    ).json()) as any;
    expect(forecasts.totals.scenario).toBeCloseTo(120 * 1.1 ** 3);
    expect(
      (await get("/api/intelligence/forecasts?months=100&growth=10")).status,
    ).toBe(400);
    expect(
      ((await (await get("/api/departments/GOV/history")).json()) as any)[0],
    ).toMatchObject({ queued: 1 });
    expect((await get("/api/departments/INVALID/history")).status).toBe(404);
  });
  it("exposes deterministic XR scene data with valid relationships and separate division command centres", async () => {
    for (const scene of scenes) {
      const g = (await (await get(`/api/xr/${scene}`)).json()) as any;
      expect(g).toMatchObject({ schemaVersion: 1, scene });
      const ids = new Set(g.nodes.map((n: any) => n.id));
      expect(
        g.edges.every((e: any) => ids.has(e.source) && ids.has(e.target)),
      ).toBe(true);
      expect(
        g.nodes.every(
          (n: any) =>
            Number.isFinite(n.position.x) && Number.isFinite(n.position.y),
        ),
      ).toBe(true);
    }
    expect((await get("/api/xr/unknown")).status).toBe(404);
    const d = (await (
      await get("/api/divisions/max-apps/command-centre")
    ).json()) as any;
    expect(d.division).toMatchObject({
      name: "MAX Apps",
      products: 0,
      health: "No product data",
    });
    expect((await get("/api/divisions/unknown/command-centre")).status).toBe(
      404,
    );
  });
  it("computes marketplace analytics without multiplying orders by downloads or exposing customers", async () => {
    await releaseFixture(500);
    const c = await customerFixture();
    await bindings.DB.batch([
      bindings.DB.prepare(
        "INSERT INTO marketplace_orders(id,customer_id,release_id,price_minor,currency,status) VALUES ('order',?,'release',500,'USD','paid')",
      ).bind(c.id),
      bindings.DB.prepare(
        "INSERT INTO customer_library(customer_id,release_id) VALUES (?,'release')",
      ).bind(c.id),
      bindings.DB.prepare(
        "INSERT INTO marketplace_downloads(id,customer_id,release_id) VALUES ('dl1',?,'release'),('dl2',?,'release')",
      ).bind(c.id, c.id),
    ]);
    const result = (await (
      await get("/api/marketplace/operations")
    ).json()) as any;
    expect(result.products[0]).toMatchObject({
      downloads: 2,
      paidOrders: 1,
      libraries: 1,
    });
    expect(result.currencies[0]).toMatchObject({
      currency: "USD",
      paidMinor: 500,
    });
    expect(JSON.stringify(result)).not.toContain(c.id);
  });
  it("records retries, blocks invalid or expired evidence and completes compensation only with a matching receipt", async () => {
    await bindings.DB.prepare(
      "INSERT INTO factory_runs(id,product_id,status,stage) VALUES ('monitor-run','one','blocked','Package')",
    ).run();
    const operation = {
      id: "op",
      productId: "one",
      runId: "monitor-run",
      worker: "Build",
      leaseExpiresAt: Date.now() + 60000,
    };
    const fake = {
      fetch: async () => Response.json({ bad: true }),
    } as unknown as Fetcher;
    await expect(
      executeTracked(
        bindings,
        operation,
        fake,
        "https://test.invalid",
        {},
        () => {
          throw new Error("Missing evidence");
        },
      ),
    ).rejects.toThrow("Missing evidence");
    expect(
      await bindings.DB.prepare(
        "SELECT attempts,status FROM worker_operations WHERE id='op'",
      ).first(),
    ).toMatchObject({ attempts: 1, status: "blocked" });
    await expect(
      executeTracked(
        bindings,
        { ...operation, leaseExpiresAt: Date.now() - 1 },
        fake,
        "https://test.invalid",
        {},
        (v) => v,
      ),
    ).rejects.toThrow("lease expired");
    const plan = {
      buildArtifact: "https://test.invalid/build",
      buildDigest: "a".repeat(64),
      packageDigest: "b".repeat(64),
    };
    await bindings.DB.prepare(
      "INSERT INTO compensation_jobs(id,product_id,run_id,approval_id,status,plan) VALUES ('cleanup','one','monitor-run','001','queued',?)",
    )
      .bind(JSON.stringify(plan))
      .run();
    await reconcileCompensation(bindings);
    expect(
      await bindings.DB.prepare(
        "SELECT status FROM compensation_jobs WHERE id='cleanup'",
      ).first("status"),
    ).toBe("blocked");
    expect(() =>
      validateCompensation(
        {
          operationId: "cleanup",
          ...plan,
          packageDigest: "wrong",
          reversed: true,
          receipt: "https://test.invalid/receipt",
        },
        "cleanup",
        plan,
      ),
    ).toThrow("does not match");
    await bindings.DB.prepare(
      "UPDATE compensation_jobs SET next_attempt=0 WHERE id='cleanup'",
    ).run();
    let calls = 0;
    const extra = {
      ...bindings,
      ICVS_COMPENSATOR: {
        fetch: async () => {
          calls++;
          return Response.json({
            operationId: "cleanup",
            ...plan,
            reversed: true,
            receipt: "https://test.invalid/receipt",
          });
        },
      } as unknown as Fetcher,
    };
    await bindings.DB.exec(
      "CREATE TRIGGER fail_compensation BEFORE UPDATE ON compensation_jobs WHEN NEW.status='completed' BEGIN SELECT RAISE(FAIL, 'test projection failure'); END;",
    );
    await reconcileCompensation(extra);
    expect(
      await bindings.DB.prepare(
        "SELECT status FROM compensation_jobs WHERE id='cleanup'",
      ).first("status"),
    ).toBe("blocked");
    await bindings.DB.exec("DROP TRIGGER fail_compensation;");
    await bindings.DB.prepare(
      "UPDATE compensation_jobs SET next_attempt=0 WHERE id='cleanup'",
    ).run();
    await reconcileCompensation(extra);
    await reconcileCompensation(extra);
    expect(calls).toBe(1);
    expect(
      await bindings.DB.prepare(
        "SELECT status,evidence FROM compensation_jobs WHERE id='cleanup'",
      ).first(),
    ).toMatchObject({
      status: "completed",
      evidence: expect.stringContaining("receipt"),
    });
    expect(
      await bindings.DB.prepare("PRAGMA foreign_key_check")
        .all()
        .then((r) => r.results),
    ).toEqual([]);
  });
});

describe("V2 automation credentials and input boundaries", () => {
  it("limits automation to explicit ingestion scopes and preserves staff Governor permissions", async () => {
    const extra = {
      ...bindings,
      AUTOMATION_CREDENTIALS: JSON.stringify([
        {
          id: "test-ingestion",
          tokenSha256: await sha256("test-ingest-token"),
          scopes: ["telemetry:write"],
        },
      ]),
      STAFF_CREDENTIALS: JSON.stringify([
        {
          id: "operator",
          role: "Operator",
          tokenSha256: await sha256("operator-token"),
        },
      ]),
    };
    async function call(path: string, token: string, body?: unknown) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`https://portal.test${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { Authorization: `Bearer ${token}` },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        extra,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    }
    const telemetry = {
      productId: "one",
      source: "test-ingestion",
      observedAt: new Date().toISOString(),
      users: 3,
    };
    expect(
      (await call("/api/twin/telemetry", "test-ingest-token", telemetry))
        .status,
    ).toBe(201);
    for (const path of ["/api/session", "/api/ecosystem", "/api/decisions"])
      expect((await call(path, "test-ingest-token")).status).toBe(403);
    expect(
      (
        await call("/api/twin/relationships", "test-ingest-token", {
          id: "blocked",
        })
      ).status,
    ).toBe(403);
    expect(
      (await call("/api/approvals/001/approve", "test-ingest-token", {}))
        .status,
    ).toBe(403);
    expect(
      (await call("/api/twin/telemetry", "operator-token", telemetry)).status,
    ).toBe(403);
    expect((await call("/api/ecosystem", "operator-token")).status).toBe(200);
    expect(
      await bindings.DB.prepare(
        "SELECT actor,status FROM access_audit WHERE resource='/api/twin/telemetry' AND actor='test-ingestion' ORDER BY rowid DESC LIMIT 1",
      ).first(),
    ).toEqual({ actor: "test-ingestion", status: 201 });
  });
  it("rejects malformed payloads and resolves concurrent observation conflicts", async () => {
    for (const body of [
      "[]",
      "null",
      "not json",
      JSON.stringify({ value: "x".repeat(17000) }),
    ])
      expect(
        (
          await get("/api/twin/telemetry", {
            method: "POST",
            headers: authorize,
            body,
          })
        ).status,
      ).toBe(400);
    const data = {
      productId: "one",
      source: "parallel-fixture",
      observedAt: new Date().toISOString(),
      health: 70,
    };
    const statuses = await Promise.all(
      [1, 2].map((users) =>
        get("/api/twin/telemetry", {
          method: "POST",
          headers: authorize,
          body: JSON.stringify({ ...data, users }),
        }).then((r) => r.status),
      ),
    );
    expect(statuses.sort()).toEqual([201, 409]);
    expect((await get("/api/twin/graph-unknown")).status).toBe(404);
    expect(
      (await get("/api/xr/product-constellation?root=department:GOV")).status,
    ).toBe(404);
  });
});
