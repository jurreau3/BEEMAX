import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { portalClient, type QalVerifyPayload } from "../portalClient";

describe("PortalApiClient (portalClient.ts)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("getHealth()", () => {
    it("returns microkernel health and invariant marker", async () => {
      const mockHealthResponse = {
        status: "ONLINE" as const,
        kernel: "Portal-OS v1.0.0-PROD",
        invariant: "I a gainst I",
        timestamp: "2026-11-01T00:00:00.000Z",
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => mockHealthResponse,
        }),
      );

      const data = await portalClient.getHealth();

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/health$/),
        expect.objectContaining({
          method: "GET",
          headers: { "Content-Type": "application/json" },
        }),
      );
      expect(data).toEqual(mockHealthResponse);
      expect(data.invariant).toBe("I a gainst I");
    });

    it("throws when the health endpoint returns a non-OK status", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 500 }),
      );

      await expect(portalClient.getHealth()).rejects.toThrow(
        "Health telemetry check failed with status: 500",
      );
    });
  });

  describe("verifyQalCipher()", () => {
    const mockPayload: QalVerifyPayload = {
      cipherId: "CIPHER_9901",
      payload: "BEEMAX_SUBSTRATE_DATA",
      signature: "a1b2c3d4".repeat(16),
      publicKey: "e5f6a7b8".repeat(8),
      phaseTransition: "PHASE_AUTUMN_DROP",
    };

    it("returns the verified response for a valid signature", async () => {
      const mockQalResponse = {
        verified: true,
        provenance: "SOVEREIGN_AUTHENTIC",
        cipherId: "CIPHER_9901",
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => mockQalResponse,
        }),
      );

      const result = await portalClient.verifyQalCipher(mockPayload);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/qal\/verify$/),
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mockPayload),
        }),
      );
      expect(result.verified).toBe(true);
      expect(result.provenance).toBe("SOVEREIGN_AUTHENTIC");
    });

    it("handles HTTP 401 unauthorized signatures without throwing", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 401 }),
      );

      const result = await portalClient.verifyQalCipher(mockPayload);

      expect(result.verified).toBe(false);
      expect(result.provenance).toBe("UNAUTHORIZED_FORK_OR_INVALID_SIGNATURE");
      expect(result.error).toBe("UNAUTHORIZED_FORK_OR_INVALID_SIGNATURE");
      expect(result.cipherId).toBe(mockPayload.cipherId);
    });

    it("throws the Worker error for an internal server failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: async () => ({ error: "INTERNAL_MICROKERNEL_ERROR" }),
        }),
      );

      await expect(portalClient.verifyQalCipher(mockPayload)).rejects.toThrow(
        "INTERNAL_MICROKERNEL_ERROR",
      );
    });

    it("uses a status-based error when the error response is not JSON", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          json: async () => {
            throw new Error("invalid JSON");
          },
        }),
      );

      await expect(portalClient.verifyQalCipher(mockPayload)).rejects.toThrow(
        "QAL verification failed with status: 503",
      );
    });
  });
});
