/**
 * `gctrl terminal` — focus the originating macOS terminal session for an
 * inbox permission request, and probe what the runtime can reach.
 *
 * All commands route through the kernel HTTP API (`/api/comm/*`). The
 * driver is `gctrl-mac-comm` (LKM); shell never invokes `osascript`
 * directly.
 *
 * Verbs:
 *   capabilities — show OS, supported terminals, automation grant state
 *   focus        — bring a terminal session/tab to the foreground
 */
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Option, Schema } from "effect"
import { KernelClient } from "../services/KernelClient"

// --- schemas ---

const Capabilities = Schema.Struct({
  os: Schema.String,
  terminals: Schema.Array(Schema.String),
  notify: Schema.Boolean,
  automation_granted: Schema.optional(Schema.NullOr(Schema.Boolean)),
  captured_at: Schema.String,
})

const FocusResponse = Schema.Struct({
  focused: Schema.Boolean,
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  deduped: Schema.optional(Schema.Boolean),
})

// --- shared options ---

const TARGET_APPS = ["iterm2", "terminal", "ghostty", "vscode", "warp"] as const

const formatOption = Options.choice("format", ["table", "json"]).pipe(
  Options.withDefault("table"),
  Options.withDescription("Output format")
)

// --- capabilities command ---

const capabilitiesCommand = Command.make(
  "capabilities",
  { format: formatOption },
  ({ format }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const caps = yield* kernel.get("/api/comm/capabilities", Capabilities)

      if (format === "json") {
        yield* Console.log(JSON.stringify(caps, null, 2))
        return
      }

      const grant =
        caps.automation_granted == null
          ? "unknown"
          : caps.automation_granted
            ? "granted"
            : "denied"
      yield* Console.log(`OS:                 ${caps.os}`)
      yield* Console.log(`Terminals:          ${caps.terminals.join(", ") || "(none)"}`)
      yield* Console.log(`Notify (M1):        ${caps.notify ? "yes" : "no"}`)
      yield* Console.log(`Automation grant:   ${grant}`)
      yield* Console.log(`Captured at:        ${caps.captured_at}`)
    })
)

// --- focus command ---
//
// One flag schema across all targets: `--target <app> [--session <id>]
// [--window <n>] [--tab <n>] [--cwd <path>]`. iTerm2 / Ghostty / VS Code /
// Warp need `--session`; Apple Terminal needs `--window` + `--tab`.

const targetOption = Options.choice("target", [...TARGET_APPS]).pipe(
  Options.withDescription(`Terminal app to focus (${TARGET_APPS.join(" | ")})`)
)
const sessionOption = Options.text("session").pipe(
  Options.optional,
  Options.withDescription("Session UUID (iTerm2: w0t0p0:UUID; others: vendor-specific)")
)
const windowOption = Options.text("window").pipe(
  Options.optional,
  Options.withDescription("Window index (Apple Terminal)")
)
const tabOption = Options.text("tab").pipe(
  Options.optional,
  Options.withDescription("Tab index (Apple Terminal)")
)
const cwdOption = Options.text("cwd").pipe(
  Options.optional,
  Options.withDescription("Working directory (used for 'open new window here' fallback)")
)

const focusCommand = Command.make(
  "focus",
  {
    target: targetOption,
    session: sessionOption,
    window: windowOption,
    tab: tabOption,
    cwd: cwdOption,
  },
  ({ target, session, window, tab, cwd }) =>
    Effect.gen(function* () {
      const kernel = yield* KernelClient
      const body: Record<string, unknown> = { target }
      if (Option.isSome(session)) body.session_id = session.value
      if (Option.isSome(window)) body.window_id = window.value
      if (Option.isSome(tab)) body.tab_id = tab.value
      if (Option.isSome(cwd)) body.cwd = cwd.value

      const resp = yield* kernel.post("/api/comm/focus", body, FocusResponse)

      if (resp.focused) {
        const note = resp.deduped ? " (deduped)" : ""
        yield* Console.log(`Focused ${target}${note}`)
      } else {
        const reason = resp.reason ?? "unknown"
        yield* Console.log(`Skipped: ${reason}`)
      }
    })
)

// --- terminal (parent) ---

export const terminalCommand = Command.make("terminal").pipe(
  Command.withSubcommands([capabilitiesCommand, focusCommand])
)
