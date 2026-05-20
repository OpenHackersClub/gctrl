import { validatePatterns } from "./validator/patterns.js";
import { checkCapabilities } from "./validator/capability-checker.js";
import { detectClassifiedLeaks, extractClassifiedBindings } from "./validator/classified-leak-detector.js";
import type { CodeSubmission, GuardResult, Violation } from "./types.js";
import { Verdict } from "./types.js";

export interface GuardOptions {
  readonly strictMode?: boolean;
  readonly additionalClassifiedVars?: ReadonlyArray<string>;
  readonly customPatterns?: ReadonlyArray<{
    pattern: RegExp;
    rule: string;
    message: string;
    severity: "error" | "warning";
  }>;
}

export function guard(submission: CodeSubmission, options: GuardOptions = {}): GuardResult {
  const { code, capabilities } = submission;

  // Phase 1: Pattern-based validation (fast, no parsing needed)
  const patternViolations = validatePatterns(code);

  // Phase 2: Capability checking (does code use APIs beyond its granted capabilities?)
  const capabilityViolations = checkCapabilities(code, capabilities);

  // Phase 3: Classified leak detection (does code exfiltrate classified data?)
  const classifiedVars = [
    ...extractClassifiedBindings(code),
    ...(options.additionalClassifiedVars ?? []),
  ];
  const classifiedLeaks = detectClassifiedLeaks(code, classifiedVars);

  // Phase 4: Custom patterns (user-defined)
  const customViolations = options.customPatterns
    ? validateCustomPatterns(code, options.customPatterns)
    : [];

  // Combine all validation errors
  const allViolations = [...patternViolations, ...customViolations];

  // Determine verdict
  const errors = allViolations.filter((v) => v.severity === "error");
  const hasCapabilityViolations = capabilityViolations.length > 0;
  const hasClassifiedLeaks = classifiedLeaks.length > 0;

  let verdict: ReturnType<typeof Verdict.allow> | ReturnType<typeof Verdict.deny> | ReturnType<typeof Verdict.warn>;

  if (errors.length > 0 || hasCapabilityViolations || hasClassifiedLeaks) {
    const reasons: string[] = [];
    if (errors.length > 0) reasons.push(`${errors.length} forbidden pattern(s)`);
    if (hasCapabilityViolations) reasons.push(`${capabilityViolations.length} capability violation(s)`);
    if (hasClassifiedLeaks) reasons.push(`${classifiedLeaks.length} classified leak(s)`);
    verdict = Verdict.deny(reasons.join("; "), allViolations);
  } else if (allViolations.length > 0) {
    verdict = Verdict.warn(
      `${allViolations.length} warning(s) — review before execution`,
      allViolations,
    );
  } else {
    verdict = Verdict.allow();
  }

  return {
    verdict,
    classifiedLeaks,
    capabilityViolations,
    validationErrors: allViolations,
  };
}

function validateCustomPatterns(
  code: string,
  patterns: ReadonlyArray<{
    pattern: RegExp;
    rule: string;
    message: string;
    severity: "error" | "warning";
  }>,
): ReadonlyArray<Violation> {
  const lines = code.split("\n");
  const violations: Violation[] = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    for (const custom of patterns) {
      const match = custom.pattern.exec(line);
      if (match) {
        violations.push({
          rule: custom.rule,
          message: custom.message,
          line: lineIdx + 1,
          column: match.index + 1,
          severity: custom.severity,
        });
      }
    }
  }

  return violations;
}

export type { GuardResult, CodeSubmission } from "./types.js";
