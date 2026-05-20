import type { Violation } from "../types.js";

export interface ForbiddenPattern {
  readonly pattern: RegExp;
  readonly rule: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}

const FORBIDDEN_PATTERNS: ReadonlyArray<ForbiddenPattern> = [
  // Direct I/O bypassing capabilities
  { pattern: /\bfs\.(readFile|writeFile|mkdir|rmdir|unlink|rename|copyFile)\b/, rule: "no-direct-fs", message: "Direct fs access bypasses capability scoping — use requestCapability('filesystem', ...)", severity: "error" },
  { pattern: /\bchild_process\b/, rule: "no-child-process", message: "Direct child_process bypasses capability scoping — use requestCapability('process', ...)", severity: "error" },
  { pattern: /\bexec\(|execSync\(|spawn\(|spawnSync\(|fork\(/, rule: "no-exec", message: "Process execution requires a process capability", severity: "error" },
  { pattern: /\bDeno\.(run|command)\b/, rule: "no-deno-exec", message: "Deno process execution bypasses capability scoping", severity: "error" },

  // Network access bypassing capabilities
  { pattern: /\bfetch\(/, rule: "no-direct-fetch", message: "Direct fetch bypasses network capability scoping — use requestCapability('network', ...)", severity: "error" },
  { pattern: /\bnew\s+WebSocket\b/, rule: "no-websocket", message: "WebSocket creation requires a network capability", severity: "error" },
  { pattern: /\bhttp\.(get|request|createServer)\b/, rule: "no-direct-http", message: "Direct http module usage bypasses capability scoping", severity: "error" },
  { pattern: /\bnet\.(connect|createConnection|createServer)\b/, rule: "no-direct-net", message: "Direct net module usage bypasses capability scoping", severity: "error" },
  { pattern: /\bdgram\.createSocket\b/, rule: "no-dgram", message: "Direct UDP socket creation bypasses capability scoping", severity: "error" },

  // Eval and dynamic code
  { pattern: /\beval\(/, rule: "no-eval", message: "eval() can bypass all capability boundaries", severity: "error" },
  { pattern: /\bnew\s+Function\(/, rule: "no-new-function", message: "new Function() can bypass all capability boundaries", severity: "error" },
  { pattern: /\bimport\(/, rule: "no-dynamic-import", message: "Dynamic import() can load modules that bypass capabilities", severity: "error" },
  { pattern: /\brequire\(/, rule: "no-require", message: "require() can load modules that bypass capabilities", severity: "error" },

  // Global access
  { pattern: /\bprocess\.env\b/, rule: "no-process-env", message: "Direct process.env access can leak secrets — use requestCapability('secrets', ...)", severity: "error" },
  { pattern: /\bprocess\.exit\b/, rule: "no-process-exit", message: "process.exit() is not allowed in sandboxed code", severity: "error" },
  { pattern: /\bglobalThis\b/, rule: "no-globalthis", message: "globalThis access can escape the capability sandbox", severity: "warning" },

  // Prototype pollution
  { pattern: /\.__proto__\b/, rule: "no-proto", message: "__proto__ access can pollute prototypes and escape sandboxing", severity: "error" },
  { pattern: /\bObject\.(setPrototypeOf|defineProperty|defineProperties)\b/, rule: "no-prototype-mutation", message: "Prototype mutation can escape the capability sandbox", severity: "error" },
  { pattern: /\bReflect\.(setPrototypeOf|defineProperty|apply|construct)\b/, rule: "no-reflect-mutation", message: "Reflect API can escape the capability sandbox", severity: "error" },
  { pattern: /\bProxy\b/, rule: "no-proxy", message: "Proxy can intercept and bypass capability checks", severity: "error" },

  // Timing attacks / side channels
  { pattern: /\bsetTimeout\(|setInterval\(/, rule: "no-timers", message: "Timers can be used for side-channel attacks — use scoped scheduling", severity: "warning" },

  // Classified value leakage indicators
  { pattern: /\bconsole\.(log|warn|error|info|debug|trace)\b/, rule: "no-console", message: "console output can leak classified values — use the provided output channel", severity: "warning" },
  { pattern: /\bJSON\.stringify\b/, rule: "warn-stringify", message: "JSON.stringify may serialize classified values — ensure no classified data reaches serialization", severity: "warning" },
];

export function stripStringLiterals(code: string): string {
  return code
    .replace(/`(?:[^`\\]|\\.)*`/gs, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""');
}

export function stripComments(code: string): string {
  return code
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

export function validatePatterns(code: string): ReadonlyArray<Violation> {
  const cleaned = stripStringLiterals(stripComments(code));
  const lines = cleaned.split("\n");
  const violations: Violation[] = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    for (const forbidden of FORBIDDEN_PATTERNS) {
      const match = forbidden.pattern.exec(line);
      if (match) {
        violations.push({
          rule: forbidden.rule,
          message: forbidden.message,
          line: lineIdx + 1,
          column: match.index + 1,
          severity: forbidden.severity,
        });
      }
    }
  }

  return violations;
}

export function addCustomPattern(pattern: ForbiddenPattern): ForbiddenPattern {
  return pattern;
}
