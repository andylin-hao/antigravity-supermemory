import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { hash } from "./identity.js";
import { redactPrivate } from "./privacy.js";

export interface Message { role: "user" | "assistant"; text: string; key: string }
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((part: unknown) => {
    const item = object(part);
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
}

/** Only explicit user/model text: no tool results, thinking, or injected context. */
export function parseTranscript(text: string): Message[] {
  const messages: Message[] = [];
  for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row: RecordValue;
    try { row = object(JSON.parse(line)); } catch { continue; }
    const nested = object(row.message);
    if (row.synthetic || row.isSynthetic || nested.synthetic || nested.isSynthetic) continue;
    const type = String(row.type ?? "").replace(/^CORTEX_STEP_TYPE_/, "");
    const source = String(row.source ?? "").replace(/^CORTEX_STEP_SOURCE_/, "");
    if (/SYSTEM|EPHEMERAL|TOOL|HISTORY|CHECKPOINT/.test(type)) continue;
    if (/SYSTEM|HOOK|TOOL|SYNTHETIC/.test(source)) continue;
    const role = row.role ?? nested.role;
    let kind: Message["role"];
    if (type === "USER_INPUT" || source === "USER_EXPLICIT" || role === "user") kind = "user";
    else if (type === "MODEL" || type === "PLANNER_RESPONSE" || (source === "MODEL" && type.endsWith("_RESPONSE")) || role === "assistant" || role === "model") kind = "assistant";
    else continue;
    if (row.status && /PENDING|RUNNING|ERROR|CANCEL/i.test(String(row.status))) continue;
    const content = textContent(row.content ?? nested.content);
    if (!content) continue;
    const index = row.step_index ?? row.stepIdx ?? row.id ?? lineIndex;
    messages.push({ role: kind, text: content, key: String(index) });
  }
  return messages;
}

export async function readTranscript(path: string): Promise<Message[]> {
  const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const file = await open(expanded, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error("Transcript must be a regular file smaller than 20 MiB");
    // Read only the snapshot size: a host may append another record concurrently.
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return parseTranscript(buffer.subarray(0, offset).toString("utf8"));
  } finally { await file.close(); }
}

export function completedTurns(messages: Message[]): { key: string; content: string }[] {
  const turns: { key: string; content: string }[] = [];
  let user: Message | undefined;
  let responses: string[] = [];
  function flush() {
    if (!user || !responses.length) return;
    // Redact the entire turn together so private spans across text blocks stay private.
    const content = redactPrivate(`User: ${user.text}\n\nAssistant: ${responses.join("\n\n")}`);
    if (content.replace(/User:|Assistant:/g, "").trim()) {
      turns.push({ key: hash(`${user.key}\n${content}`), content });
    }
  }
  for (const message of messages) {
    if (message.role === "user") {
      flush();
      user = message;
      responses = [];
    } else if (user) responses.push(message.text);
  }
  flush();
  return turns;
}
