#!/usr/bin/env node
/**
 * gctl — Effect-TS CLI shell for GroundCtrl.
 *
 * Invokes the Rust kernel via HTTP API (:4318) and communicates
 * with external tools (GitHub, Slack) via ccli subprocess adapters.
 */
import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { sessionsCommand } from "./commands/sessions.js"
import { statusCommand } from "./commands/status.js"
import { ghCommand } from "./commands/gh.js"
import { HttpKernelClientLive } from "./adapters/HttpKernelClient.js"
import { CcliGitHubClientLive } from "./adapters/CcliGitHubClient.js"

const command = Command.make("gctl").pipe(
  Command.withSubcommands([sessionsCommand, statusCommand, ghCommand])
)

const cli = Command.run(command, {
  name: "gctl",
  version: "0.1.0",
})

const ShellLive = Layer.mergeAll(
  HttpKernelClientLive(),
  CcliGitHubClientLive
)

cli(process.argv).pipe(
  Effect.provide(ShellLive),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain
)
