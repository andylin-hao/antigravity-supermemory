import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { openingPromptMarker } from "./dedupe.js";
import { hash } from "./identity.js";
import { redactPrivate, redactSecrets, stripInjectedContext } from "./privacy.js";
import { TASK_NOTIFICATION_PREFIX } from "./session-scope.js";

export interface Message {
  role: "user" | "assistant";
  text: string;
  key: string;
  isTaskNotification?: boolean;
}

export interface ParseTranscriptOptions {
  includeTools?: string[];
  captureSubagents?: boolean;
}

export interface CompletedTurn {
  key: string;
  content: string;
  contentWithMarker?: string;
  openingPrompt?: string;
  isOpening: boolean;
  selected: boolean;
}

export interface CompletedTurnsOptions {
  signalExtraction?: boolean;
  signalKeywords?: string[];
  signalTurnsBefore?: number;
  redactSecrets?: boolean;
}

const MAX_TOOL_RESULT_CHARS = 500;
const USER_AUTHORED_SUBKINDS = new Set(["scheduled-trigger", "session-inbox"]);

type RecordValue = Record<string, unknown>;

function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function matchesIncludedTool(toolName: string, includeSet: Set<string>): boolean {
  if (!includeSet.size || !toolName) return false;
  const lower = toolName.toLowerCase();
  if (includeSet.has(lower)) return true;
  const withoutMcp = lower.replace(/^mcp_[^_]+_[^_]+_/, "");
  if (includeSet.has(withoutMcp)) return true;
  const slashTail = lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : "";
  return Boolean(slashTail && includeSet.has(slashTail));
}

function formatToolArgs(args: unknown): string {
  const obj = object(args);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    if (raw !== undefined) parts.push(`${key}="${truncate(raw, 100)}"`);
  }
  return parts.join(" ");
}

function extractTextAndTools(value: unknown, includeSet: Set<string>, toolUseMap: Map<string, string>): { text: string; toolLines: string[] } {
  if (typeof value === "string") {
    return { text: stripInjectedContext(value), toolLines: [] };
  }
  if (!Array.isArray(value)) return { text: "", toolLines: [] };
  const texts: string[] = [];
  const toolLines: string[] = [];
  for (const part of value) {
    const item = object(part);
    if (item.type === "thinking") continue;
    if (item.type === "text" && typeof item.text === "string") {
      const cleaned = stripInjectedContext(item.text);
      if (cleaned) texts.push(cleaned);
    } else if (item.type === "tool_use") {
      const name = typeof item.name === "string" ? item.name : "unknown";
      const id = typeof item.id === "string" ? item.id : "";
      if (id) toolUseMap.set(id, name);
      if (matchesIncludedTool(name, includeSet)) {
        const args = formatToolArgs(item.input);
        toolLines.push(`[Tool ${name}${args ? `: ${args}` : ""}]`);
      }
    } else if (item.type === "tool_result") {
      const id = typeof item.tool_use_id === "string" ? item.tool_use_id : "";
      const name = toolUseMap.get(id) ?? "unknown";
      if (!matchesIncludedTool(name, includeSet)) continue;
      const rawResult = typeof item.content === "string"
        ? item.content
        : Array.isArray(item.content)
          ? item.content.flatMap((block: unknown) => {
            const b = object(block);
            return typeof b.text === "string" ? [b.text] : [];
          }).join("\n")
          : "";
      const cleaned = truncate(stripInjectedContext(rawResult), MAX_TOOL_RESULT_CHARS);
      if (cleaned) {
        const status = item.is_error ? "error" : "ok";
        toolLines.push(`[Tool result ${name} (${status}): ${cleaned}]`);
      }
    }
  }
  return { text: texts.join("\n"), toolLines };
}

function isHostNotificationRow(row: RecordValue, text: string): boolean {
  const origin = object(row.origin);
  if (origin.kind === "task-notification" && !USER_AUTHORED_SUBKINDS.has(String(origin.subkind ?? ""))) {
    return true;
  }
  return text.trimStart().startsWith(TASK_NOTIFICATION_PREFIX);
}

