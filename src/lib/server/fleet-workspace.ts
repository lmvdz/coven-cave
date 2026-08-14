import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeGitHubRepoUrl } from "../github-repo-link.ts";

const execFileAsync = promisify(execFile);
const MAX_WORKSPACE_BYTES = 768 * 1024;
const MAX_UNTRACKED_FILES = 256;

export type FleetWorkspaceFile = {
  path: string;
  dataBase64: string;
  executable?: boolean;
};

export type FleetWorkspaceOverlay = {
  patchBase64: string;
  digest: string;
  untrackedFiles: FleetWorkspaceFile[];
};

export type PortableFleetWorkspace = {
  root: ".";
  repositoryUrl: string;
  checkpoint: string;
  subdirectory?: string;
  overlay?: FleetWorkspaceOverlay;
};

function safeRelativePath(value: string): boolean {
  if (!value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  const parts = value.replaceAll("\\", "/").split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

async function git(root: string, args: string[], maxBuffer = 1024 * 1024): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    maxBuffer,
  });
  return result.stdout;
}

async function repositoryUrlForCheckpoint(
  repositoryRoot: string,
  checkpoint: string,
  configuredUrl?: string,
): Promise<string | null> {
  const configured = normalizeGitHubRepoUrl(configuredUrl);
  const containing = (await git(repositoryRoot, [
    "for-each-ref",
    "--contains",
    checkpoint,
    "--format=%(refname:short)",
    "refs/remotes",
  ]).catch(() => ""))
    .split(/\r?\n/)
    .map((value) => value.trim().split("/")[0])
    .filter((value): value is string => Boolean(value) && value !== "HEAD");
  const remoteNames = [...new Set(containing)];
  const portableRemotes: Array<{ name: string; url: string }> = [];
  for (const remoteName of remoteNames) {
    const candidate = normalizeGitHubRepoUrl(
      await git(repositoryRoot, ["remote", "get-url", remoteName]).catch(() => ""),
    );
    if (candidate) portableRemotes.push({ name: remoteName, url: candidate });
  }
  if (configured && portableRemotes.some((remote) => remote.url === configured)) return configured;
  return portableRemotes.find((remote) => remote.name === "origin")?.url
    ?? portableRemotes[0]?.url
    ?? null;
}

function overlayDigest(patchBytes: Buffer, files: FleetWorkspaceFile[]): string {
  const digest = createHash("sha256");
  digest.update(patchBytes);
  for (const file of files) {
    digest.update("\0");
    digest.update(file.path);
    digest.update(file.executable ? "\x01" : "\x00");
    digest.update(Buffer.from(file.dataBase64, "base64"));
  }
  return `sha256-${digest.digest("hex")}`;
}

/** Capture a path-free, bounded Git workspace specification for a Fleet turn. */
export async function capturePortableFleetWorkspace(
  projectRoot: string,
  configuredRepositoryUrl?: string,
): Promise<PortableFleetWorkspace> {
  const repositoryRootRaw = (await git(projectRoot, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  const checkpoint = (await git(projectRoot, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  if (!repositoryRootRaw || !/^[0-9a-f]{40}$/i.test(checkpoint)) {
    throw new Error("This project is not a Git checkout. Fleet cannot prepare it automatically yet.");
  }
  const [repositoryRoot, canonicalProjectRoot] = await Promise.all([
    realpath(repositoryRootRaw),
    realpath(projectRoot),
  ]);
  const repositoryUrl = await repositoryUrlForCheckpoint(repositoryRoot, checkpoint, configuredRepositoryUrl);
  if (!repositoryUrl) {
    throw new Error(
      "Fleet cannot fetch this exact revision from a supported GitHub remote. Push the current commit, then retry.",
    );
  }
  const relativeRoot = path.relative(repositoryRoot, canonicalProjectRoot).replaceAll("\\", "/");
  if (relativeRoot && !safeRelativePath(relativeRoot)) {
    throw new Error("This project folder cannot be represented safely for Fleet execution.");
  }
  const pathspec = relativeRoot || ".";
  const changedPaths = Buffer.from(
    await git(repositoryRoot, ["diff", "--name-only", "-z", "HEAD"], MAX_WORKSPACE_BYTES + 1),
    "utf8",
  ).toString("utf8").split("\0").filter(Boolean).map((value) => value.replaceAll("\\", "/"));
  const allUntracked = Buffer.from(
    await git(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z"], MAX_WORKSPACE_BYTES + 1),
    "utf8",
  ).toString("utf8").split("\0").filter(Boolean).map((value) => value.replaceAll("\\", "/"));
  if (relativeRoot) {
    const prefix = `${relativeRoot}/`;
    const outside = [...changedPaths, ...allUntracked].find(
      (candidate) => candidate !== relativeRoot && !candidate.startsWith(prefix),
    );
    if (outside) {
      throw new Error(
        "This nested project has local repository changes outside its project folder. Commit them or select the repository root before using Fleet.",
      );
    }
  }
  const patchBytes = Buffer.from(
    await git(repositoryRoot, ["diff", "--binary", "--full-index", "HEAD", "--", pathspec], MAX_WORKSPACE_BYTES + 1),
    "utf8",
  );
  if (patchBytes.length > MAX_WORKSPACE_BYTES) {
    throw new Error("This project has more than 768 KB of local changes. Commit or reduce them before using Fleet.");
  }
  const untracked = allUntracked;
  if (untracked.length > MAX_UNTRACKED_FILES) {
    throw new Error("This project has more than 256 untracked files. Commit or remove some before using Fleet.");
  }
  const untrackedFiles: FleetWorkspaceFile[] = [];
  let totalBytes = patchBytes.length;
  for (const relative of untracked.sort()) {
    const normalized = relative.replaceAll("\\", "/");
    if (!safeRelativePath(normalized)) {
      throw new Error("This project contains an untracked path that cannot be transferred safely.");
    }
    const absolute = path.resolve(repositoryRoot, relative);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Fleet cannot transfer untracked links or special files. Commit or remove them, then retry.");
    }
    const bytes = await readFile(absolute);
    totalBytes += bytes.length;
    if (totalBytes > MAX_WORKSPACE_BYTES) {
      throw new Error("This project has more than 768 KB of local changes. Commit or reduce them before using Fleet.");
    }
    untrackedFiles.push({
      path: normalized,
      dataBase64: bytes.toString("base64"),
      ...(metadata.mode & 0o111 ? { executable: true } : {}),
    });
  }
  const workspace: PortableFleetWorkspace = {
    root: ".",
    repositoryUrl,
    checkpoint,
    ...(relativeRoot ? { subdirectory: relativeRoot } : {}),
  };
  if (patchBytes.length || untrackedFiles.length) {
    workspace.overlay = {
      patchBase64: patchBytes.toString("base64"),
      digest: overlayDigest(patchBytes, untrackedFiles),
      untrackedFiles,
    };
  }
  return workspace;
}
