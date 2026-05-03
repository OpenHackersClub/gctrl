// FreshnessProbeService — § 2.5 of the briefing pipeline (research-mode only).
//
// Runs between Candidate Selection (§2) and Curator (§3) when generating
// `gctrl uber report` reports. Detects watchlist-entity gaps via a single LLM
// call (gap detection), fires targeted search queries through the kernel's
// driver-net, fetches matching pages, and ingests them as new Source pages.
//
// The stage degrades gracefully: any failure (LLM unavailable, net unavailable,
// budget exceeded) results in a partial or empty probe result that the caller
// logs and then proceeds as if the probe was skipped.

import { Context, Effect, Either, Layer } from "effect";
import { ProbeError } from "../errors.js";
import { sha256 } from "../lib/hash.js";
import { LlmService } from "./LlmService.js";
import { NetService } from "./NetService.js";
import { VaultService } from "./VaultService.js";

// ---- Public types ----

export type WikiPageRef = {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
};

export type ProbeSummary = {
  readonly query: string;
  readonly watchlist_entity: string;
  readonly confidence: string;
  readonly urls_fetched: number;
  readonly pages_ingested: number;
};

export type FreshnessProbeRequest = {
  readonly directive: {
    readonly slug: string;
    readonly markdown: string;
    readonly watchlistEntities: ReadonlyArray<string>;
  };
  readonly candidates: ReadonlyArray<{ id: string; title: string; slug: string }>;
  readonly period: { start: string; end: string };
};

export type FreshnessProbeResult = {
  readonly probes: ReadonlyArray<ProbeSummary>;
  readonly newCandidates: ReadonlyArray<WikiPageRef>;
  readonly skipped: boolean;
  readonly skipReason?: string;
};

export interface FreshnessProbeServiceShape {
  readonly run: (req: FreshnessProbeRequest) => Effect.Effect<FreshnessProbeResult, ProbeError>;
}

export class FreshnessProbeService extends Context.Tag("uebermensch/FreshnessProbeService")<
  FreshnessProbeService,
  FreshnessProbeServiceShape
>() {}

// ---- Configuration ----

const envInt = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const envFloat = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const MAX_PROBES = () => envInt("UBER_FRESHNESS_PROBE_MAX", 6);
const TOTAL_BUDGET_USD = () => envFloat("UBER_FRESHNESS_PROBE_TOTAL_USD", 0.2);

// In-memory 24h query cache keyed by `${query}::${dayBucket}`.
// Survives the process lifetime; resets on restart.
const queryCache = new Map<string, string>();

const dayBucket = (): string => new Date().toISOString().slice(0, 10);

const isCacheHit = (query: string): boolean => queryCache.has(`${query}::${dayBucket()}`);
const markCacheHit = (query: string): void => {
  queryCache.set(`${query}::${dayBucket()}`, dayBucket());
};

// Exported so tests can reset the cache between runs.
export const _resetProbeCacheForTests = (): void => queryCache.clear();

// ---- Confidence ordering for probe cap ----

const CONFIDENCE_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1 };
const confidenceRank = (c: string): number => CONFIDENCE_ORDER[c] ?? 0;

// ---- Frontmatter renderer ----

const yamlEscape = (s: string): string => {
  if (/^[A-Za-z0-9._\-:/ ]+$/.test(s) && !s.includes(": ") && !s.startsWith("-")) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
};

const renderSourceFrontmatter = (fields: Record<string, unknown>): string => {
  const lines: Array<string> = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => yamlEscape(String(v))).join(", ")}]`);
    } else if (typeof value === "object") {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === null || v === undefined) continue;
        lines.push(`  ${k}: ${yamlEscape(String(v))}`);
      }
    } else {
      lines.push(`${key}: ${yamlEscape(String(value))}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
};

// ---- Core pipeline logic ----
// Services are passed as parameters so the returned Effect has R=never.

