import { describe, it, expect } from "vitest";
import { requestCapability, CapabilityRevokedError } from "../src/capabilities/index.js";

describe("Capabilities", () => {
  it("grants capability within scope", () => {
    let capKind: string | null = null;

    requestCapability("filesystem", { root: "/tmp", readonly: true }, (cap) => {
      capKind = cap.kind;
      expect(cap._revoked).toBe(false);
    });

    expect(capKind).toBe("filesystem");
  });

  it("revokes capability after scope exits", () => {
    let capturedCap: { _revoked: boolean } | null = null;

    requestCapability("network", { allowedHosts: ["example.com"] }, (cap) => {
      capturedCap = cap;
    });

    expect(capturedCap!._revoked).toBe(true);
  });

  it("revokes capability even on exception", () => {
    let capturedCap: { _revoked: boolean } | null = null;

    try {
      requestCapability("process", { allowedCommands: ["ls"], strictMode: true }, (cap) => {
        capturedCap = cap;
        throw new Error("intentional");
      });
    } catch {
      // expected
    }

    expect(capturedCap!._revoked).toBe(true);
  });

  it("returns value from operation", () => {
    const result = requestCapability("filesystem", { root: "/data", readonly: true }, (_cap) => {
      return 42;
    });

    expect(result).toBe(42);
  });

  it("scope cannot be re-entered after exit", () => {
    let savedOp: (() => void) | null = null;

    requestCapability("network", { allowedHosts: ["api.example.com"] }, (cap) => {
      savedOp = () => {
        if (cap._revoked) throw new CapabilityRevokedError(cap.kind);
      };
    });

    expect(() => savedOp!()).toThrow(CapabilityRevokedError);
  });
});
