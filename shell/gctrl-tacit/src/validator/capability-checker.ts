import type { CapabilityGrant, CapabilityKind, CapabilityViolation } from "../types.js";
import { stripStringLiterals, stripComments } from "./patterns.js";

interface OperationMapping {
  readonly pattern: RegExp;
  readonly requiredCapability: CapabilityKind;
  readonly operation: string;
}

const OPERATION_MAPPINGS: ReadonlyArray<OperationMapping> = [
  // Filesystem operations — require qualified access or known fs API names
  { pattern: /\bfs\.\w+|readFile\s*\(|writeFile\s*\(|mkdir\s*\(|readdir\s*\(|unlink\s*\(|stat\s*\(/, requiredCapability: "filesystem", operation: "file I/O" },
  { pattern: /\bpath\.(join|resolve|dirname|basename)\s*\(/, requiredCapability: "filesystem", operation: "path manipulation" },

  // Network operations — require call-site evidence
  { pattern: /\bfetch\s*\(|\bhttpGet\s*\(|\bhttpPost\s*\(|\baxios\s*[.(]/, requiredCapability: "network", operation: "HTTP request" },
  { pattern: /\bnew\s+WebSocket\s*\(/, requiredCapability: "network", operation: "socket connection" },
  { pattern: /\bdns\.(lookup|resolve)\s*\(/, requiredCapability: "network", operation: "DNS resolution" },

  // Process operations — require call-site or module reference
  { pattern: /\bexecFile\s*\(|\bspawn\s*\(|\bfork\s*\(|\bchild_process\b/, requiredCapability: "process", operation: "process execution" },

  // LLM operations — require SDK-specific patterns, not generic words
  { pattern: /\banthropic\.\w+|\bopenai\.\w+|\bChatCompletion\b|\bmessages\.create\s*\(/, requiredCapability: "llm", operation: "LLM SDK usage" },

  // Database operations — require SQL keywords in likely-query context or known DB APIs
  { pattern: /\.(query|execute|prepare|transaction)\s*\(/, requiredCapability: "database", operation: "database query" },
  { pattern: /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|DROP TABLE)\b/, requiredCapability: "database", operation: "SQL statement" },

  // Secrets operations
  { pattern: /\bprocess\.env\b|\bgetSecret\s*\(|\bvaultGet\s*\(/, requiredCapability: "secrets", operation: "secret access" },
];

export function checkCapabilities(
  code: string,
  grantedCapabilities: ReadonlyArray<CapabilityGrant>,
): ReadonlyArray<CapabilityViolation> {
  const granted = new Set(grantedCapabilities.map((c) => c.kind));
  const cleaned = stripStringLiterals(stripComments(code));
  const lines = cleaned.split("\n");
  const violations: CapabilityViolation[] = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    for (const mapping of OPERATION_MAPPINGS) {
      if (mapping.pattern.test(line) && !granted.has(mapping.requiredCapability)) {
        violations.push({
          required: mapping.requiredCapability,
          operation: mapping.operation,
          line: lineIdx + 1,
        });
      }
    }
  }

  return deduplicateViolations(violations);
}

function deduplicateViolations(
  violations: ReadonlyArray<CapabilityViolation>,
): ReadonlyArray<CapabilityViolation> {
  const seen = new Set<string>();
  return violations.filter((v) => {
    const key = `${v.required}:${v.operation}:${v.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
