import { api } from "./client";

export interface TelemetryStats {
  measuredAt: string;
  edgeQueryTimeMs: number;
  metrics: {
    avgLatencyMs: number | null;
    totalVerifications24h: number;
    status: "MEASURED" | "UNKNOWN";
  };
}

export const getTelemetryStats = (signal?: AbortSignal) =>
  api<TelemetryStats>("/api/telemetry/stats", { signal });