const runProbesWithServices = (
  req: FreshnessProbeRequest,
  llm: LlmService["Type"],
  net: NetService["Type"],
  vault: VaultService["Type"],
) =>
  Effect.gen(function* () {

    // Step 1 — Gap detection (single LLM call).
    const gapEither = yield* llm
      .generateProbes({
        directiveMd: req.directive.markdown,
        candidatesSummary: req.candidates.map((c) => ({ title: c.title, slug: c.slug })),
        period: req.period,
        watchlistEntities: req.directive.watchlistEntities,
      })
      .pipe(Effect.either);

    if (Either.isLeft(gapEither)) {
      const e = gapEither.left;
      return {
        probes: [] as ReadonlyArray<ProbeSummary>,
        newCandidates: [] as ReadonlyArray<WikiPageRef>,
        skipped: true,
        skipReason: `llm_error:${e.kind ?? "unknown"}`,
      } satisfies FreshnessProbeResult;
    }

    const gapResponse = gapEither.right;

    // Step 2 — Rank high→medium→low, cap at MAX_PROBES.
    const sortedProbes = [...gapResponse.probes]
      .sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence))
      .slice(0, MAX_PROBES());

    if (sortedProbes.length === 0) {
      return {
        probes: [] as ReadonlyArray<ProbeSummary>,
        newCandidates: [] as ReadonlyArray<WikiPageRef>,
        skipped: false,
      } satisfies FreshnessProbeResult;
    }

    // Steps 3–5 — Per-probe search + fetch + ingest.
    const probeSummaries: Array<ProbeSummary> = [];
    const newCandidates: Array<WikiPageRef> = [];
    let runningCostUsd = gapResponse.costUsd;
    const totalBudget = TOTAL_BUDGET_USD();
    const fetchedAt = new Date().toISOString();

    for (const probe of sortedProbes) {
      // Per-probe budget cap.
      if (runningCostUsd >= totalBudget) break;

      // 24h cache dedup.
      if (isCacheHit(probe.query)) {
        probeSummaries.push({
          query: probe.query,
          watchlist_entity: probe.watchlist_entity,
          confidence: probe.confidence,
          urls_fetched: 0,
          pages_ingested: 0,
        });
        continue;
      }
      markCacheHit(probe.query);

      // Search — drop probe on net error (graceful degrade per spec).
      const searchEither = yield* net
        .search({ query: probe.query, maxResults: 5 })
        .pipe(Effect.either);

      let urlsFetched = 0;
      let pagesIngested = 0;

      if (Either.isRight(searchEither)) {
        const urls = searchEither.right.results.map((r) => r.url);

        for (const url of urls) {
          // Per-URL fetch; drop on error.
          const fetchEither = yield* net
            .fetch({ url, accept: "markdown" })
            .pipe(Effect.either);

          if (Either.isLeft(fetchEither)) continue;
          urlsFetched += 1;

          const content = (fetchEither.right.content ?? "").trim();
          if (content.length === 0) continue;

          // Build source page slug: date--probe-domain-queryhash.
          const datePrefix = req.period.end.slice(0, 10);
          const domain = (() => {
            try {
              return new URL(url).hostname.replace(/^www\./, "");
            } catch {
              return "unknown";
            }
          })();
          const domainSlug = domain
            .replace(/\./g, "-")
            .replace(/[^a-z0-9-]/g, "")
            .slice(0, 30);
          const queryHash = sha256(probe.query).slice(8, 16); // short fingerprint
          const slug = `${datePrefix}--probe-${domainSlug}-${queryHash}`;

          const contentHash = sha256(content);
          const wordCount = content.split(/\s+/).filter(Boolean).length;
          const frontmatterFields: Record<string, unknown> = {
            page_type: "source",
            slug,
            title: `Probe: ${probe.query.slice(0, 80)}`,
            url,
            domain,
            fetched_at: fetchedAt,
            topics: [],
            entities: [],
            content_hash: contentHash,
            provenance: "freshness_probe",
            probed_for: probe.watchlist_entity,
            quality: {
              word_count: wordCount,
              readability_used: false,
              spam_score: 0,
              paywalled: false,
              body_source: "fetched",
            },
          };

          const pageContent = `${renderSourceFrontmatter(frontmatterFields)}\n\n${content}`;

          // Write to vault; skip on error.
          const writeEither = yield* vault
            .writeSource(slug, pageContent, { overwrite: false })
            .pipe(Effect.either);

          if (Either.isRight(writeEither)) {
            pagesIngested += 1;
            newCandidates.push({
              id: slug,
              title: `Probe: ${probe.query.slice(0, 60)}`,
              slug,
            });
          }
        }
      }

      probeSummaries.push({
        query: probe.query,
        watchlist_entity: probe.watchlist_entity,
        confidence: probe.confidence,
        urls_fetched: urlsFetched,
        pages_ingested: pagesIngested,
      });
    }

    return {
      probes: probeSummaries,
      newCandidates,
      skipped: false,
    } satisfies FreshnessProbeResult;
  });

// ---- Live Layer ----
//
// The Layer reads LlmService, NetService, and VaultService from context at
// construction time, closing over them. This makes the `run` method's Effect
// have R=never (all requirements satisfied).

export const FreshnessProbeServiceLive = Layer.effect(
  FreshnessProbeService,
  Effect.gen(function* () {
    // Capture services at layer-construction time.
    const llm = yield* LlmService;
    const net = yield* NetService;
    const vault = yield* VaultService;

    return {
      run: (req): Effect.Effect<FreshnessProbeResult, ProbeError> => {
        // Skip if no watchlist entities.
        if (req.directive.watchlistEntities.length === 0) {
          return Effect.succeed({
            probes: [],
            newCandidates: [],
            skipped: true,
            skipReason: "no_watchlist",
          } satisfies FreshnessProbeResult);
        }
        return runProbesWithServices(req, llm, net, vault).pipe(
          Effect.catchAll((e) =>
            Effect.fail(
              new ProbeError({
                message: `FreshnessProbeService unexpected error: ${String(e)}`,
                kind: "io_failure",
              }),
            ),
          ),
        );
      },
    };
  }),
);
