import { open, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { object, string } from "./validate.ts";
import type { ToolDefinition } from "./providers/types.ts";

export interface Tool {
  definition: ToolDefinition;
  execute(argumentsValue: unknown, signal: AbortSignal): Promise<string>;
}

export function defineTool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition {
  return { name, description, parameters: { type: "object", properties, required, additionalProperties: false } };
}

const text = { type: "string" };
const maxFileBytes = 1_000_000;
const maxOutput = 16_000;

export function toolArguments(value: unknown, allowed: string[]): Record<string, unknown> {
  const args = object(value, "tool arguments");
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error(`Unexpected argument: ${key}`);
  return args;
}

export function workspaceTools(root: string, allowShell: boolean): Tool[] {
  root = realpathSync(root);
  const resolvePath = async (path: string, creating = false): Promise<string> => {
    const candidate = resolve(root, path);
    checkPath(root, candidate);
    let actual: string;
    try {
      actual = await realpath(candidate);
    } catch (error) {
      if (!creating || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      actual = resolve(await realpath(dirname(candidate)), candidate.slice(dirname(candidate).length + 1));
    }
    checkPath(root, actual);
    return actual;
  };

  const tool = (definition: ToolDefinition, execute: Tool["execute"]): Tool => ({ definition, execute });
  const rgExcludes = ["!.git/**", "!.bitzen/**", "!node_modules/**", "!.env*", "!.aws/**", "!.codex/**", "!.agents/**", "!**/credentials.json", "!**/.credentials.json*"]
    .flatMap(pattern => ["--glob", pattern]);

  return [
    tool(defineTool("list_files", "List repository files, respecting ignore rules. Sensitive and generated directories are excluded.", { path: text }, []), async (value, signal) => {
      const args = toolArguments(value, ["path"]);
      const path = await resolvePath(string(args.path ?? ".", "path"));
      return JSON.stringify(await runProcess(["rg", "--files", "--hidden", ...rgExcludes, "--", path], root, signal));
    }),
    tool(defineTool("read_file", "Read a UTF-8 file (up to 1 MB), returning at most 16000 characters.", { path: text }, ["path"]), async (value, signal) => {
      signal.throwIfAborted();
      const args = toolArguments(value, ["path"]);
      const file = Bun.file(await resolvePath(string(args.path, "path")));
      if (file.size > maxFileBytes) throw new Error("File exceeds the 1 MB limit.");
      return clip(await file.text());
    }),
    tool(defineTool("search", "Search repository files for a literal string using ripgrep.", { query: text, path: text }, ["query"]), async (value, signal) => {
      const args = toolArguments(value, ["query", "path"]);
      const path = await resolvePath(string(args.path ?? ".", "path"));
      return JSON.stringify(await runProcess(["rg", "--line-number", "--no-heading", "--color", "never", "--fixed-strings", "--hidden", ...rgExcludes, "--", string(args.query, "query"), path], root, signal));
    }),
    tool(defineTool("apply_patch", "Replace one exact, unique text occurrence in a file. Use empty old_text ONLY to create a new file; its parent must exist. Read existing files first.", { path: text, old_text: text, new_text: text }, ["path", "old_text", "new_text"]), async (value, signal) => {
      signal.throwIfAborted();
      const args = toolArguments(value, ["path", "old_text", "new_text"]);
      const oldText = string(args.old_text, "old_text", true);
      const newText = string(args.new_text, "new_text", true);
      const path = await resolvePath(string(args.path, "path"), oldText.length === 0);
      const file = Bun.file(path);
      let updated = newText;
      if (!oldText) {
        if (await file.exists()) throw new Error("Empty old_text only creates new files.");
      } else {
        if (file.size > maxFileBytes) throw new Error("File exceeds the 1 MB limit.");
        const current = await file.text();
        const start = current.indexOf(oldText);
        if (start < 0) throw new Error("old_text does not match the file. Read it again.");
        if (current.indexOf(oldText, start + 1) >= 0) throw new Error("old_text is ambiguous; include more surrounding text.");
        updated = current.slice(0, start) + newText + current.slice(start + oldText.length);
      }
      if (Buffer.byteLength(updated) > maxFileBytes) throw new Error("Updated file exceeds the 1 MB limit.");
      if (oldText) await Bun.write(path, updated);
      else {
        const handle = await open(path, "wx");
        try { await handle.writeFile(updated); } finally { await handle.close(); }
      }
      return JSON.stringify({ path: relative(root, path), bytes: Buffer.byteLength(updated), applied: true });
    }),
    tool(defineTool("run_command", "Run a shell command in the repository with a 30-second timeout. Requires --allow-shell; shell access is not sandboxed.", { command: text }, ["command"]), async (value, signal) => {
      if (!allowShell) throw new Error("Shell commands are disabled. The user must enable --allow-shell at startup.");
      const args = toolArguments(value, ["command"]);
      return JSON.stringify(await runProcess(["/bin/sh", "-c", string(args.command, "command")], root, signal));
    }),
  ];
}

function checkPath(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path is outside the repository.");
  if (rel.split(sep).some(part => [".git", ".bitzen", ".aws", ".codex", ".agents"].includes(part) || part.startsWith(".env") || part === "credentials.json" || part.startsWith(".credentials.json"))) {
    throw new Error("This path is excluded from agent file tools.");
  }
}

export function clip(text: string): string {
  return text.length <= maxOutput ? text : `${text.slice(0, maxOutput)}\n[output truncated]`;
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  let truncated = false;
  for await (const bytes of stream) {
    const text = decoder.decode(bytes, { stream: true });
    if (output.length + text.length > maxOutput) truncated = true;
    output += text.slice(0, Math.max(0, maxOutput - output.length));
  }
  const tail = decoder.decode();
  if (output.length + tail.length > maxOutput) truncated = true;
  output += tail.slice(0, Math.max(0, maxOutput - output.length));
  return output + (truncated ? "\n[output truncated]" : "");
}

export async function runProcess(argv: string[], cwd: string, signal: AbortSignal, timeoutMs = 30_000) {
  signal.throwIfAborted();
  // A new process group lets cancellation terminate shell children too (POSIX).
  const child = Bun.spawn(argv, {
    cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG },
  });
  let timedOut = false;
  const kill = () => {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  };
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  signal.addEventListener("abort", kill, { once: true });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, readBounded(child.stdout), readBounded(child.stderr)]);
    signal.throwIfAborted();
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
  }
}
