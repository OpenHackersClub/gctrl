const CLASSIFIED_BRAND = Symbol("Classified");

export interface Classified<T> {
  readonly [CLASSIFIED_BRAND]: true;
  readonly map: <U>(fn: (value: T) => U) => Classified<U>;
  readonly flatMap: <U>(fn: (value: T) => Classified<U>) => Classified<U>;
  readonly toString: () => string;
}

export function classify<T>(value: T): Classified<T> {
  return createClassified(value);
}

function createClassified<T>(value: T): Classified<T> {
  return {
    [CLASSIFIED_BRAND]: true,
    map: <U>(fn: (value: T) => U): Classified<U> => createClassified(fn(value)),
    flatMap: <U>(fn: (value: T) => Classified<U>): Classified<U> => fn(value),
    toString: () => "Classified(****)",
  };
}

export function reveal<T>(classified: Classified<T>, _permission: RevealPermission): T {
  return (classified as unknown as { _value: T })._value;
}

export function isClassified(value: unknown): value is Classified<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    CLASSIFIED_BRAND in value &&
    (value as Record<symbol, unknown>)[CLASSIFIED_BRAND] === true
  );
}

export type RevealPermission = {
  readonly _tag: "RevealPermission";
  readonly sessionId: string;
};

export function createRevealPermission(sessionId: string): RevealPermission {
  return { _tag: "RevealPermission", sessionId };
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
