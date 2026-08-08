import { guard, type GuardOptions } from "../engine.js";
import { checkCapabilities } from "../validator/capability-checker.js";
import type { CapabilityGrant, CodeSubmission } from "../types.js";
import { Verdict } from "../types.js";

export interface TacitMcpServer {
  readonly tools: ReadonlyArray<McpToolDefinition>;
  handleToolCall(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  readonly content: ReadonlyArray<{ type: "text"; text: string }>;
  readonly isError?: boolean;
}

export function createTacitMcpServer(options: GuardOptions = {}): TacitMcpServer {
  const tools: McpToolDefinition[] = [
    {
      name: "tacit_guard",
      description:
        "Validate agent-generated code against capability boundaries, classified data leakage, and forbidden patterns. Returns a verdict (Allow/Deny/Warn) with violation details. This is a best-effort static lint pass — not a security boundary.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "The code to validate" },
          language: { type: "string", enum: ["typescript", "javascript"], default: "typescript" },
          sessionId: { type: "string", description: "Session ID for tracking" },
          capabilities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: {
                  type: "string",
                  enum: ["filesystem", "network", "process", "llm", "database", "secrets"],
                },
                scope: { type: "object" },
              },
              required: ["kind", "scope"],
            },
            description: "Capabilities granted to this code",
          },
        },
        required: ["code", "sessionId"],
      },
    },
    {
      name: "tacit_check_capabilities",
      description:
        "Check which capabilities a code snippet requires, without running it. Useful for pre-flight checks before requesting capabilities.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "The code to analyze" },
        },
        required: ["code"],
      },
    },
  ];

  async function handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    switch (name) {
      case "tacit_guard":
        return handleGuard(args, options);
      case "tacit_check_capabilities":
        return handleCheckCapabilities(args);
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  }

  return { tools, handleToolCall };
}

function handleGuard(
  args: Record<string, unknown>,
  options: GuardOptions,
): McpToolResult {
  if (typeof args.code !== "string" || !args.code) {
    return { content: [{ type: "text", text: "Error: 'code' must be a non-empty string" }], isError: true };
  }
  if (typeof args.sessionId !== "string" || !args.sessionId) {
    return { content: [{ type: "text", text: "Error: 'sessionId' must be a non-empty string" }], isError: true };
  }

  const submission: CodeSubmission = {
    code: args.code,
    language: (args.language === "javascript" ? "javascript" : "typescript"),
    sessionId: args.sessionId,
    capabilities: Array.isArray(args.capabilities) ? (args.capabilities as CapabilityGrant[]) : [],
  };

  const result = guard(submission, options);

  const output = {
    verdict: result.verdict._tag,
    ...(Verdict.isDeny(result.verdict) || Verdict.isWarn(result.verdict)
      ? { reason: result.verdict.reason }
      : {}),
    capabilityViolations: result.capabilityViolations,
    classifiedLeaks: result.classifiedLeaks,
    validationErrors: result.validationErrors,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    isError: Verdict.isDeny(result.verdict),
  };
}

function handleCheckCapabilities(args: Record<string, unknown>): McpToolResult {
  if (typeof args.code !== "string" || !args.code) {
    return { content: [{ type: "text", text: "Error: 'code' must be a non-empty string" }], isError: true };
  }

  const violations = checkCapabilities(args.code, []);
  const required = [...new Set(violations.map((v) => v.required))];

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ requiredCapabilities: required, details: violations }, null, 2),
      },
    ],
  };
}

export { createTacitMcpServer as default };
