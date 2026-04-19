import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"

const candidates = () => [
  resolve(process.cwd(), ".env"),
  resolve(homedir(), ".config/uebermensch/.env"),
]

export const loadDotenv = () => {
  for (const path of candidates()) {
    if (existsSync(path)) {
      process.loadEnvFile(path)
      return path
    }
  }
  return null
}
