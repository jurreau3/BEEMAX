import { BemaxLogoCanvas } from "../components/BemaxLogoCanvas";
import Dashboard from "./Dashboard";

const sampleTelemetry = [
  ["Microkernel Runtime", "ACTIVE"],
  ["D1 Relational Ledger", "SYNCHRONIZED"],
  ["QAL Ed25519 Check", "SECURE"],
];

/** Keeps the existing live dashboard and adds the supplied telemetry visualization. */
export default function PortalDashboard() {
  return (
    <>
      <section className="panel telemetry-panel" aria-labelledby="telemetry-title">
        <header className="telemetry-heading">
          <div>
            <div className="eyebrow">PORTAL-OS1 / STAFF TELEMETRY</div>
            <h2 id="telemetry-title">Substrate Signal Matrix</h2>
            <p>Sovereign Edge Microkernel &amp; Invariant Substrate Status</p>
          </div>
          <span className="telemetry-invariant">INVARIANT: I a gainst I</span>
        </header>
        <div className="telemetry-grid">
          <BemaxLogoCanvas width="100%" height="360px" />
          <aside className="telemetry-health" aria-label="Sample node health">
            <div className="telemetry-health-heading">
              <h3>Node Health</h3>
              <span>Sample values</span>
            </div>
            <dl>
              {sampleTelemetry.map(([label, status]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{status}</dd>
                </div>
              ))}
            </dl>
            <p>These illustrative statuses are not connected to live telemetry.</p>
          </aside>
        </div>
      </section>
      <Dashboard />
    </>
  );
}
