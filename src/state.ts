import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { hash } from "./identity.js";

const stateSchema = z.object({
  initialized: z.boolean().default(false),
  lastRecall: z.string().optional(),
  captured: z.array(z.string()).default([]),
});
export type SessionState = z.infer<typeof stateSchema>;

/** Atomic checkpoints and a process-safe lease; busy hooks fail open. */
export async function withSession<T>(
  directory: string,
  sessionKey: string,
  work: (state: SessionState, checkpoint: () => Promise<void>) => Promise<T>,
): Promise<T | undefined> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${hash(sessionKey)}.json`);
  const handle = await open(path, "a", 0o600);
  await handle.close();
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(path, { realpath: false, stale: 30000, update: 10000, retries: 0 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") return undefined;
    throw error;
  }
  try {
    const text = await readFile(path, "utf8");
    const state = stateSchema.parse(text ? JSON.parse(text) : {});
    async function checkpoint() {
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
        await rename(temp, path);
      } finally { await rm(temp, { force: true }); }
    }
    return await work(state, checkpoint);
  } finally { await release(); }
}
