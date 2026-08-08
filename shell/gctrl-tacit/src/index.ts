export { guard, type GuardOptions } from "./engine.js";

export {
  type Verdict,
  type Allow,
  type Deny,
  type Warn,
  type Violation,
  type CapabilityKind,
  type CapabilityGrant,
  type CodeSubmission,
  type GuardResult,
  type ClassifiedLeak,
  type CapabilityViolation,
  Verdict as VerdictUtils,
} from "./types.js";

export {
  type Classified,
  classify,
  reveal,
  isClassified,
  type RevealPermission,
  createRevealPermission,
  classifyRecord,
} from "./classified/index.js";

export {
  type Capability,
  type CapabilityScope,
  type FileSystemScope,
  type NetworkScope,
  type ProcessScope,
  type LlmScope,
  type DatabaseScope,
  type SecretsScope,
  requestCapability,
  requestCapabilityAsync,
  isCapability,
  assertNotRevoked,
  CapabilityRevokedError,
} from "./capabilities/index.js";

export {
  validatePatterns,
  stripStringLiterals,
  stripComments,
} from "./validator/index.js";

export {
  checkCapabilities,
} from "./validator/capability-checker.js";

export {
  detectClassifiedLeaks,
  extractClassifiedBindings,
} from "./validator/classified-leak-detector.js";

export {
  type SandboxConfig,
  type SandboxResult,
  type ScopedFileSystem,
  type ScopedNetwork,
  type ScopedProcess,
  createSandboxGlobals,
} from "./sandbox/index.js";
