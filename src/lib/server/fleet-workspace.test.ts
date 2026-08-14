import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { capturePortableFleetWorkspace } from "./fleet-workspace.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("Fleet captures a path-independent checkout envelope with dirty overlay", async () => {
  const temp = mkdtempSync(path.join(tmpdir(), "cave-fleet-workspace-"));
  const bare = path.join(temp, "remote.git");
  const source = path.join(temp, "source-layout", "repo");
  mkdirSync(source, { recursive: true });
  git(temp, "init", "--bare", bare);
  git(source, "init");
  git(source, "config", "user.name", "Fleet Test");
  git(source, "config", "user.email", "fleet@example.test");
  mkdirSync(path.join(source, "packages", "app"), { recursive: true });
  writeFileSync(path.join(source, "packages", "app", "tracked.txt"), "base\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "base");
  git(source, "remote", "add", "origin", bare);
  git(source, "push", "origin", "HEAD:refs/heads/main");
  git(source, "remote", "set-url", "origin", "https://github.com/example/fleet-fixture");

  writeFileSync(path.join(source, "packages", "app", "tracked.txt"), "changed\n");
  writeFileSync(path.join(source, "packages", "app", "untracked.txt"), "portable\n");
  const workspace = await capturePortableFleetWorkspace(path.join(source, "packages", "app"));
  assert.equal(workspace.root, ".");
  assert.equal(workspace.repositoryUrl, "https://github.com/example/fleet-fixture");
  assert.equal(workspace.subdirectory, "packages/app");
  assert.ok(workspace.overlay?.patchBase64);
  assert.deepEqual(workspace.overlay?.untrackedFiles.map((file) => file.path), ["packages/app/untracked.txt"]);
});

test("Fleet rejects a checkpoint that has not been pushed", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cave-fleet-unpushed-"));
  git(root, "init");
  git(root, "config", "user.name", "Fleet Test");
  git(root, "config", "user.email", "fleet@example.test");
  writeFileSync(path.join(root, "tracked.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  git(root, "remote", "add", "origin", "https://github.com/example/fleet-unpushed-fixture");
  await assert.rejects(
    capturePortableFleetWorkspace(root),
    /Push the current commit/,
  );
});

test("Fleet rejects nested projects whose repository has untransferred outside changes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cave-fleet-nested-dirty-"));
  mkdirSync(path.join(root, "packages", "app"), { recursive: true });
  git(root, "init");
  git(root, "config", "user.name", "Fleet Test");
  git(root, "config", "user.email", "fleet@example.test");
  writeFileSync(path.join(root, "workspace.lock"), "base\n");
  writeFileSync(path.join(root, "packages", "app", "index.ts"), "export {};\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  git(root, "remote", "add", "origin", "https://github.com/example/fleet-nested-dirty");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(path.join(root, "workspace.lock"), "changed\n");

  await assert.rejects(
    capturePortableFleetWorkspace(path.join(root, "packages", "app")),
    /changes outside its project folder/,
  );
});

test("Fleet rejects non-Git workspaces before dispatch", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cave-fleet-nongit-"));
  await assert.rejects(
    capturePortableFleetWorkspace(root),
    /not a Git checkout/,
  );
});

test("Fleet rejects untracked links instead of silently changing workspace meaning", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cave-fleet-link-"));
  git(root, "init");
  git(root, "config", "user.name", "Fleet Test");
  git(root, "config", "user.email", "fleet@example.test");
  writeFileSync(path.join(root, "tracked.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  git(root, "remote", "add", "origin", "https://github.com/example/fleet-link-fixture");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  symlinkSync("tracked.txt", path.join(root, "untracked-link"));
  await assert.rejects(
    capturePortableFleetWorkspace(root),
    /cannot transfer untracked links or special files/,
  );
});