/** Only explicit user/model text (plus opt-in included tools): no thinking or injected context. */
export function parseTranscript(text: string, options: ParseTranscriptOptions = {}): Message[] {
  const includeSet = new Set((options.includeTools ?? []).map((name) => name.toLowerCase()));
  const captureSubagents = options.captureSubagents ?? false;
  const toolUseMap = new Map<string, string>();
  const rawMessages: Message[] = [];
  for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row: RecordValue;
    try { row = object(JSON.parse(line)); } catch { continue; }
    const nested = object(row.message);
    if (row.synthetic || row.isSynthetic || nested.synthetic || nested.isSynthetic) continue;
    if (row.status && /PENDING|RUNNING|ERROR|CANCEL/i.test(String(row.status))) continue;
    const type = String(row.type ?? "").replace(/^CORTEX_STEP_TYPE_/, "");
    const source = String(row.source ?? "").replace(/^CORTEX_STEP_SOURCE_/, "");
    if (/SYSTEM|EPHEMERAL|HISTORY|CHECKPOINT/.test(type)) continue;
    if (/SYSTEM|HOOK|SYNTHETIC/.test(source)) continue;
    const role = row.role ?? nested.role;
    const isExplicitUser = type === "USER_INPUT" || source === "USER_EXPLICIT" || role === "user";
    const isExplicitAssistant = type === "MODEL" || type === "PLANNER_RESPONSE" || (source === "MODEL" && type.endsWith("_RESPONSE")) || role === "assistant" || role === "model";
    if (!isExplicitUser && !isExplicitAssistant) {
      if (includeSet.size > 0 && type && matchesIncludedTool(type, includeSet)) {
        const output = truncate(stripInjectedContext(typeof row.content === "string" ? row.content : ""), MAX_TOOL_RESULT_CHARS);
        if (output) {
          const index = row.step_index ?? row.stepIdx ?? row.id ?? lineIndex;
          rawMessages.push({ role: "assistant", text: `[Tool result ${type.toLowerCase()}: ${output}]`, key: String(index) });
        }
      }
      continue;
    }
    if (/TOOL/.test(type) || /TOOL/.test(source)) continue;
    const { text: extractedText, toolLines } = extractTextAndTools(row.content ?? nested.content, includeSet, toolUseMap);
    if (isExplicitAssistant && includeSet.size > 0 && Array.isArray(row.tool_calls)) {
      for (const call of row.tool_calls) {
        const callObj = object(call);
        const fnObj = object(callObj.function);
        const name = String(callObj.name ?? fnObj.name ?? "");
        if (matchesIncludedTool(name, includeSet)) {
          const args = formatToolArgs(callObj.args ?? callObj.arguments ?? fnObj.arguments);
          toolLines.push(`[Tool ${name}${args ? `: ${args}` : ""}]`);
        }
      }
    }
    const parts = [extractedText, ...toolLines].filter(Boolean);
    if (!parts.length) continue;
    const index = row.step_index ?? row.stepIdx ?? row.id ?? lineIndex;
    if (isExplicitUser) {
      if (!extractedText && toolLines.length) {
        rawMessages.push({ role: "assistant", text: toolLines.join("\n"), key: String(index) });
        continue;
      }
      const notification = isHostNotificationRow(row, extractedText);
      rawMessages.push({
        role: "user",
        text: extractedText,
        key: String(index),
        ...(notification ? { isTaskNotification: true } : {}),
      });
    } else {
      rawMessages.push({ role: "assistant", text: parts.join("\n"), key: String(index) });
    }
  }
  if (captureSubagents) return rawMessages;
  const filtered: Message[] = [];
  let inNotificationTurn = false;
  for (const msg of rawMessages) {
    if (msg.role === "user" && !msg.text.startsWith("[Request interrupted by user")) {
      inNotificationTurn = Boolean(msg.isTaskNotification);
    }
    if (!inNotificationTurn) filtered.push(msg);
  }
  return filtered;
}

export async function readTranscript(path: string, options: ParseTranscriptOptions = {}): Promise<Message[]> {
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
    return parseTranscript(buffer.subarray(0, offset).toString("utf8"), options);
  } finally {
    await file.close();
  }
}

export function completedTurns(messages: Message[], options: CompletedTurnsOptions = {}): CompletedTurn[] {
  interface RawTurn {
    userKey: string;
    userText: string;
    assistantText: string;
    content: string;
    contentWithMarker?: string;
    openingPrompt?: string;
    isOpening: boolean;
  }
  const rawTurns: RawTurn[] = [];
  let user: Message | undefined;
  let responses: string[] = [];
  let seenOpening = false;
  const sanitize = (text: string) => options.redactSecrets ? redactSecrets(redactPrivate(text)) : redactPrivate(text);
  function flush() {
    if (!user || !responses.length) return;
    // Redact the entire turn together so private spans across text blocks stay private.
    const combined = sanitize(`User: ${user.text}\n\nAssistant: ${responses.join("\n\n")}`);
    if (!combined.replace(/User:|Assistant:/g, "").trim()) return;
    const isOpening = !seenOpening;
    seenOpening = true;
    const cleanUser = sanitize(user.text);
    const cleanAssistant = sanitize(responses.join("\n\n"));
    const contentWithMarker = isOpening && cleanUser ? `User: ${openingPromptMarker(cleanUser)}\n\nAssistant: ${cleanAssistant}` : undefined;
    rawTurns.push({
      userKey: user.key,
      userText: cleanUser,
      assistantText: cleanAssistant,
      content: combined,
      contentWithMarker,
      openingPrompt: isOpening ? cleanUser : undefined,
      isOpening,
    });
  }
  for (const message of messages) {
    if (message.role === "user") {
      flush();
      user = message;
      responses = [];
    } else if (user) {
      responses.push(message.text);
    }
  }
  flush();
  if (!options.signalExtraction) {
    return rawTurns.map((turn) => ({
      key: hash(`${turn.userKey}\n${turn.content}`),
      content: turn.content,
      contentWithMarker: turn.contentWithMarker,
      openingPrompt: turn.openingPrompt,
      isOpening: turn.isOpening,
      selected: true,
    }));
  }
  const keywords = (options.signalKeywords ?? []).map((kw) => kw.toLowerCase()).filter(Boolean);
  const turnsBefore = options.signalTurnsBefore ?? 3;
  const selectedIndices = new Set<number>();
  rawTurns.forEach((turn, idx) => {
    const haystack = turn.content.toLowerCase();
    if (keywords.some((kw) => haystack.includes(kw))) {
      for (let back = Math.max(0, idx - turnsBefore); back <= idx; back++) {
        selectedIndices.add(back);
      }
    }
  });
  return rawTurns.map((turn, idx) => ({
    key: hash(`${turn.userKey}\n${turn.content}`),
    content: turn.content,
    contentWithMarker: turn.contentWithMarker,
    openingPrompt: turn.openingPrompt,
    isOpening: turn.isOpening,
    selected: selectedIndices.has(idx),
  }));
}
