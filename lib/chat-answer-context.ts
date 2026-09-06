import type { ModelMessage, ToolResultPart } from "ai";
import { tokenBound } from "./chat-contract";
import { ValidationError } from "./errors";

const CONTEXT_NOTE = "Der Antwortkontext wurde gekuerzt. Aeltere Nachrichten oder weitere Ergebniszeilen fehlen; vorhandene Werte sind unveraendert.";
const TOO_LARGE = "Die Frage und ihre neuesten Ergebnisse sind fuer eine Antwort zu umfangreich. Bitte die Frage eingrenzen.";
type Entry = { id: number; message: ModelMessage };

function lastEntry(entries: Entry[], predicate: (entry: Entry) => boolean): Entry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) if (predicate(entries[i])) return entries[i];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resultParts(message: ModelMessage): ToolResultPart[] {
  if ((message.role !== "assistant" && message.role !== "tool") || typeof message.content === "string") return [];
  return message.content.filter((part): part is ToolResultPart => part.type === "tool-result");
}

function replaceResult(message: ModelMessage, original: ToolResultPart, replacement: ToolResultPart): ModelMessage {
  if ((message.role !== "assistant" && message.role !== "tool") || typeof message.content === "string") return message;
  // The replacement is valid in both assistant and tool content arrays.
  if (message.role === "assistant") return { ...message, content: message.content.map(part => part === original ? replacement : part) };
  return { ...message, content: message.content.map(part => part === original ? replacement : part) };
}

/** A fixed data notice stays with the tool's output; source text gains no instruction authority. */
function withNotice(part: ToolResultPart): ToolResultPart {
  const output = part.output;
  switch (output.type) {
    case "json":
    case "error-json":
      return { ...part, output: { ...output, value: {
        ...(isObject(output.value) ? output.value : { result: output.value }),
        contextTruncated: true, contextNote: CONTEXT_NOTE,
      } } };
    case "text":
    case "error-text":
      return { ...part, output: { ...output, value: `${CONTEXT_NOTE}\n\n${output.value}` } };
    case "content":
      return { ...part, output: { ...output, value: [...output.value, { type: "text", text: CONTEXT_NOTE }] } };
    case "execution-denied":
      return { ...part, output: { ...output, reason: `${CONTEXT_NOTE}${output.reason ? `\n\n${output.reason}` : ""}` } };
  }
}

/**
 * Fits the final answer context without cutting a question, SQL query, JSON value,
 * or individual cell. At least one row from every retained nonempty table survives.
 * If the current question and newest complete tool exchange still cannot fit,
 * fail explicitly instead of constructing a misleading or invalid conversation.
 */
export function fitAnswerMessages(messages: ModelMessage[], maxBytes: number): ModelMessage[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new ValidationError(TOO_LARGE);
  let entries: Entry[] = messages.flatMap((message, id) => {
    if (message.role !== "assistant" || typeof message.content === "string") return [{ id, message }];
    const content = message.content.filter(part => part.type !== "reasoning" && part.type !== "reasoning-file");
    return content.length ? [{ id, message: { ...message, content } }] : [];
  });
  const current = () => entries.map(entry => entry.message);
  const size = () => tokenBound(current());
  if (size() <= maxBytes) return current();

  // Prefer complete rows over dropping an entire result. Halving large arrays
  // bounds work, including when several tools returned their maximum row count.
  for (;;) {
    let best: { entry: Entry; original: ToolResultPart; replacement: ToolResultPart; saving: number } | undefined;
    for (const entry of entries) {
      for (const part of resultParts(entry.message)) {
        if (part.output.type !== "json" || !isObject(part.output.value)) continue;
        const rows = part.output.value.rows;
        if (!Array.isArray(rows) || rows.length < 2) continue;
        const replacement = withNotice({ ...part, output: { ...part.output, value: {
          ...part.output.value, rows: rows.slice(0, Math.max(1, Math.floor(rows.length / 2))), truncated: true,
        } } });
        const saving = tokenBound(part) - tokenBound(replacement);
        if (saving > 0 && (!best || saving > best.saving)) best = { entry, original: part, replacement, saving };
      }
    }
    if (!best) break;
    best.entry.message = replaceResult(best.entry.message, best.original, best.replacement);
    if (size() <= maxBytes) return current();
  }

  // Connect every call with every matching result, even if parallel results
  // arrived in separate messages. Such a component is removed only as a whole.
  const parent = new Map(entries.map(entry => [entry.id, entry.id]));
  const group = (id: number): number => {
    if (!parent.has(id)) return id;
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const join = (left: number, right: number) => { parent.set(group(right), group(left)); };
  const calls = new Map<string, number>();
  for (const entry of entries) {
    const message = entry.message;
    if ((message.role !== "assistant" && message.role !== "tool") || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "tool-call" && part.type !== "tool-result") continue;
      const previous = calls.get(part.toolCallId);
      if (previous !== undefined) join(previous, entry.id);
      else calls.set(part.toolCallId, entry.id);
    }
  }
  const latestResult = lastEntry(entries, entry => resultParts(entry.message).length > 0);
  const latestUser = lastEntry(entries, entry => entry.message.role === "user");
  // A final synthesis instruction may follow the results. Preserve the original
  // question as well as that trailing instruction, without inspecting their text.
  const question = latestResult
    ? lastEntry(entries, entry => entry.message.role === "user" && entry.id < latestResult.id) ?? latestUser
    : latestUser;
  // Old conversational turns leave together; no detached historical answer remains.
  let historyStart: Entry | undefined;
  for (const entry of entries) {
    if (question && entry.id >= question.id) break;
    if (entry.message.role === "user") historyStart = entry;
    else if (historyStart && entry.message.role !== "system") join(historyStart.id, entry.id);
  }
  const protectedGroups = new Set(entries.filter(entry => entry.message.role === "system"
    || entry === latestUser || entry === question || entry === latestResult).map(entry => group(entry.id)));
  const removable = [...new Set(entries.map(entry => group(entry.id)))].filter(id => !protectedGroups.has(id));
  let noted = false;
  for (const id of removable) {
    entries = entries.filter(entry => group(entry.id) !== id);
    if (!noted) {
      const latest = lastEntry(entries, entry => resultParts(entry.message).length > 0);
      if (latest) {
        const part = resultParts(latest.message).at(-1)!;
        latest.message = replaceResult(latest.message, part, withNotice(part));
      } else {
        const questionIndex = entries.findIndex(entry => entry === latestUser);
        entries.splice(Math.max(0, questionIndex), 0, { id: -1, message: { role: "assistant", content: CONTEXT_NOTE } });
      }
      noted = true;
    }
    if (size() <= maxBytes) return current();
  }
  throw new ValidationError(TOO_LARGE);
}
