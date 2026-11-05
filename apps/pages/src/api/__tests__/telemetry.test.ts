import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStaffToken } from "../client";
import { getTelemetryStats } from "../telemetry";

const sample = {
  measuredAt: "2026-03-05T12:00:00Z",
  edgeQueryTimeMs: 1.45,
  metrics: {
    avgLatencyMs: 1.82,
    totalVerifications24h: 1240,
    status: "MEASURED" as const,
  },
};

describe("getTelemetryStats", () => {
  beforeEach(() => {
    setStaffToken("test-staff-token");
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    setStaffToken("");
    vi.unstubAllGlobals();
  });

  it("returns the measured telemetry payload using the authenticated API client", async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json(sample),
    );

    await expect(getTelemetryStats()).resolves.toEqual(sample);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/telemetry/stats");
    expect(new Headers(options?.headers).get("Authorization")).toBe(
      "Bearer test-staff-token",
    );
    expect(new Headers(options?.headers).get("X-Staff-Auth")).toBeNull();
  });

  it("preserves unknown values when there are no verification records", async () => {
    const unmeasured = {
      ...sample,
      metrics: {
        avgLatencyMs: null,
        totalVerifications24h: 0,
        status: "UNKNOWN" as const,
      },
    };
    vi.mocked(fetch).mockResolvedValue(Response.json(unmeasured));

    await expect(getTelemetryStats()).resolves.toEqual(unmeasured);
  });

  it("surfaces API errors instead of presenting a failed request as an empty result", async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ error: "Portal data is unavailable" }, { status: 500 }),
    );

    await expect(getTelemetryStats()).rejects.toThrow(
      "Portal data is unavailable",
    );
  });
});
