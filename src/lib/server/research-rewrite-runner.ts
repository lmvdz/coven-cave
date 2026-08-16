/**
 * Codex-backed runner for the spoken-register rewrite.
 *
 * The rewrite is a pure text transform, so the agent is given nothing to do but
 * transform: an empty working root, a read-only sandbox, no persisted session,
 * and a response schema it must fill. `--output-schema` is what makes the
 * result parseable without coaxing JSON out of prose.
 *
 * ⚠️ The prompt goes over stdin via `spawn` with an explicit `stdin.end()`, and
 * that detail is load-bearing. `execFile`'s `input` option does not give the
 * Windows binary its EOF: an identical trivial prompt returns in 4.4s through
 * `spawn` and hangs past 90s through `execFile`. A hang here would be invisible
 * in production — the rewrite times out, the fidelity fence falls back to the
 * extractive text, and podcasts quietly stop being rewritten at all.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { codexBin, codexLaunchCommand } from "../codex-bin.ts";
import type { RewriteRunner } from "./research-script-rewrite.ts";

/** Generous: the transform is short, but a cold model start is not. */
const REWRITE_TIMEOUT_MS = 180_000;
const REWRITE_MAX_STDERR_BYTES = 256 * 1024;

export type CodexRewriteRunnerOptions = {
  timeoutMs?: number;
  /** Injected in tests; otherwise resolved for the host platform. */
  launch?: { command: string; fixedArgs: readonly string[] };
};

export function createCodexRewriteRunner(
  options: CodexRewriteRunnerOptions = {},
): RewriteRunner {
  const timeoutMs = options.timeoutMs ?? REWRITE_TIMEOUT_MS;
  return async ({ prompt, schema }) => {
    const launch = options.launch ?? codexLaunchCommand(codexBin());
    const workspace = await mkdtemp(path.join(tmpdir(), "cave-rewrite-"));
    const schemaPath = path.join(workspace, "schema.json");
    const messagePath = path.join(workspace, "last-message.json");
    try {
      await writeFile(schemaPath, JSON.stringify(schema), "utf8");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          launch.command,
          [
            ...launch.fixedArgs,
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "-s",
            "read-only",
            "-C",
            workspace,
            "--output-schema",
            schemaPath,
            "-o",
            messagePath,
            "-",
          ],
          { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < REWRITE_MAX_STDERR_BYTES) stderr += chunk.toString("utf8");
        });
        // stdout carries the event stream, not the answer — `-o` holds that.
        // Drain it so a full pipe buffer cannot stall the child.
        child.stdout.resume();
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`rewrite timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`codex exec exited ${code}: ${stderr.trim().slice(0, 400)}`));
        });
        // A child that dies before reading the prompt surfaces through `close`;
        // an unhandled EPIPE here would take the process down instead.
        child.stdin.on("error", () => {});
        child.stdin.write(prompt);
        // Load-bearing: without this the binary never sees EOF and hangs.
        child.stdin.end();
      });
      return await readFile(messagePath, "utf8");
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  };
}
