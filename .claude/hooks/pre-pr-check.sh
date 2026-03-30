#!/bin/bash
set -e

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')
CWD=$(echo "$INPUT" | jq -r '.cwd')

# Only gate PR create commands
if ! echo "$COMMAND" | grep -q "gh pr create"; then
  exit 0
fi

cd "$CWD" || exit 1

echo "Pre-PR check: building TypeScript packages..." >&2
npm run build 2>&1 >&2 || { echo "BUILD FAILED — fix build errors before creating PR" >&2; exit 2; }

echo "Pre-PR check: running biome lint..." >&2
npx biome lint shell/*/src/ apps/*/src/ 2>&1 >&2 || { echo "LINT FAILED — fix biome lint errors before creating PR" >&2; exit 2; }

echo "Pre-PR checks passed." >&2
exit 0
