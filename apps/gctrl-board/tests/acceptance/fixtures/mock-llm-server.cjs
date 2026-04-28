#!/usr/bin/env node
/**
 * Mock OpenAI-compat /v1/chat/completions upstream for the LLM relay
 * acceptance tests. Standing in for LM Studio / Ollama / etc. so the test
 * suite has a deterministic, offline endpoint to drive the kernel relay
 * against.
 *
 * Listens on 127.0.0.1:$MOCK_LLM_PORT (default 14299) and answers exactly
 * one shape of request — POST /v1/chat/completions — with a fixed body
 * that includes a `usage` block (the relay needs this to emit cost +
 * token spans). Anything else returns 404.
 *
 * Run standalone:
 *   MOCK_LLM_PORT=14299 node fixtures/mock-llm-server.cjs
 */
const http = require("node:http")

const PORT = Number(process.env.MOCK_LLM_PORT ?? 14299)
const HOST = process.env.MOCK_LLM_HOST ?? "127.0.0.1"

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk
    })
    req.on("end", () => {
      let parsed = null
      try {
        parsed = JSON.parse(body)
      } catch {
        // fall through — we'll still answer with a generic completion
      }
      const requestedModel =
        (parsed && parsed.model) || "mock-llm/test-model-v1"
      const userText =
        (parsed &&
          Array.isArray(parsed.messages) &&
          parsed.messages
            .filter((m) => m.role === "user")
            .map((m) => (typeof m.content === "string" ? m.content : ""))
            .join(" ")) ||
        ""

      const response = {
        id: `chatcmpl-mock-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: `mock reply (echo: ${userText.slice(0, 64)})`,
            },
            finish_reason: "stop",
          },
        ],
        // The relay reads usage.prompt_tokens / usage.completion_tokens to
        // populate the OTel span. Pinning these makes the assertions
        // deterministic.
        usage: {
          prompt_tokens: 42,
          completion_tokens: 17,
          total_tokens: 59,
        },
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(response))
    })
    return
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: true, port: PORT }))
    return
  }
  res.writeHead(404, { "Content-Type": "application/json" })
  res.end(
    JSON.stringify({
      error: { message: `mock-llm-server only serves POST /v1/chat/completions; got ${req.method} ${req.url}` },
    }),
  )
})

server.listen(PORT, HOST, () => {
  process.stderr.write(`[mock-llm] listening on http://${HOST}:${PORT}\n`)
})

const shutdown = () => {
  server.close(() => process.exit(0))
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
