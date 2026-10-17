import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Config } from "./config.js";
import { readActivity, recallNotice, type Activity, type ActivityKind } from "./activity.js";

function describe(kind: ActivityKind, activity: Activity, config: Config, now: number): string {
  const budget = kind === "recall" ? config.recallTimeoutMs : config.requestTimeoutMs * 2;
  if (activity.phase === "running") {
    return now - activity.at > budget + 5000
      ? `${kind === "recall" ? "recall" : "save"} interrupted`
      : kind === "recall" ? "recalling…" : "saving…";
  }
  if (kind === "recall") {
    if (activity.phase === "skipped") return config.recallMode === "advisory" ? "advisory recall" : "recall skipped (no query)";
    if (activity.phase === "failed") return "recall unavailable";
    return `${recallNotice(activity.count).replace(/^supermemory /, "")}${activity.phase === "partial" ? " (partial)" : ""}`;
  }
  if (activity.phase === "failed") return `save unavailable${activity.count ? ` (${activity.count} queued)` : ""}`;
  return `saved ${activity.count} ${activity.count === 1 ? "document" : "documents"} (queued)`;
}

export async function renderStatusline(config: Config, payload: unknown, now = Date.now()): Promise<string> {
  if (!config.apiKey) return "◪ supermemory · API key not configured";
  const input = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const id = input.conversation_id ?? input.session_id;
  const [recall, capture] = typeof id === "string" && id
    ? await Promise.all([readActivity(config, id, "recall"), readActivity(config, id, "capture")])
    : [undefined, undefined];
  const parts: string[] = [];
  if (config.recallMode === "off") parts.push("recall off");
  else if (recall) parts.push(describe("recall", recall, config, now));
  else parts.push(config.recallMode === "advisory" ? "advisory recall" : "ready — waiting for recall");
  if (!config.captureEnabled) parts.push("capture off");
  else if (capture) parts.push(describe("capture", capture, config, now));
  return `◪ supermemory · ${parts.join(" · ")}`;
}

/** Render an existing user command first, under a short bounded budget. */
export async function upstreamStatusline(path: string | undefined, input: string): Promise<string> {
  if (!path) return "";
  try {
    const settings = JSON.parse(await readFile(path, "utf8")) as { command?: unknown };
    if (typeof settings.command !== "string" || !settings.command.trim()) return "";
    return await new Promise<string>((done) => {
      const child = exec(settings.command as string, { timeout: 1500, maxBuffer: 16384, windowsHide: true }, (error, stdout) => {
        done(error ? "" : stdout.trimEnd());
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  } catch { return ""; }
}
