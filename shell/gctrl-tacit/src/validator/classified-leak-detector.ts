import type { ClassifiedLeak } from "../types.js";

interface LeakPatternDef {
  readonly pattern: RegExp;
  readonly channel: ClassifiedLeak["channel"];
  readonly argGroup: number;
}

const LEAK_PATTERNS: ReadonlyArray<LeakPatternDef> = [
  // stdout channels
  { pattern: /console\.(log|warn|error|info|debug|trace)\s*\(([^)]*)\)/, channel: "stdout", argGroup: 2 },
  { pattern: /process\.stdout\.write\s*\(([^)]*)\)/, channel: "stdout", argGroup: 1 },
  { pattern: /process\.stderr\.write\s*\(([^)]*)\)/, channel: "stdout", argGroup: 1 },

  // network channels
  { pattern: /fetch\s*\([^,]*,\s*\{[^}]*body:\s*([^,}]+)/, channel: "network", argGroup: 1 },
  { pattern: /\.send\s*\(([^)]*)\)/, channel: "network", argGroup: 1 },
  { pattern: /httpPost\s*\([^,]*,\s*([^)]+)\)/, channel: "network", argGroup: 1 },

  // filesystem channels
  { pattern: /writeFile\s*\([^,]*,\s*([^,)]+)/, channel: "filesystem", argGroup: 1 },
  { pattern: /appendFile\s*\([^,]*,\s*([^,)]+)/, channel: "filesystem", argGroup: 1 },

  // return channels
  { pattern: /\breturn\s+(\w+)/, channel: "return", argGroup: 1 },
];

export function detectClassifiedLeaks(
  code: string,
  classifiedVariables: ReadonlyArray<string>,
): ReadonlyArray<ClassifiedLeak> {
  if (classifiedVariables.length === 0) return [];

  const lines = code.split("\n");
  const leaks: ClassifiedLeak[] = [];
  const classifiedSet = new Set(classifiedVariables);

  // Track variable assignments that derive from classified values
  const derivedClassified = new Set(classifiedVariables);
  trackDerivedVariables(lines, derivedClassified);

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    for (const leakPattern of LEAK_PATTERNS) {
      const match = leakPattern.pattern.exec(line);
      if (!match) continue;

      const argContent = match[leakPattern.argGroup] ?? match[0];
      for (const classified of derivedClassified) {
        if (argContent.includes(classified)) {
          leaks.push({
            variable: classified,
            line: lineIdx + 1,
            channel: leakPattern.channel,
          });
        }
      }
    }
  }

  return deduplicateLeaks(leaks);
}

function trackDerivedVariables(
  lines: ReadonlyArray<string>,
  classified: Set<string>,
): void {
  const assignmentPattern = /(?:const|let|var)\s+(\w+)\s*=\s*(.+)/;

  for (const line of lines) {
    const match = assignmentPattern.exec(line);
    if (!match) continue;

    const [, varName, rhs] = match;
    if (!varName || !rhs) continue;

    // If RHS references a classified variable (and is not .map()), mark as derived
    for (const classifiedVar of classified) {
      if (rhs.includes(classifiedVar) && !rhs.includes(".map(") && !rhs.includes(".flatMap(")) {
        classified.add(varName);
        break;
      }
    }
  }
}

export function extractClassifiedBindings(code: string): ReadonlyArray<string> {
  const bindings: string[] = [];
  const classifyPattern = /(?:const|let|var)\s+(\w+)\s*=\s*classify\(/g;
  const classifyRecordPattern = /classifyRecord\([^,]+,\s*\[([^\]]+)\]\)/g;

  let match: RegExpExecArray | null;

  while ((match = classifyPattern.exec(code)) !== null) {
    if (match[1]) bindings.push(match[1]);
  }

  while ((match = classifyRecordPattern.exec(code)) !== null) {
    if (match[1]) {
      const keys = match[1].split(",").map((k) => k.trim().replace(/['"]/g, ""));
      bindings.push(...keys);
    }
  }

  return bindings;
}

function deduplicateLeaks(leaks: ReadonlyArray<ClassifiedLeak>): ReadonlyArray<ClassifiedLeak> {
  const seen = new Set<string>();
  return leaks.filter((l) => {
    const key = `${l.variable}:${l.line}:${l.channel}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
