// Single source of truth for the uebermensch vault layout.
// See vault/specs/profile.md § Vault Layout — four canonical roots organised
// around the user↔CoS relationship:
//
//   directives/  — standing orders FOR CoS (config, theses, research, prompts)
//   input/       — material FOR me to read (raw, wiki, briefs, reports)
//   output/      — MY writing; CoS reviews + suggests
//   action/      — things awaiting MY greenlight (strategies, plans, events, tasks)
//
// All paths are vault-relative. Use join(vaultDir, X) at the call site.

export const DIRECTIVES_DIR = "directives"
export const INPUT_DIR = "input"
export const OUTPUT_DIR = "output"
export const ACTION_DIR = "action"

export const VAULT_ROOTS = [
  DIRECTIVES_DIR,
  INPUT_DIR,
  OUTPUT_DIR,
  ACTION_DIR,
] as const

// directives/ — authored tier (user → CoS instructions; git-tracked)
export const DIRECTIVES_PROFILE_FILE = `${DIRECTIVES_DIR}/profile.md`
export const DIRECTIVES_TOPICS_FILE = `${DIRECTIVES_DIR}/topics.md`
export const DIRECTIVES_SOURCES_FILE = `${DIRECTIVES_DIR}/sources.md`
export const DIRECTIVES_AVOID_FILE = `${DIRECTIVES_DIR}/avoid.md`
export const DIRECTIVES_ME_FILE = `${DIRECTIVES_DIR}/me.md`
export const DIRECTIVES_PROJECTS_FILE = `${DIRECTIVES_DIR}/projects.md`
export const DIRECTIVES_PERSONAS_FILE = `${DIRECTIVES_DIR}/personas.md`
export const DIRECTIVES_PERSONAS_DIR = `${DIRECTIVES_DIR}/personas`
export const DIRECTIVES_THESES_DIR = `${DIRECTIVES_DIR}/theses`
export const DIRECTIVES_RESEARCH_DIR = `${DIRECTIVES_DIR}/research`
export const DIRECTIVES_PROMPTS_DIR = `${DIRECTIVES_DIR}/prompts`
export const DIRECTIVES_SCHEDULES_FILE = `${DIRECTIVES_DIR}/schedules.md`

// input/ — generated tier (CoS → user; what the user reads)
export const INPUT_RAW_DIR = `${INPUT_DIR}/raw`
export const INPUT_WIKI_DIR = `${INPUT_DIR}/wiki`
export const INPUT_BRIEFS_DIR = `${INPUT_DIR}/briefs`
export const INPUT_REPORTS_DIR = `${INPUT_DIR}/reports`

// output/ — authored (user → CoS for review; git-tracked)
// No fixed subdirs; the user organises their own drafts/memos under output/.

// action/ — mixed (user authors most; drivers write into events/generated/)
export const ACTION_STRATEGIES_DIR = `${ACTION_DIR}/strategies`
export const ACTION_PLANS_DIR = `${ACTION_DIR}/plans`
export const ACTION_EVENTS_DIR = `${ACTION_DIR}/events`
export const ACTION_EVENTS_GENERATED_DIR = `${ACTION_EVENTS_DIR}/generated`
export const ACTION_TASKS_DIR = `${ACTION_DIR}/tasks`
