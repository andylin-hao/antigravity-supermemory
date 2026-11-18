import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hash } from "./identity.js";

export const MIN_OPENING_PROMPT_LENGTH = 200;
export const OPENING_PROMPT_TTL_MS = 24 * 60 * 60 * 1000;
export const RECALL_WINDOW_MS = 10 * 60 * 1000;
const MAX_OPENING_PROMPTS = 500;
const MAX_RECALL_CACHE = 50;

export interface CachedRecallItem {
  id: string;
  memory: string;
  title?: string;
  filepath?: string;
}

interface IndexEntry {
  key: string;
  at: number;
  session?: string;
  results?: CachedRecallItem[];
}

function dedupeDir(stateDir: string): string {
  return join(stateDir, "dedupe");
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function readIndex(file: string, ttlMs: number, now: number): Promise<IndexEntry[]> {
  const cutoff = now - ttlMs;
  try {
    const list: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(list)) return [];
    return list.filter((item): item is IndexEntry => Boolean(
      item && typeof item === "object"
      && typeof (item as IndexEntry).key === "string"
      && typeof (item as IndexEntry).at === "number"
      && Number.isFinite((item as IndexEntry).at)
      && (item as IndexEntry).at >= cutoff,
    ));
  } catch {
    return [];
  }
}

async function writeIndex(stateDir: string, file: string, list: IndexEntry[], max: number): Promise<void> {
  const dir = dedupeDir(stateDir);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(temp, JSON.stringify(list.slice(-max)), { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } catch { /* Dedupe cache writes are best-effort. */ }
  finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

function openingKey(scope: string, text: string): string | undefined {
  const normalized = normalizeText(text);
  return normalized.length >= MIN_OPENING_PROMPT_LENGTH ? hash(`${scope}\n${normalized}`) : undefined;
}

export function openingPromptMarker(text: string): string {
  const shortHash = hash(normalizeText(text)).slice(0, 16);
  return `[opening prompt already captured from this machine: ${shortHash}]`;
}

export async function hasOpeningPrompt(scope: string, text: string, stateDir: string, now = Date.now()): Promise<boolean> {
  const key = openingKey(scope, text);
  if (!key) return false;
  const file = join(dedupeDir(stateDir), "opening-prompts.json");
  const entries = await readIndex(file, OPENING_PROMPT_TTL_MS, now);
  return entries.some((entry) => entry.key === key);
}

export async function rememberOpeningPrompt(scope: string, text: string, stateDir: string, now = Date.now()): Promise<void> {
  const key = openingKey(scope, text);
  if (!key) return;
  const file = join(dedupeDir(stateDir), "opening-prompts.json");
  const entries = (await readIndex(file, OPENING_PROMPT_TTL_MS, now)).filter((entry) => entry.key !== key);
  entries.push({ key, at: now });
  await writeIndex(stateDir, file, entries, MAX_OPENING_PROMPTS);
}

export async function cachedRecall(scope: string, query: string, conversationId: string, stateDir: string, now = Date.now()): Promise<CachedRecallItem[] | undefined> {
  const key = hash(`${scope}\n${normalizeText(query)}`);
  const session = hash(conversationId);
  const file = join(dedupeDir(stateDir), "recall-cache.json");
  const entries = await readIndex(file, RECALL_WINDOW_MS, now);
  const hit = entries.find((entry) => entry.key === key && entry.session !== session && Array.isArray(entry.results));
  return hit?.results;
}

export async function cacheRecall(scope: string, query: string, conversationId: string, results: CachedRecallItem[], stateDir: string, now = Date.now()): Promise<void> {
  const key = hash(`${scope}\n${normalizeText(query)}`);
  const file = join(dedupeDir(stateDir), "recall-cache.json");
  const entries = (await readIndex(file, RECALL_WINDOW_MS, now)).filter((entry) => entry.key !== key);
  entries.push({ key, session: hash(conversationId), at: now, results });
  await writeIndex(stateDir, file, entries, MAX_RECALL_CACHE);
}

export async function clearDedupeCaches(stateDir: string): Promise<void> {
  const dir = dedupeDir(stateDir);
  await Promise.all([
    rm(join(dir, "opening-prompts.json"), { force: true }).catch(() => {}),
    rm(join(dir, "recall-cache.json"), { force: true }).catch(() => {}),
  ]);
}
