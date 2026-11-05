import { AsyncState } from "./AsyncState";
import { getTelemetryStats } from "../api/telemetry";
import { useApi } from "../hooks/useApi";

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleTimeString();
}

/** Displays only recorded QAL metrics; the portal API client supplies staff auth. */
export function TelemetryStatsPanel() {
  const telemetry = useApi(getTelemetryStats, 5000);
  const measured = telemetry.data?.metrics.status === "MEASURED";

  return (
    <section className="telemetry-stats" aria-labelledby="qal-telemetry-title">
      <div className="telemetry-health-heading">
        <h3 id="qal-telemetry-title">QAL verification evidence</h3>
        <span>{telemetry.loading ? "Refreshing" : telemetry.error ? "Unavailable" : "24-hour window"}</span>
      </div>
      <AsyncState
        data={telemetry.data}
        loading={telemetry.loading}
        error={telemetry.error}
        retry={telemetry.reload}
      />
      {telemetry.data && (
        <dl className="telemetry-stats-grid">
          <div>
            <dt>Average verification latency</dt>
            <dd>{measured ? `${telemetry.data.metrics.avgLatencyMs} ms` : "UNKNOWN / UNMEASURED"}</dd>
          </div>
          <div>
            <dt>Verification records · 24h</dt>
            <dd>{telemetry.data.metrics.totalVerifications24h}</dd>
          </div>
          <div>
            <dt>D1 query time</dt>
            <dd>{telemetry.data.edgeQueryTimeMs} ms</dd>
          </div>
          <div>
            <dt>Last sampled</dt>
            <dd>{formatTime(telemetry.data.measuredAt)}</dd>
          </div>
        </dl>
      )}
      <p className="telemetry-stats-note">
        Latency is an average of recorded verification log entries, not a performance guarantee.
      </p>
    </section>
  );
}
