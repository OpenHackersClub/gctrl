const CLASSIFIED_BRAND = Symbol("Classified");
const REVEAL_KEY = Symbol("RevealKey");

const classifiedStore = new WeakMap<object, unknown>();

export interface Classified<T> {
  readonly [CLASSIFIED_BRAND]: true;
  readonly [REVEAL_KEY]: object;
  readonly map: <U>(fn: (value: T) => U) => Classified<U>;
  readonly flatMap: <U>(fn: (value: T) => Classified<U>) => Classified<U>;
  readonly toString: () => string;
}

export function classify<T>(value: T): Classified<T> {
  return createClassified(value);
}

function createClassified<T>(value: T): Classified<T> {
  const handle = Object.freeze(Object.create(null));
  const classified: Classified<T> = {
    [CLASSIFIED_BRAND]: true,
    [REVEAL_KEY]: handle,
    map: <U>(fn: (value: T) => U): Classified<U> => createClassified(fn(value)),
    flatMap: <U>(fn: (value: T) => Classified<U>): Classified<U> => fn(value),
    toString: () => "Classified(****)",
  };
  classifiedStore.set(handle, value);
  return classified;
}

export function reveal<T>(classified: Classified<T>, permission: RevealPermission): T {
  if (!isValidPermission(permission)) {
    throw new Error("Invalid RevealPermission — cannot reveal classified value");
  }
  const handle = classified[REVEAL_KEY];
  if (!classifiedStore.has(handle)) {
    throw new Error("Classified value has been garbage collected or is invalid");
  }
  return classifiedStore.get(handle) as T;
}

export function isClassified(value: unknown): value is Classified<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    CLASSIFIED_BRAND in value &&
    (value as Record<symbol, unknown>)[CLASSIFIED_BRAND] === true
  );
}

const PERMISSION_BRAND = Symbol("PermissionBrand");

export type RevealPermission = {
  readonly [PERMISSION_BRAND]: true;
  readonly _tag: "RevealPermission";
  readonly sessionId: string;
};

export function createRevealPermission(sessionId: string): RevealPermission {
  return Object.freeze({
    [PERMISSION_BRAND]: true,
    _tag: "RevealPermission" as const,
    sessionId,
  });
}

function isValidPermission(perm: unknown): perm is RevealPermission {
  return (
    typeof perm === "object" &&
    perm !== null &&
    PERMISSION_BRAND in perm &&
    (perm as Record<symbol, unknown>)[PERMISSION_BRAND] === true
  );
}

export function classifyRecord<T extends Record<string, unknown>>(
  record: T,
  keys: ReadonlyArray<keyof T>,
): { [K in keyof T]: K extends (typeof keys)[number] ? Classified<T[K]> : T[K] } {
  const result = { ...record } as Record<string, unknown>;
  for (const key of keys) {
    result[key as string] = classify(record[key]);
  }
  return result as { [K in keyof T]: K extends (typeof keys)[number] ? Classified<T[K]> : T[K] };
}
