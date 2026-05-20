export type Verdict = Allow | Deny | Warn;

export interface Allow {
  readonly _tag: "Allow";
}

export interface Deny {
  readonly _tag: "Deny";
  readonly reason: string;
  readonly violations: ReadonlyArray<Violation>;
}

export interface Warn {
  readonly _tag: "Warn";
  readonly reason: string;
  readonly violations: ReadonlyArray<Violation>;
}

export interface Violation {
  readonly rule: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  readonly severity: "error" | "warning";
}

export const Verdict = {
  allow: (): Verdict => ({ _tag: "Allow" }),
  deny: (reason: string, violations: ReadonlyArray<Violation> = []): Verdict => ({
    _tag: "Deny",
    reason,
    violations,
  }),
  warn: (reason: string, violations: ReadonlyArray<Violation> = []): Verdict => ({
    _tag: "Warn",
    reason,
    violations,
  }),
  isAllow: (v: Verdict): v is Allow => v._tag === "Allow",
  isDeny: (v: Verdict): v is Deny => v._tag === "Deny",
  isWarn: (v: Verdict): v is Warn => v._tag === "Warn",
} as const;

export type CapabilityKind =
  | "filesystem"
  | "network"
  | "process"
  | "llm"
  | "database"
  | "secrets";

export interface CapabilityGrant {
  readonly kind: CapabilityKind;
  readonly scope: Record<string, unknown>;
}

export interface CodeSubmission {
  readonly code: string;
  readonly language: "typescript" | "javascript";
  readonly sessionId: string;
  readonly capabilities: ReadonlyArray<CapabilityGrant>;
}

export interface GuardResult {
  readonly verdict: Verdict;
  readonly classifiedLeaks: ReadonlyArray<ClassifiedLeak>;
  readonly capabilityViolations: ReadonlyArray<CapabilityViolation>;
  readonly validationErrors: ReadonlyArray<Violation>;
}

export interface ClassifiedLeak {
  readonly variable: string;
  readonly line: number;
  readonly channel: "stdout" | "network" | "filesystem" | "return";
}

export interface CapabilityViolation {
  readonly required: CapabilityKind;
  readonly operation: string;
  readonly line: number;
}
