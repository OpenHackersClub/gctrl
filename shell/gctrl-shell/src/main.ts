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
import { searchCommand } from "./commands/search"
import { personaCommand } from "./commands/persona"
import { teamCommand } from "./commands/team"
import { inboxCommand } from "./commands/inbox"
import { vaultCommand } from "./commands/vault"
import { wranglerCommand } from "./commands/wrangler"
import { appCommand } from "./commands/app"
import { browserCommand } from "./commands/browser"
import { HttpKernelClientLive } from "./adapters/HttpKernelClient"
import { HttpBrowserClientLive } from "./adapters/HttpBrowserClient"

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
    searchCommand,
    personaCommand,
    teamCommand,
    inboxCommand,
    vaultCommand,
    wranglerCommand,
    appCommand,
    browserCommand,
  ])
)

const cli = Command.run(command, {
  name: "gctrl",
  version: "0.1.0",
})

const KernelLive = HttpKernelClientLive().pipe(Layer.provide(FetchHttpClient.layer))
const BrowserLive = HttpBrowserClientLive.pipe(Layer.provide(KernelLive))
const ShellLive = Layer.mergeAll(KernelLive, BrowserLive)

cli(process.argv).pipe(
  Effect.provide(ShellLive),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain
)
