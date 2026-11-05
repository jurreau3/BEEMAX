/**
 * Portal-OS1 Sovereign Edge API Client
 * Binds Portal-OS1 React surfaces to Cloudflare Worker endpoints and QAL verification.
 */

export interface HealthResponse {
  status: "ONLINE" | "OFFLINE";
  kernel: string;
  invariant: string;
  timestamp: string;
}

export interface QalVerifyPayload {
  cipherId: string;
  payload: string;
  signature: string;
  publicKey: string;
  phaseTransition: string;
}

export interface QalVerifyResponse {
  verified: boolean;
  provenance: string;
  cipherId: string;
  error?: string;
  details?: string;
}

class PortalApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl || (typeof window !== "undefined" ? window.location.origin : "http://localhost:8787")).replace(/\/+$/, "");
  }

  /** Fetch microkernel health and sovereign telemetry state. */
  async getHealth(): Promise<HealthResponse> {
    const response = await fetch(`${this.baseUrl}/health`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Health telemetry check failed with status: ${response.status}`);
    }

    return response.json() as Promise<HealthResponse>;
  }

  /** Submit an Ed25519 payload for Quantum-Auth Layer (QAL) verification. */
  async verifyQalCipher(payload: QalVerifyPayload): Promise<QalVerifyResponse> {
    const response = await fetch(`${this.baseUrl}/api/qal/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (response.status === 401) {
      return {
        verified: false,
        provenance: "UNAUTHORIZED_FORK_OR_INVALID_SIGNATURE",
        cipherId: payload.cipherId,
        error: "UNAUTHORIZED_FORK_OR_INVALID_SIGNATURE",
      };
    }

    if (!response.ok) {
      const errorData: unknown = await response.json().catch(() => ({}));
      const message =
        typeof errorData === "object" && errorData !== null && "error" in errorData &&
        typeof errorData.error === "string"
          ? errorData.error
          : `QAL verification failed with status: ${response.status}`;
      throw new Error(message);
    }

    return response.json() as Promise<QalVerifyResponse>;
  }
}

export const portalClient = new PortalApiClient();
export default portalClient;
