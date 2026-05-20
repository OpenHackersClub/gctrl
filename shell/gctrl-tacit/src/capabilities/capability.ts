import type { CapabilityKind } from "../types.js";

const CAPABILITY_BRAND = Symbol("Capability");

export interface Capability<K extends CapabilityKind = CapabilityKind> {
  readonly [CAPABILITY_BRAND]: true;
  readonly kind: K;
  readonly scope: CapabilityScope<K>;
  readonly _revoked: boolean;
}

export type CapabilityScope<K extends CapabilityKind> = K extends "filesystem"
  ? FileSystemScope
  : K extends "network"
    ? NetworkScope
    : K extends "process"
      ? ProcessScope
      : K extends "llm"
        ? LlmScope
        : K extends "database"
          ? DatabaseScope
          : K extends "secrets"
            ? SecretsScope
            : never;

export interface FileSystemScope {
  readonly root: string;
  readonly readonly: boolean;
}

export interface NetworkScope {
  readonly allowedHosts: ReadonlyArray<string>;
  readonly allowedPorts?: ReadonlyArray<number>;
}

export interface ProcessScope {
  readonly allowedCommands: ReadonlyArray<string>;
  readonly strictMode: boolean;
}

export interface LlmScope {
  readonly models: ReadonlyArray<string>;
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
}

export interface DatabaseScope {
  readonly allowedTables: ReadonlyArray<string>;
  readonly readonly: boolean;
}

export interface SecretsScope {
  readonly allowedKeys: ReadonlyArray<string>;
}

export function requestCapability<K extends CapabilityKind, T>(
  kind: K,
  scope: CapabilityScope<K>,
  operation: (cap: Capability<K>) => T,
): T {
  const cap: Capability<K> & { _revoked: boolean } = {
    [CAPABILITY_BRAND]: true,
    kind,
    scope,
    _revoked: false,
  };

  try {
    return operation(cap);
  } finally {
    (cap as { _revoked: boolean })._revoked = true;
  }
}

export async function requestCapabilityAsync<K extends CapabilityKind, T>(
  kind: K,
  scope: CapabilityScope<K>,
  operation: (cap: Capability<K>) => Promise<T>,
): Promise<T> {
  const cap: Capability<K> & { _revoked: boolean } = {
    [CAPABILITY_BRAND]: true,
    kind,
    scope,
    _revoked: false,
  };

  try {
    return await operation(cap);
  } finally {
    (cap as { _revoked: boolean })._revoked = true;
  }
}

export function isCapability(value: unknown): value is Capability {
  return (
    typeof value === "object" &&
    value !== null &&
    CAPABILITY_BRAND in value &&
    (value as Record<symbol, unknown>)[CAPABILITY_BRAND] === true
  );
}

export function assertNotRevoked(cap: Capability): void {
  if (cap._revoked) {
    throw new CapabilityRevokedError(cap.kind);
  }
}

export class CapabilityRevokedError extends Error {
  constructor(kind: CapabilityKind) {
    super(`Capability '${kind}' has been revoked (scope exited)`);
    this.name = "CapabilityRevokedError";
  }
}
