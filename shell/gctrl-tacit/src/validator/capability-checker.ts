import type { CapabilityGrant, CapabilityKind, CapabilityViolation } from "../types.js";

interface OperationMapping {
  readonly pattern: RegExp;
  readonly requiredCapability: CapabilityKind;
  readonly operation: string;
}

const OPERATION_MAPPINGS: ReadonlyArray<OperationMapping> = [
  // Filesystem operations
  { pattern: /\breadFile\b|\bwriteFile\b|\bmkdir\b|\breaddir\b|\bunlink\b|\bstat\b/, requiredCapability: "filesystem", operation: "file I/O" },
  { pattern: /\bpath\.(join|resolve|dirname|basename)\b/, requiredCapability: "filesystem", operation: "path manipulation" },

  // Network operations
  { pattern: /\bfetch\b|\bhttpGet\b|\bhttpPost\b|\baxios\b/, requiredCapability: "network", operation: "HTTP request" },
  { pattern: /\bWebSocket\b|\bSocket\b/, requiredCapability: "network", operation: "socket connection" },
  { pattern: /\bdns\.(lookup|resolve)\b/, requiredCapability: "network", operation: "DNS resolution" },

  // Process operations
  { pattern: /\bexec\b|\bspawn\b|\bfork\b|\bexecFile\b/, requiredCapability: "process", operation: "process execution" },
  { pattern: /\bchild_process\b/, requiredCapability: "process", operation: "child process" },

  // LLM operations
  { pattern: /\bchat\b|\bcomplete\b|\bembed\b|\bgenerate\b/, requiredCapability: "llm", operation: "LLM invocation" },
  { pattern: /\banthropic\b|\bopenai\b|\bClaude\b|\bChatCompletion\b/, requiredCapability: "llm", operation: "LLM SDK usage" },

  // Database operations
  { pattern: /\bquery\b|\bexecute\b|\bprepare\b|\btransaction\b/, requiredCapability: "database", operation: "database query" },
  { pattern: /\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bCREATE\b|\bDROP\b/i, requiredCapability: "database", operation: "SQL statement" },

  // Secrets operations
  { pattern: /\bprocess\.env\b|\bgetSecret\b|\bvaultGet\b/, requiredCapability: "secrets", operation: "secret access" },
];

export function checkCapabilities(
  code: string,
  grantedCapabilities: ReadonlyArray<CapabilityGrant>,
): ReadonlyArray<CapabilityViolation> {
  const granted = new Set(grantedCapabilities.map((c) => c.kind));
  const lines = code.split("\n");
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
