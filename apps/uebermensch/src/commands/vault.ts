import { Command } from "@effect/cli"
import { vaultInit } from "./vault-init.js"
import { vaultMigrateCitations } from "./vault-migrate-citations.js"

export const vault = Command.make("vault").pipe(
  Command.withSubcommands([vaultInit, vaultMigrateCitations]),
  Command.withDescription("Vault commands"),
)
