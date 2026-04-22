export type ExtractedPage = {
  readonly title: string;
  readonly text: string;
  readonly wordCount: number;
  readonly publishedAt: string | null;
};

const BLOCK_LEVEL_TAGS =
  /<\/?(p|div|section|article|header|footer|nav|aside|main|br|li|ul|ol|h[1-6]|blockquote|pre|table|tr|td|th|figure|figcaption)\b[^>]*>/gi;

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));

const stripBlock = (html: string, tagRe: RegExp): string => html.replace(tagRe, "");

const extractTag = (html: string, tag: string): string | null => {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(html);
  return m?.[1] ?? null;
};

const extractMetaContent = (html: string, nameOrProp: string): string | null => {
  const re = new RegExp(
    `<meta\\s+(?:(?:name|property)\\s*=\\s*["']${nameOrProp}["'])[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*>`,
    "i",
  );
  const m = re.exec(html);
  if (m?.[1]) return m[1];
  // flipped order (content before name)
  const reFlipped = new RegExp(
    `<meta\\s+[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*(?:name|property)\\s*=\\s*["']${nameOrProp}["'][^>]*>`,
    "i",
  );
  return reFlipped.exec(html)?.[1] ?? null;
};

const collapseWhitespace = (s: string): string =>
  s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// Patterns for lines that are almost certainly UI chrome / widgets / photo
// credits and not article content. Matched on fully trimmed lines.
const BOILERPLATE_LINE_PATTERNS: ReadonlyArray<RegExp> = [
  /^share\s*save$/i,
  /^sharesave$/i,
  /^(share|save|copy link|copy url|print|email)$/i,
  /^add\s+as\s+preferred\s+on\s+google\b.*$/i,
  /^\s*\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago(\s+sharesave)?$/i,
  /^(afp|ap|reuters|epa|bloomberg|getty images|getty)\s*(via\s+[a-z][a-z .&-]+)?\s*(images?)?$/i,
  /^(photo|image|picture|video)\s*:?\s*(getty|afp|ap|reuters|epa|bloomberg)\b.*$/i,
  /^via\s+(getty|afp|ap|reuters|epa|bloomberg)\b.*$/i,
  /^(advertisement|sponsored|promoted content|continue reading|read more)$/i,
  /^(follow us|subscribe|sign up for our newsletter).*$/i,
  /^related\s+(stories|articles|news|topics)\s*:?$/i,
  /^most\s+(read|popular|viewed)\s*$/i,
  /^skip to (main )?content$/i,
  /^cookies?\s+(policy|settings)$/i,
];

const isBoilerplateLine = (line: string): boolean => {
  const t = line.trim();
  if (t.length === 0) return true;
  for (const re of BOILERPLATE_LINE_PATTERNS) {
    if (re.test(t)) return true;
  }
  return false;
};

// Drop UI chrome, collapse duplicates, and trim trailing single-word
// category tags that news sites append (e.g. "Asia", "Japan" at page end).
export const cleanBoilerplate = (text: string): string => {
  const raw = text.split("\n");
  const kept: Array<string> = [];
  let prev: string | null = null;
  for (const line of raw) {
    const t = line.trim();
    if (isBoilerplateLine(t)) {
      if (prev !== "") kept.push("");
      prev = "";
      continue;
    }
    if (t === prev) continue;
    kept.push(t);
    prev = t;
  }
  // Strip trailing run of short "tag-like" lines (< 25 chars, no sentence
  // punctuation). These are typically category chips at the end of an article.
  while (kept.length > 0) {
    const last = kept[kept.length - 1];
    if (last === "") {
      kept.pop();
      continue;
    }
    if (last.length < 25 && !/[.!?;:"']/.test(last)) {
      kept.pop();
      continue;
    }
    break;
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

export const extractFromHtml = (html: string): ExtractedPage => {
  const title =
    extractMetaContent(html, "og:title") ?? extractTag(html, "title")?.trim() ?? "Untitled";
  const publishedAt =
    extractMetaContent(html, "article:published_time") ??
    extractMetaContent(html, "datePublished") ??
    null;

  // Prefer the body (or main/article) region
  let region =
    extractTag(html, "article") ?? extractTag(html, "main") ?? extractTag(html, "body") ?? html;
  region = stripBlock(region, /<script[\s\S]*?<\/script>/gi);
  region = stripBlock(region, /<style[\s\S]*?<\/style>/gi);
  region = stripBlock(region, /<noscript[\s\S]*?<\/noscript>/gi);
  region = stripBlock(region, /<!--[\s\S]*?-->/g);
  // Drop nav/aside/header/footer and their inner content — these carry UI
  // chrome (share widgets, "Add as preferred on Google", related links)
  // that leaks into the body when only the tags are stripped.
  region = stripBlock(region, /<nav\b[\s\S]*?<\/nav>/gi);
  region = stripBlock(region, /<aside\b[\s\S]*?<\/aside>/gi);
  region = stripBlock(region, /<header\b[\s\S]*?<\/header>/gi);
  region = stripBlock(region, /<footer\b[\s\S]*?<\/footer>/gi);
  region = stripBlock(region, /<form\b[\s\S]*?<\/form>/gi);
  region = region.replace(BLOCK_LEVEL_TAGS, "\n");
  region = region.replace(/<[^>]+>/g, "");
  const rawText = collapseWhitespace(decodeEntities(region));
  const text = cleanBoilerplate(rawText);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return { title: decodeEntities(title).trim(), text, wordCount, publishedAt };
};

export const domainKebab = (url: string): string => {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  return host.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
};

const kebab = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// Short, stable, deterministic 8-char hash of the URL for disambiguation.
const urlHashShort = (url: string): string => {
  let h = 2166136261 >>> 0; // FNV-1a 32-bit
  for (let i = 0; i < url.length; i += 1) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};

export const pathStem = (url: string): string => {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  const noExt = last.replace(/\.[a-z0-9]{1,6}$/i, "");
  const stem = kebab(noExt).slice(0, 40);
  return stem || urlHashShort(url);
};

export const slugForSource = (url: string, date: string): string =>
  `${date}--${domainKebab(url)}--${pathStem(url)}`;
