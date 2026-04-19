import { Command } from "@effect/cli"
import { vaultInit } from "./vault-init.js"

export const vault = Command.make("vault").pipe(
  Command.withSubcommands([vaultInit]),
  Command.withDescription("Vault commands"),
)
