import { Context, Effect, Either, Layer, Option } from "effect";
import { IngestError, type VaultError } from "../errors.js";
import { sha256 } from "../lib/hash.js";
import { domainKebab, extractFromHtml, slugForSource } from "../lib/html-extract.js";
import { IngestService } from "../services/IngestService.js";
import { LlmService } from "../services/LlmService.js";
import { VaultService } from "../services/VaultService.js";

export type HttpIngestConfig = {
  readonly fetch?: typeof fetch;
  readonly userAgent?: string;
};

export class HttpIngestConfigTag extends Context.Tag("uebermensch/HttpIngestConfig")<
  HttpIngestConfigTag,
  HttpIngestConfig
>() {}

// Browser-like UA — bare `uebermensch-ingest` gets 403'd by FT, Bloomberg, SCMP, BoJ.
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MAX_BODY_CHARS = 8000;

// Patterns that indicate a paywalled / metered article. If any match the extracted
// body we consider the fetched content unusable and fall back to the RSS description
// (when available). Ordered by how strongly they signal paywall.
const PAYWALL_PATTERNS: ReadonlyArray<RegExp> = [
  /subscribe to (?:unlock|continue|read)/i,
  /sign in to (?:read|continue|access)/i,
  /try unlimited access/i,
  /only\s+\S+\s*\$?1\s+for\s+\d+\s+weeks?/i,
  /keep reading for/i,
  /already have an account\??\s*(?:log ?in|sign ?in)/i,
  /create (?:a |an )?free account to (?:read|continue)/i,
  /complete digital access/i,
  /your subscription (?:gives|grants|provides)/i,
  /register (?:for free|to continue)/i,
];

export type PaywallCheck = {
  readonly paywalled: boolean;
  readonly matched: string | null;
};

export const detectPaywall = (body: string): PaywallCheck => {
  for (const re of PAYWALL_PATTERNS) {
    const hit = body.match(re);
    if (hit) return { paywalled: true, matched: hit[0] };
  }
  return { paywalled: false, matched: null };
};

const ingestErr = (kind: IngestError["kind"], url: string, message: string): IngestError =>
  new IngestError({ kind, url, message });

const vaultToIngest =
  (url: string) =>
  (e: VaultError): IngestError =>
    ingestErr(e.kind === "collision" ? "collision" : "io_failure", url, e.message);

// A slug "japan-macro" as plain text rarely appears in articles — but its watchlist
// terms (boj, yen, jgb, ueda…) do. classifyTopics matches against BOTH:
//   (a) the slug rendered as a phrase (kebab → space), and
//   (b) each watchlist term (with word-boundary regex to avoid substring collisions
//       like "us" matching "usual").
export const classifyTopics = (
  text: string,
  topicSlugs: ReadonlyArray<string>,
  watchlists: Readonly<Record<string, ReadonlyArray<string>>> = {},
): ReadonlyArray<string> => {
  const haystack = text.toLowerCase();
  const hits: Array<string> = [];
  for (const slug of topicSlugs) {
    const phrase = slug.toLowerCase().replace(/-/g, " ");
    let matched = haystack.includes(phrase);
    if (!matched) {
      for (const term of watchlists[slug] ?? []) {
        const t = term.toLowerCase();
        if (!t) continue;
        // Word-boundary match on kebab/space/punct so "us" doesn't match "usual".
        const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[ \\-/]");
        const re = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i");
        if (re.test(haystack)) {
          matched = true;
          break;
        }
      }
    }
    if (matched) hits.push(slug);
  }
  return hits;
};

const yamlEscape = (s: string): string => {
  if (/^[A-Za-z0-9._\-:/ ]+$/.test(s) && !s.includes(": ") && !s.startsWith("-")) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
};

