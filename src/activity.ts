import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { hash } from "./identity.js";
import { failureReasons, type FailureReason } from "./privacy.js";

export type ActivityKind = "recall" | "capture";
const activitySchema = z.object({
  phase: z.enum(["running", "done", "partial", "failed", "skipped"]),
  count: z.number().int().nonnegative(),
  at: z.number(),
  reason: z.enum(failureReasons).optional(),
});
export type Activity = z.infer<typeof activitySchema>;

function activityPath(config: Config, conversationId: string, kind: ActivityKind): string {
  const identity = hash(`${config.baseUrl}\n${config.apiKey ?? ""}\n${conversationId}`);
  return join(config.stateDir, "activity", `${identity}.${kind}.json`);
}

/** Display-only state: never persist prompts, memory text, or error bodies. */
export async function recordActivity(config: Config, conversationId: string, kind: ActivityKind, phase: Activity["phase"], count = 0, reason?: FailureReason): Promise<void> {
  const path = activityPath(config, conversationId, kind);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(join(config.stateDir, "activity"), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ phase, count, at: Date.now(), reason } satisfies Activity), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch {
    // A status display must never break recall or capture.
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

export async function readActivity(config: Config, conversationId: string, kind: ActivityKind): Promise<Activity | undefined> {
  try {
    const result = activitySchema.safeParse(JSON.parse(await readFile(activityPath(config, conversationId, kind), "utf8")));
    return result.success ? result.data : undefined;
  } catch { return undefined; }
}

export function recallNotice(count: number): string {
  return `supermemory recalled ${count} ${count === 1 ? "memory" : "memories"}`;
}

export function countMemories(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const result = value as Record<string, unknown>;
  const identities = new Set<string>();
  for (const key of ["results", "memories", "project", "relevant", "searchResults"]) {
    const items = result[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item && typeof item === "object") {
        const identity = item.id ?? item.memory;
        if (typeof identity === "string" && identity) identities.add(identity);
      }
    }
  }
  const profile = result.profile as { static?: unknown[]; dynamic?: unknown[] } | undefined;
  for (const fact of [...(profile?.static ?? []), ...(profile?.dynamic ?? [])]) {
    if (typeof fact === "string" && fact) identities.add(fact);
  }
  return identities.size;
}
