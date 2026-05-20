import { type Capability, requestCapabilityAsync, assertNotRevoked } from "../capabilities/index.js";
import { classify, type Classified, isClassified } from "../classified/index.js";
import type { CapabilityGrant, CapabilityKind } from "../types.js";

export interface SandboxConfig {
  readonly capabilities: ReadonlyArray<CapabilityGrant>;
  readonly timeout_ms: number;
  readonly maxOutputSize: number;
}

export interface SandboxResult {
  readonly success: boolean;
  readonly output: string;
  readonly error?: string;
  readonly classifiedOutput: string;
  readonly durationMs: number;
}

export interface SandboxContext {
  readonly capabilities: Map<CapabilityKind, Capability>;
  readonly output: OutputChannel;
  readonly secureOutput: OutputChannel;
}

export interface OutputChannel {
  write(data: string): void;
  toString(): string;
}

function createOutputChannel(): OutputChannel & { buffer: string[] } {
  const channel = {
    buffer: [] as string[],
    write(data: string) {
      channel.buffer.push(data);
    },
    toString() {
      return channel.buffer.join("");
    },
  };
  return channel;
}

export function createSandboxGlobals(
  config: SandboxConfig,
): Record<string, unknown> {
  const output = createOutputChannel();
  const secureOutput = createOutputChannel();

  return {
    classify,
    isClassified,

    println: (value: unknown) => {
      if (isClassified(value)) {
        output.write("Classified(****)\n");
        secureOutput.write(`[CLASSIFIED] ${String(value)}\n`);
      } else {
        const str = String(value);
        output.write(str + "\n");
        secureOutput.write(str + "\n");
      }
    },

    requestFileSystem: async <T>(
      root: string,
      op: (fs: ScopedFileSystem) => Promise<T>,
    ): Promise<T> => {
      assertCapabilityGranted(config.capabilities, "filesystem");
      return requestCapabilityAsync("filesystem", { root, readonly: false }, async (cap) => {
        const fs = createScopedFileSystem(cap, root);
        return op(fs);
      });
    },

    requestNetwork: async <T>(
      hosts: ReadonlyArray<string>,
      op: (net: ScopedNetwork) => Promise<T>,
    ): Promise<T> => {
      assertCapabilityGranted(config.capabilities, "network");
      return requestCapabilityAsync("network", { allowedHosts: hosts }, async (cap) => {
        const net = createScopedNetwork(cap, hosts);
        return op(net);
      });
    },

    requestProcess: async <T>(
      commands: ReadonlyArray<string>,
      op: (proc: ScopedProcess) => Promise<T>,
    ): Promise<T> => {
      assertCapabilityGranted(config.capabilities, "process");
      return requestCapabilityAsync("process", { allowedCommands: commands, strictMode: true }, async (cap) => {
        const proc = createScopedProcess(cap, commands);
        return op(proc);
      });
    },

    __output: output,
    __secureOutput: secureOutput,
  };
}

function assertCapabilityGranted(
  grants: ReadonlyArray<CapabilityGrant>,
  kind: CapabilityKind,
): void {
  if (!grants.some((g) => g.kind === kind)) {
    throw new Error(`Capability '${kind}' was not granted for this session`);
  }
}

export interface ScopedFileSystem {
  read(path: string): Promise<string>;
  readClassified(path: string): Promise<Classified<string>>;
  write(path: string, content: string): Promise<void>;
  list(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}

function createScopedFileSystem(cap: Capability<"filesystem">, root: string): ScopedFileSystem {
  const { readFile, writeFile, readdir, stat } = require("node:fs/promises");
  const { join, resolve, relative } = require("node:path");

  function assertWithinRoot(path: string): string {
    const resolved = resolve(root, path);
    const rel = relative(root, resolved);
    if (rel.startsWith("..") || resolve(resolved) !== resolved.replace(/\/$/, "")) {
      throw new Error(`Path '${path}' escapes root '${root}'`);
    }
    return resolved;
  }

  return {
    async read(path: string): Promise<string> {
      assertNotRevoked(cap);
      return readFile(assertWithinRoot(path), "utf-8");
    },
    async readClassified(path: string): Promise<Classified<string>> {
      assertNotRevoked(cap);
      const content = await readFile(assertWithinRoot(path), "utf-8");
      return classify(content);
    },
    async write(path: string, content: string): Promise<void> {
      assertNotRevoked(cap);
      if (cap.scope.readonly) throw new Error("Filesystem is readonly");
      await writeFile(assertWithinRoot(path), content, "utf-8");
    },
    async list(path: string): Promise<string[]> {
      assertNotRevoked(cap);
      return readdir(assertWithinRoot(path));
    },
    async exists(path: string): Promise<boolean> {
      assertNotRevoked(cap);
      try {
        await stat(assertWithinRoot(path));
        return true;
      } catch {
        return false;
      }
    },
  };
}

export interface ScopedNetwork {
  httpGet(url: string): Promise<string>;
  httpPost(url: string, body: string): Promise<string>;
}

function createScopedNetwork(cap: Capability<"network">, allowedHosts: ReadonlyArray<string>): ScopedNetwork {
  function assertAllowedHost(url: string): void {
    const parsed = new URL(url);
    if (!allowedHosts.includes(parsed.hostname)) {
      throw new Error(`Host '${parsed.hostname}' is not in the allowed list: [${allowedHosts.join(", ")}]`);
    }
  }

  return {
    async httpGet(url: string): Promise<string> {
      assertNotRevoked(cap);
      assertAllowedHost(url);
      const res = await fetch(url);
      return res.text();
    },
    async httpPost(url: string, body: string): Promise<string> {
      assertNotRevoked(cap);
      assertAllowedHost(url);
      const res = await fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json" } });
      return res.text();
    },
  };
}

export interface ScopedProcess {
  exec(command: string, args?: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

function createScopedProcess(cap: Capability<"process">, allowedCommands: ReadonlyArray<string>): ScopedProcess {
  return {
    async exec(command: string, args: string[] = []) {
      assertNotRevoked(cap);
      if (!allowedCommands.includes(command)) {
        throw new Error(`Command '${command}' is not in the allowed list: [${allowedCommands.join(", ")}]`);
      }
      const { execFile } = require("node:child_process");
      const { promisify } = require("node:util");
      const execFileAsync = promisify(execFile);
      try {
        const { stdout, stderr } = await execFileAsync(command, args, { timeout: 30_000 });
        return { stdout, stderr, exitCode: 0 };
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; code?: number };
        return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code ?? 1 };
      }
    },
  };
}
