#!/usr/bin/env node
/**
 * gctl — Effect-TS CLI shell for GroundCtrl.
 *
 * Invokes the Rust kernel via HTTP API (:4318) and communicates
 * with GitHub via direct REST API calls.
 */
import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { sessionsCommand } from "./commands/sessions.js"
import { statusCommand } from "./commands/status.js"
import { ghCommand } from "./commands/gh.js"
import { auditCommand } from "./commands/audit.js"
import { analyticsCommand } from "./commands/analytics.js"
import { contextCommand } from "./commands/context.js"
import { boardCommand } from "./commands/board.js"
import { netCommand } from "./commands/net.js"
import { HttpKernelClientLive } from "./adapters/HttpKernelClient.js"
import { HttpGitHubClientLive } from "./adapters/HttpGitHubClient.js"

const command = Command.make("gctl").pipe(
  Command.withSubcommands([
    sessionsCommand,
    statusCommand,
    ghCommand,
    auditCommand,
    analyticsCommand,
    contextCommand,
    boardCommand,
    netCommand,
  ])
)

const cli = Command.run(command, {
  name: "gctl",
  version: "0.1.0",
})

const ShellLive = Layer.mergeAll(
  HttpKernelClientLive(),
  HttpGitHubClientLive
)

cli(process.argv).pipe(
  Effect.provide(ShellLive),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain
)
