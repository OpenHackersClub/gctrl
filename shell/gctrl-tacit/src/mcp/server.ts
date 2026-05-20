import { guard, type GuardOptions } from "../engine.js";
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
        "Validate agent-generated code against capability boundaries, classified data leakage, and forbidden patterns. Returns a verdict (Allow/Deny/Warn) with details.",
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
    {
      name: "tacit_classify",
      description:
        "Wrap a value as Classified — once classified, it cannot be leaked to stdout, network, or filesystem without going through .map() with a pure function.",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string", description: "The value to classify (will be treated as opaque)" },
          label: { type: "string", description: "A label for this classified value (for audit)" },
        },
        required: ["value"],
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
      case "tacit_classify":
        return handleClassify(args);
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
  const submission: CodeSubmission = {
    code: args.code as string,
    language: (args.language as "typescript" | "javascript") ?? "typescript",
    sessionId: args.sessionId as string,
    capabilities: (args.capabilities as CapabilityGrant[]) ?? [],
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
  const code = args.code as string;
  const { checkCapabilities } = require("../validator/capability-checker.js");
  const violations = checkCapabilities(code, []);

  const required = [...new Set(violations.map((v: { required: string }) => v.required))];

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            requiredCapabilities: required,
            details: violations,
          },
          null,
          2,
        ),
      },
    ],
  };
}

function handleClassify(args: Record<string, unknown>): McpToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          classified: true,
          label: args.label ?? "unlabeled",
          value: "Classified(****)",
          note: "Value is now classified. Any code using this value must go through .map() with a pure function.",
        }),
      },
    ],
  };
}

export { createTacitMcpServer as default };
