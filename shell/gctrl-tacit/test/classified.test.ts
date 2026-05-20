import { describe, it, expect } from "vitest";
import { classify, isClassified, classifyRecord, createRevealPermission } from "../src/classified/index.js";

describe("Classified", () => {
  it("wraps a value", () => {
    const secret = classify("my-password");
    expect(isClassified(secret)).toBe(true);
  });

  it("toString returns redacted form", () => {
    const secret = classify("sensitive-data");
    expect(secret.toString()).toBe("Classified(****)");
    expect(`${secret}`).toBe("Classified(****)");
  });

  it("map applies pure transformation", () => {
    const secret = classify("hello-world");
    const mapped = secret.map((s) => s.length);
    expect(isClassified(mapped)).toBe(true);
    expect(mapped.toString()).toBe("Classified(****)");
  });

  it("flatMap chains classified values", () => {
    const secret = classify("password");
    const result = secret.flatMap((s) => classify(s.toUpperCase()));
    expect(isClassified(result)).toBe(true);
  });

  it("classifyRecord wraps specified keys", () => {
    const record = { name: "Alice", ssn: "123-45-6789", age: 30 };
    const classified = classifyRecord(record, ["ssn"]);
    expect(classified.name).toBe("Alice");
    expect(classified.age).toBe(30);
    expect(isClassified(classified.ssn)).toBe(true);
  });

  it("isClassified returns false for non-classified values", () => {
    expect(isClassified("hello")).toBe(false);
    expect(isClassified(42)).toBe(false);
    expect(isClassified(null)).toBe(false);
    expect(isClassified({})).toBe(false);
  });
});
