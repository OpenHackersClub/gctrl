#!/usr/bin/env node
/**
 * Ensures the preview D1 database exists and patches wrangler.toml with
 * the real database_id. Handles wrangler CLI outputting non-JSON text
 * (telemetry banners) mixed with JSON.
 *
 * Usage: node scripts/ensure-preview-d1.mjs
 * Env:   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
 */
import { execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const DB_NAME = "gctl-board-preview-db"
const WRANGLER_TOML = "wrangler.toml"

/** Extract JSON array or object from mixed wrangler output. */
function extractJSON(raw, startChar = "[") {
  const idx = raw.indexOf(startChar)
  if (idx === -1) return null
  try {
    return JSON.parse(raw.slice(idx))
  } catch {
    return null
  }
}

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
}

// 1. Check if database already exists
const listOut = run("pnpm exec wrangler d1 list --json")
const dbs = extractJSON(listOut, "[") ?? []
let db = dbs.find((d) => d.name === DB_NAME)

if (!db) {
  console.log(`Creating D1 database: ${DB_NAME}`)
  const createOut = run(`pnpm exec wrangler d1 create ${DB_NAME} --json`)
  db = extractJSON(createOut, "{")
  if (!db?.uuid) {
    console.error("Failed to create D1 database:", createOut)
    process.exit(1)
  }
  console.log(`Created: ${db.uuid}`)
} else {
  console.log(`Found existing D1 database: ${db.uuid}`)
}

// 2. Patch wrangler.toml — replace placeholder database_id
const toml = readFileSync(WRANGLER_TOML, "utf8")
const patched = toml.replace(
  /database_id\s*=\s*"preview"/,
  `database_id = "${db.uuid}"`
)
if (patched === toml) {
  console.log("wrangler.toml already has a real database_id (no placeholder found)")
} else {
  writeFileSync(WRANGLER_TOML, patched)
  console.log(`Patched wrangler.toml with database_id = "${db.uuid}"`)
}
