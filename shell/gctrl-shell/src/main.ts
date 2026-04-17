#!/usr/bin/env node
/**
 * gctrl — Effect-TS CLI shell for GroundCtrl.
 *
 * All commands route through the Rust kernel HTTP API (:4318).
 * External services (GitHub, Linear) are accessed via kernel drivers.
 */
import { Command } from "@effect/cli"
import { FetchHttpClient } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { sessionsCommand } from "./commands/sessions"
import { statusCommand } from "./commands/status"
import { ghCommand } from "./commands/gh"
import { auditCommand } from "./commands/audit"
import { analyticsCommand } from "./commands/analytics"
import { contextCommand } from "./commands/context"
import { boardCommand } from "./commands/board"
import { netCommand } from "./commands/net"
import { personaCommand } from "./commands/persona"
import { teamCommand } from "./commands/team"
import { inboxCommand } from "./commands/inbox"
import { wranglerCommand } from "./commands/wrangler"
import { HttpKernelClientLive } from "./adapters/HttpKernelClient"

const command = Command.make("gctrl").pipe(
  Command.withSubcommands([
    sessionsCommand,
    statusCommand,
    ghCommand,
    auditCommand,
    analyticsCommand,
    contextCommand,
    boardCommand,
    netCommand,
    personaCommand,
    teamCommand,
    inboxCommand,
    wranglerCommand,
  ])
)

const cli = Command.run(command, {
  name: "gctrl",
  version: "0.1.0",
})

const ShellLive = HttpKernelClientLive().pipe(Layer.provide(FetchHttpClient.layer))

cli(process.argv).pipe(
  Effect.provide(ShellLive),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain
)
