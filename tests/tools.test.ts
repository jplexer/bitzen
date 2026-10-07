import { afterAll, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { runProcess, workspaceTools } from "../src/tools.ts";
import { cleanup, signal, tempRepo } from "./helpers.ts";

afterAll(cleanup);

test("file edits require an exact unique match; creates cannot overwrite", async () => {
  const root = await tempRepo();
  await Bun.write(join(root, "file.ts"), "hello hello");
  const tools = workspaceTools(root, false);
  const patch = tools.find(tool => tool.definition.name === "apply_patch")!;
  await expect(patch.execute({ path: "file.ts", old_text: "hello", new_text: "goodbye" }, signal())).rejects.toThrow("ambiguous");
  expect(await Bun.file(join(root, "file.ts")).text()).toBe("hello hello");
  await patch.execute({ path: "file.ts", old_text: "hello hello", new_text: "goodbye" }, signal());
  expect(await Bun.file(join(root, "file.ts")).text()).toBe("goodbye");
  await expect(patch.execute({ path: "file.ts", old_text: "", new_text: "oops" }, signal())).rejects.toThrow("only creates");
  await patch.execute({ path: "new.ts", old_text: "", new_text: "created" }, signal());
  expect(await Bun.file(join(root, "new.ts")).text()).toBe("created");
});

test("file tools reject traversal, sensitive files, and symlink escapes", async () => {
  const root = await tempRepo();
  const outside = await tempRepo();
  await Bun.write(join(outside, "private.txt"), "private");
  await symlink(join(outside, "private.txt"), join(root, "link.txt"));
  await symlink(outside, join(root, "outside"));
  const tools = workspaceTools(root, false);
  const read = tools.find(tool => tool.definition.name === "read_file")!;
  for (const path of ["../private.txt", ".env", ".git/config", "credentials.json", "profile/.credentials.json-temp", "link.txt"]) {
    await expect(read.execute({ path }, signal())).rejects.toThrow();
  }
  const patch = tools.find(tool => tool.definition.name === "apply_patch")!;
  await expect(patch.execute({ path: "outside/new.txt", old_text: "", new_text: "oops" }, signal())).rejects.toThrow("outside");
  expect(await Bun.file(join(outside, "new.txt")).exists()).toBe(false);
});

test("search treats query as data and excludes credentials and internal traces", async () => {
  const root = await tempRepo();
  await mkdir(join(root, ".bitzen"));
  await Bun.write(join(root, "code.ts"), "needle --flag");
  await Bun.write(join(root, ".env"), "needle secret");
  await Bun.write(join(root,"credentials.json"),"needle private-login");
  await Bun.write(join(root, ".bitzen", "trace.json"), "needle internal");
  const tools = workspaceTools(root, false);
  const search = tools.find(tool => tool.definition.name === "search")!;
  const found = JSON.parse(await search.execute({ query: "--flag" }, signal()));
  expect(found.exitCode).toBe(0);
  expect(found.stdout).toContain("code.ts");
  const all = JSON.parse(await search.execute({ query: "needle" }, signal()));
  expect(all.stdout).not.toContain("secret");
  expect(all.stdout).not.toContain("internal");
  expect(all.stdout).not.toContain("private-login");
  const list = tools.find(tool => tool.definition.name === "list_files")!;
  expect(JSON.parse(await list.execute({}, signal())).stdout).toContain("code.ts");
});

test("shell is opt-in, commands time out, and cancellation is propagated", async () => {
  const root = await tempRepo();
  const shell = workspaceTools(root, false).find(tool => tool.definition.name === "run_command")!;
  await expect(shell.execute({ command: "true" }, signal())).rejects.toThrow("disabled");
  const timed = await runProcess(["/bin/sh", "-c", "sleep 5"], root, signal(), 30);
  expect(timed.timedOut).toBe(true);
  expect(timed.exitCode).not.toBe(0);
  const controller = new AbortController();
  const running = runProcess(["/bin/sh", "-c", "sleep 5"], root, controller.signal);
  setTimeout(() => controller.abort(new Error("cancel test")), 30);
  await expect(running).rejects.toThrow("cancel test");
});

test("large command output is drained but bounded", async () => {
  const result = await runProcess([process.execPath, "-e", "console.log('x'.repeat(200000))"], await tempRepo(), signal());
  expect(result.exitCode).toBe(0);
  expect(result.stdout.length).toBeLessThan(16_100);
  expect(result.stdout).toContain("truncated");
});