const renderFrontmatter = (fields: Record<string, unknown>): string => {
  const lines: Array<string> = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const items = value.map((v) => yamlEscape(String(v))).join(", ");
      lines.push(`${key}: [${items}]`);
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

type BodySource = "extracted" | "rss_description" | "llm_insights";

const renderSourceBody = (
  title: string,
  url: string,
  text: string,
  paywalled: boolean,
  bodySource: BodySource,
): string => {
  const truncated =
    text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n\n…(truncated)` : text;
  const note =
    bodySource === "llm_insights"
      ? "_Below is an LLM-generated key-insights summary of the source article._"
      : bodySource === "rss_description"
        ? "_Body below is the RSS publisher-supplied description; the linked article is paywalled._"
        : paywalled
          ? "_Extracted content may be truncated by a paywall._"
          : "";
  const parts = [`# ${title}`, "", `Source: <${url}>`, ""];
  if (note) parts.push(note, "");
  parts.push(truncated, "");
  return parts.join("\n");
};

const MIN_FEED_DESCRIPTION_CHARS = 80;

const narrowTopics = (
  classified: ReadonlyArray<string>,
  forceTopics: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> => {
  if (!forceTopics || forceTopics.length === 0) {
    return Array.from(new Set(classified));
  }
  const ceiling = new Set(forceTopics);
  const narrowed = classified.filter((t) => ceiling.has(t));
  return Array.from(new Set(narrowed));
};

export const HttpIngestLive = Layer.effect(
  IngestService,
  Effect.gen(function* () {
    const config = yield* HttpIngestConfigTag;
    const vault = yield* VaultService;
    const doFetch = config.fetch ?? fetch;
    const userAgent = config.userAgent ?? DEFAULT_UA;

    return {
      ingestUrl: (req) =>
        Effect.gen(function* () {
          const fetchedAt = new Date().toISOString();

          const response = yield* Effect.tryPromise({
            try: () =>
              doFetch(req.url, {
                headers: {
                  "user-agent": userAgent,
                  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                  "accept-language": "en-US,en;q=0.9",
                },
              }),
            catch: (e) => ingestErr("fetch_failed", req.url, `fetch failed: ${String(e)}`),
          }).pipe(
            Effect.filterOrFail(
              (r) => r.ok,
              (r) => ingestErr("fetch_failed", req.url, `fetch returned ${r.status}`),
            ),
          );

          const html = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: (e) => ingestErr("fetch_failed", req.url, `read body failed: ${String(e)}`),
          });

          const extracted = yield* Effect.try({
            try: () => extractFromHtml(html),
            catch: (e) => ingestErr("extract_failed", req.url, `extract failed: ${String(e)}`),
          });

          // Decide which body to use. Paywall detection runs on the extracted text;
          // if it hits, we fall back to the RSS description (when long enough).
          const paywall = detectPaywall(extracted.text);
          const feedDesc = (req.descriptionFromFeed ?? "").trim();
          const useFeedDesc = paywall.paywalled && feedDesc.length >= MIN_FEED_DESCRIPTION_CHARS;
          let bodySource: BodySource = useFeedDesc ? "rss_description" : "extracted";
          const sourceText = useFeedDesc ? feedDesc : extracted.text;
          let bodyText = sourceText;
          const effectiveWordCount = sourceText.split(/\s+/).filter(Boolean).length;

          // Quality gate: if still below minWordCount after the description fallback,
          // reject. Title-only pages are not useful to the curator.
          if (effectiveWordCount < req.minWordCount) {
            return yield* Effect.fail(
              ingestErr(
                "low_quality",
                req.url,
                `effective word_count ${effectiveWordCount} < min ${req.minWordCount} (paywalled=${paywall.paywalled}, feedDesc=${feedDesc.length})`,
              ),
            );
          }

          const slug = slugForSource(req.url, req.date);
          const domain = domainKebab(req.url).replace(/-/g, ".");

          // Classification runs on the full extracted text (not the summary)
          // so watchlist-term matches don't lose recall after summarization.
          const classifyText = `${extracted.title}\n${sourceText.slice(0, 2000)}\n${feedDesc.slice(0, 1000)}`;
          const classified = classifyTopics(
            classifyText,
            req.topicSlugs,
            req.topicWatchlists ?? {},
          );
          const topicsMatched = narrowTopics(classified, req.forceTopics);

          // Optional LLM summarization. Only fires when the caller opts in
          // AND an LlmService is present in the context. On LLM failure we
          // keep the extracted/RSS body — ingestion must not break because
          // the summarizer is unreachable.
          let summaryModel: string | undefined;
          let summaryCostUsd: number | undefined;
          if (req.summarize) {
            const llmOpt = yield* Effect.serviceOption(LlmService);
            if (Option.isSome(llmOpt)) {
              const llm = llmOpt.value;
              const summary = yield* llm
                .summarizeSource({
                  title: extracted.title,
                  url: req.url,
                  text: sourceText,
                  topics: topicsMatched,
                })
                .pipe(Effect.either);
              Either.match(summary, {
                onLeft: () => {},
                onRight: (s) => {
                  bodyText = s.insightsMd;
                  bodySource = "llm_insights";
                  summaryModel = s.model;
                  summaryCostUsd = s.costUsd;
                },
              });
            }
          }
          const contentHash = sha256(bodyText);

          const body = renderSourceBody(
            extracted.title,
            req.url,
            bodyText,
            paywall.paywalled,
            bodySource,
          );
          const frontmatterFields: Record<string, unknown> = {
            page_type: "source",
            slug,
            title: extracted.title,
            url: req.url,
            domain,
            published_at: extracted.publishedAt,
            fetched_at: fetchedAt,
            topics: topicsMatched,
            entities: [],
            content_hash: contentHash,
            quality: {
              word_count: effectiveWordCount,
              readability_used: false,
              spam_score: 0,
              paywalled: paywall.paywalled,
              body_source: bodySource,
            },
          };
          if (summaryModel !== undefined) {
            frontmatterFields.summary = {
              model: summaryModel,
              cost_usd: summaryCostUsd ?? 0,
            };
          }
          const frontmatter = renderFrontmatter(frontmatterFields);
          const full = `${frontmatter}\n\n${body}`;

          const written = yield* vault
            .writeSource(slug, full, { overwrite: req.overwrite })
            .pipe(
              Effect.catchTags({
                VaultError: (e) => Effect.fail(vaultToIngest(req.url)(e)),
                // Ingested content matched a known credential pattern — refuse
                // the page rather than persist it. Mapped to io_failure so the
                // ingest queue treats it like any other rejected write.
                VaultSecretLeakError: (e) =>
                  Effect.fail(
                    ingestErr(
                      "io_failure",
                      req.url,
                      `secret-pattern leak blocked write: ${e.leaks.map((l) => l.name).join(", ")}`,
                    ),
                  ),
              }),
            );

          return {
            slug,
            relPath: written.relPath,
            absPath: written.absPath,
            title: extracted.title,
            domain,
            wordCount: effectiveWordCount,
            topicsMatched,
            contentHash: written.contentHash,
            paywalled: paywall.paywalled,
            bodySource,
            summaryModel,
            summaryCostUsd,
          };
        }),
    };
  }),
);

export const HttpIngestDefaultConfig = Layer.succeed(HttpIngestConfigTag, {});
