import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { Config } from "./config.js";

export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function git(directory: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: directory, encoding: "utf8", timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    }).trim() || undefined;
  } catch { return undefined; }
}

/** Matches the normalized origin identity used by current opencode-supermemory. */
export function normalizeRemote(remote: string): string {
  let normalized: string;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(remote)) {
    const url = new URL(remote);
    normalized = url.protocol === "file:"
      ? `file:${decodeURIComponent(url.pathname)}`
      : `${url.hostname}${url.port ? `:${url.port}` : ""}/${url.pathname.replace(/^\/+/, "")}`;
  } else {
    const scp = remote.match(/^(?:[^@/]+@)?([^:]+):(.+)$/);
    normalized = scp ? `${scp[1]}/${scp[2]}` : `file:${resolve(remote)}`;
  }
  return normalized.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/{2,}/g, "/").toLowerCase();
}

export function projectIdentity(workspace: string, config: Pick<Config, "isolateWorktrees" | "projectContainerTag">) {
  let root = git(workspace, "rev-parse", "--show-toplevel") ?? resolve(workspace);
  if (!config.isolateWorktrees) {
    const common = git(workspace, "rev-parse", "--git-common-dir");
    if (common && basename(common) === ".git") root = dirname(resolve(workspace, common));
  }
  root = realpathSync(root);
  const remote = git(root, "remote", "get-url", "origin");
  const normalized = remote ? normalizeRemote(remote) : undefined;
  const display = remote?.replace(/\/+$/, "").replace(/\.git$/i, "");
  const name = display?.slice(Math.max(display.lastIndexOf("/"), display.lastIndexOf(":")) + 1) || basename(root);
  const shortName = name.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 72).replace(/_+$/, "") || "unknown";
  const id = hash(!config.isolateWorktrees && normalized ? normalized : `path:${root}`).slice(0, 16);
  return { root, name, id, tag: config.projectContainerTag ?? `repo_${shortName}__${id}` };
}
