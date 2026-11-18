import lockfile from "proper-lockfile";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hash } from "./identity.js";

const MAX_SEEN_FACTS = 500;

const stateSchema = z.object({
  initialized: z.boolean().default(false),
  lastRecall: z.string().optional(),
  seenFacts: z.array(z.string()).default([]),
  discoverySent: z.boolean().default(false),
  captured: z.array(z.string()).default([]),
});

export type SessionState = z.infer<typeof stateSchema>;

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
      if (state.seenFacts.length > MAX_SEEN_FACTS) {
        state.seenFacts = state.seenFacts.slice(-MAX_SEEN_FACTS);
      }
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
        await rename(temp, path);
      } finally {
        await rm(temp, { force: true });
      }
    }
    return await work(state, checkpoint);
  } finally {
    await release();
  }
}

function noticesDir(stateDir: string): string {
  return join(stateDir, "notices");
}

async function writeNoticeFile(stateDir: string, name: string, payload: unknown): Promise<void> {
  const dir = noticesDir(stateDir);
  const path = join(dir, name);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(temp, JSON.stringify(payload), { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } catch { /* Notice persistence is best-effort. */ }
  finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export async function saveLastSession(stateDir: string, namespace: string, documentId: string, now = Date.now()): Promise<void> {
  if (!documentId) return;
  await writeNoticeFile(stateDir, `last-session.${hash(namespace).slice(0, 16)}.json`, {
    id: documentId,
    containerTag: namespace,
    savedAt: new Date(now).toISOString(),
  });
}

export async function welcomeBackNotice(stateDir: string, namespace: string, now = Date.now()): Promise<string | undefined> {
  try {
    const path = join(noticesDir(stateDir), `last-session.${hash(namespace).slice(0, 16)}.json`);
    const last = JSON.parse(await readFile(path, "utf8")) as { savedAt?: string; containerTag?: string };
    if (!last.savedAt || last.containerTag !== namespace) return undefined;
    const hours = (now - new Date(last.savedAt).getTime()) / 3600000;
    if (!(hours >= 6)) return undefined;
    const ago = hours < 48 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`;
    return `welcome back — last session here ${ago}`;
  } catch {
    return undefined;
  }
}

export async function writeCaptureNotice(stateDir: string, namespace: string, message: string): Promise<void> {
  await writeNoticeFile(stateDir, `capture-error.${hash(namespace).slice(0, 16)}.json`, {
    message,
    at: new Date().toISOString(),
  });
}

export async function clearCaptureNotice(stateDir: string, namespace: string): Promise<void> {
  await rm(join(noticesDir(stateDir), `capture-error.${hash(namespace).slice(0, 16)}.json`), { force: true }).catch(() => {});
}

export async function readCaptureNotice(stateDir: string, namespace: string): Promise<string | undefined> {
  try {
    const path = join(noticesDir(stateDir), `capture-error.${hash(namespace).slice(0, 16)}.json`);
    const data = JSON.parse(await readFile(path, "utf8")) as { message?: unknown };
    return typeof data.message === "string" && data.message ? data.message : undefined;
  } catch {
    return undefined;
  }
}
