// Pure renderer for Citation Mode v1 source page bodies.
// Input is fully resolved — no Effects, no I/O. Callers (HttpIngest,
// migration scripts) supply the digest + raw extraction metadata and
// receive a markdown string ready to write to disk.
//
// Section order is fixed by the spec (knowledge-base.md § Source body template):
//   ## Gist
//   ## Key numbers
//   ## Essential quotes
//   ## Insights
//   ## Questions
//   ## Access metadata

import type { SourceDigest } from "./llm-prompts.js";

export type RawMeta = {
  readonly fetchedAt: string;
  readonly charCount: number;
  readonly wordCount: number;
  readonly readabilityUsed: boolean;
  readonly paywall: boolean;
};

export type SourceBodyInput = {
  readonly title: string;
  readonly url: string;
  readonly digest: SourceDigest;
  readonly raw: RawMeta;
  readonly insights?: ReadonlyArray<string>;
  readonly questions?: ReadonlyArray<string>;
};

// Simplified input for migration paths that only have the digest available.
// Title/url/raw are omitted from the output in this form.
export type SourceBodyDigestOnly = SourceDigest;

const NONE = "_None._";

const bulletList = (items: ReadonlyArray<string>): string =>
  items.map((s) => `- ${s}`).join("\n");

// renderSourceBody accepts either:
//   - a full SourceBodyInput (HttpIngest path — includes title/url/raw/insights/questions)
//   - a bare SourceDigest (migration path — omits header and access metadata sections)
export function renderSourceBody(input: SourceBodyInput): string;
export function renderSourceBody(digest: SourceBodyDigestOnly): string;
export function renderSourceBody(input: SourceBodyInput | SourceBodyDigestOnly): string {
  // Discriminate: SourceBodyInput has a `digest` field; SourceDigest does not.
  if ("digest" in input) {
    return renderSourceBodyFull(input);
  }
  return renderDigestSectionsOnly(input);
}

function renderSourceBodyFull(input: SourceBodyInput): string {
  const { title, url, digest, raw, insights = [], questions = [] } = input;
  const parts: Array<string> = [];

  // Title + URL header
  parts.push(`# ${title}`);
  parts.push("");
  parts.push(`Source: <${url}>`);
  parts.push("");

  // ## Gist
  parts.push("## Gist");
  parts.push("");
  parts.push(digest.gist.length > 0 ? bulletList(digest.gist) : NONE);
  parts.push("");

  // ## Key numbers
  parts.push("## Key numbers");
  parts.push("");
  parts.push(digest.key_numbers.length > 0 ? bulletList(digest.key_numbers) : NONE);
  parts.push("");

  // ## Essential quotes
  parts.push("## Essential quotes");
  parts.push("");
  if (digest.essential_quotes.length > 0) {
    const quoteLines = digest.essential_quotes.map(
      (q) => `> "${q.text}" — ${q.attribution}`,
    );
    parts.push(quoteLines.join("\n\n"));
  } else {
    parts.push(NONE);
  }
  parts.push("");

  // ## Insights
  parts.push("## Insights");
  parts.push("");
  parts.push(insights.length > 0 ? bulletList(insights) : NONE);
  parts.push("");

  // ## Questions
  parts.push("## Questions");
  parts.push("");
  parts.push(questions.length > 0 ? bulletList(questions) : NONE);
  parts.push("");

  // ## Access metadata
  parts.push("## Access metadata");
  parts.push("");
  parts.push(`- fetched_at: ${raw.fetchedAt}`);
  parts.push(`- extraction_method: ${raw.readabilityUsed ? "readability" : "html-strip"}`);
  parts.push(`- paywall: ${raw.paywall}`);
  parts.push(`- raw_char_count: ${raw.charCount}`);
  parts.push(`- post_extraction_word_count: ${raw.wordCount}`);
  parts.push("");

  return parts.join("\n");
}

// Digest-only rendering for migration paths: emits only the four LLM-sourced
// sections (Gist / Key numbers / Essential quotes / Insights+Questions as _None._).
// No title header, no access metadata (caller writes frontmatter directly).
function renderDigestSectionsOnly(digest: SourceDigest): string {
  const parts: Array<string> = [];

  parts.push("## Gist");
  parts.push("");
  parts.push(digest.gist.length > 0 ? bulletList(digest.gist) : NONE);
  parts.push("");

  parts.push("## Key numbers");
  parts.push("");
  parts.push(digest.key_numbers.length > 0 ? bulletList(digest.key_numbers) : NONE);
  parts.push("");

  parts.push("## Essential quotes");
  parts.push("");
  if (digest.essential_quotes.length > 0) {
    const quoteLines = digest.essential_quotes.map(
      (q) => `> "${q.text}" — ${q.attribution}`,
    );
    parts.push(quoteLines.join("\n\n"));
  } else {
    parts.push(NONE);
  }
  parts.push("");

  parts.push("## Insights");
  parts.push("");
  parts.push(NONE);
  parts.push("");

  parts.push("## Questions");
  parts.push("");
  parts.push(NONE);
  parts.push("");

  return parts.join("\n");
}
