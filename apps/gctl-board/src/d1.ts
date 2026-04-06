/**
 * D1Client — Effect Context.Tag wrapping a Cloudflare D1Database binding.
 *
 * Provides typed query helpers so route handlers can use D1 via Effect
 * without touching the raw binding directly.
 */
import { Context, Effect, Schema } from "effect"

export class D1Error extends Schema.TaggedError<D1Error>()(
  "D1Error",
  { message: Schema.String }
) {}

export interface D1ClientShape {
  /** Run a query and return all rows */
  readonly query: (
    sql: string,
    ...binds: unknown[]
  ) => Effect.Effect<readonly Record<string, unknown>[], D1Error>

  /** Run a query and return the first row, or null */
  readonly first: <T = Record<string, unknown>>(
    sql: string,
    ...binds: unknown[]
  ) => Effect.Effect<T | null, D1Error>

  /** Run a batch of prepared statements atomically */
  readonly batch: (
    stmts: ReadonlyArray<{ sql: string; binds: unknown[] }>
  ) => Effect.Effect<void, D1Error>

  /** Prepare and run a single mutation (INSERT/UPDATE/DELETE) */
  readonly run: (
    sql: string,
    ...binds: unknown[]
  ) => Effect.Effect<void, D1Error>
}

export class D1Client extends Context.Tag("D1Client")<D1Client, D1ClientShape>() {}

/**
 * Build a D1Client Layer from a raw D1Database binding.
 * Called per-request in the worker fetch handler.
 */
export const makeD1Client = (db: D1Database): D1ClientShape => ({
  query: (sql, ...binds) =>
    Effect.tryPromise({
      try: () =>
        db
          .prepare(sql)
          .bind(...binds)
          .all()
          .then((r) => (r.results ?? []) as Record<string, unknown>[]),
      catch: (e) => new D1Error({ message: String(e) }),
    }),

  first: <T = Record<string, unknown>>(sql: string, ...binds: unknown[]) =>
    Effect.tryPromise({
      try: () =>
        db
          .prepare(sql)
          .bind(...binds)
          .first() as Promise<T | null>,
      catch: (e) => new D1Error({ message: String(e) }),
    }),

  batch: (stmts) =>
    Effect.tryPromise({
      try: () =>
        db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.binds))).then(() => undefined),
      catch: (e) => new D1Error({ message: String(e) }),
    }),

  run: (sql, ...binds) =>
    Effect.tryPromise({
      try: () =>
        db
          .prepare(sql)
          .bind(...binds)
          .run()
          .then(() => undefined),
      catch: (e) => new D1Error({ message: String(e) }),
    }),
})
