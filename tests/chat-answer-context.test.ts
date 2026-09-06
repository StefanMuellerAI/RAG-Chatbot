import { describe, expect, it } from "vitest";
import type { ModelMessage, ToolResultPart } from "ai";
import { fitAnswerMessages } from "@/lib/chat-answer-context";
import { tokenBound } from "@/lib/chat-contract";
import { ValidationError } from "@/lib/errors";

const question: ModelMessage = { role: "user", content: "Welche Kennzahlen und Unterschiede finden sich in Hundehalter?" };
function query(id: string, sql = "SELECT wert FROM hundehalter"): ModelMessage {
  return { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "sql_ausfuehren", input: { sql } }] };
}
function result(id: string, rows: string[][]): ModelMessage {
  return { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "sql_ausfuehren", output: {
    type: "json", value: { ok: true, collection: "Hundehalter", columns: ["wert"], rows, rowCount: rows.length, truncated: false },
  } }] };
}
function results(messages: ModelMessage[]): ToolResultPart[] {
  return messages.flatMap(message => (message.role === "assistant" || message.role === "tool") && Array.isArray(message.content)
    ? message.content.filter((part): part is ToolResultPart => part.type === "tool-result") : []);
}
function callIds(messages: ModelMessage[]): string[] {
  return messages.flatMap(message => message.role === "assistant" && Array.isArray(message.content)
    ? message.content.filter(part => part.type === "tool-call").map(part => part.toolCallId) : []);
}

describe("Bounded final answer context", () => {
  it("keeps an already fitting question unchanged and counts UTF-8 bytes", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "ä🙂犬" }];
    expect(fitAnswerMessages(messages, tokenBound(messages))).toEqual(messages);
    expect(() => fitAnswerMessages(messages, tokenBound(messages) - 1)).toThrow(ValidationError);
  });

  it("removes reasoning without modifying the source conversation", () => {
    const messages: ModelMessage[] = [question, { role: "assistant", content: [
      { type: "reasoning", text: "interne Analyse ".repeat(3000) },
      { type: "tool-call", toolCallId: "a", toolName: "sql_ausfuehren", input: { sql: "SELECT 1" } },
    ] }, result("a", [["1"]])];
    const original = JSON.stringify(messages);
    const fitted = fitAnswerMessages(messages, 2000);
    expect(tokenBound(fitted)).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(fitted)).not.toContain("interne Analyse");
    expect(callIds(fitted)).toEqual(["a"]);
    expect(JSON.stringify(messages)).toBe(original);
  });

  it("fits eight large SQL results using whole rows and retains all call/result pairs", () => {
    const rows = Array.from({ length: 200 }, (_, i) => [`${i}: ä🙂${"Zelle".repeat(20)}`]);
    const messages: ModelMessage[] = [question, ...Array.from({ length: 8 }, (_, i) => [query(String(i)), result(String(i), rows)]).flat()];
    const original = JSON.stringify(messages);
    const fitted = fitAnswerMessages(messages, 24_000);
    expect(tokenBound(fitted)).toBeLessThanOrEqual(24_000);
    expect(fitted[0]).toEqual(question);
    expect(callIds(fitted)).toEqual(Array.from({ length: 8 }, (_, i) => String(i)));
    expect(results(fitted).map(part => part.toolCallId)).toEqual(callIds(fitted));
    for (const part of results(fitted)) {
      if (part.output.type !== "json") throw new Error("Expected structured output");
      const value = part.output.value as { rows: string[][]; rowCount: number; truncated: boolean; contextNote: string };
      expect(value.rows.length).toBeGreaterThanOrEqual(1);
      expect(value.rows.length).toBeLessThan(rows.length);
      expect(value.rows).toEqual(rows.slice(0, value.rows.length));
      expect(value.rowCount).toBe(200);
      expect(value.truncated).toBe(true);
      expect(value.contextNote).toContain("gekuerzt");
    }
    expect(JSON.stringify(messages)).toBe(original);
  });

  it("drops older exchanges atomically even when parallel results occupy separate messages", () => {
    const messages: ModelMessage[] = [question, { role: "assistant", content: [
      { type: "tool-call", toolCallId: "old-a", toolName: "sql_ausfuehren", input: { sql: "SELECT 'a'" } },
      { type: "tool-call", toolCallId: "old-b", toolName: "sql_ausfuehren", input: { sql: "SELECT 'b'" } },
    ] }, result("old-a", [["a".repeat(6000)]]), result("old-b", [["b"]]), query("new"), result("new", [["aktuell"]])];
    const fitted = fitAnswerMessages(messages, 1800);
    expect(tokenBound(fitted)).toBeLessThanOrEqual(1800);
    expect(callIds(fitted)).toEqual(["new"]);
    expect(results(fitted).map(part => part.toolCallId)).toEqual(["new"]);
    expect(JSON.stringify(fitted)).toContain("contextTruncated");
    expect(fitted[0]).toEqual(question);
  });

  it("retains the actual question when a final synthesis request follows the results", () => {
    const finalRequest: ModelMessage = { role: "user", content: "Jetzt anhand der Ergebnisse antworten." };
    const messages: ModelMessage[] = [
      { role: "user", content: "Alte Frage" }, { role: "assistant", content: "Alte Antwort ".repeat(1000) },
      question, query("new"), result("new", [["aktuell"]]), finalRequest,
    ];
    const fitted = fitAnswerMessages(messages, 1800);
    expect(tokenBound(fitted)).toBeLessThanOrEqual(1800);
    expect(fitted.filter(message => message.role === "user")).toEqual([question, finalRequest]);
    expect(JSON.stringify(fitted)).not.toContain("Alte Frage");
    expect(JSON.stringify(fitted)).not.toContain("Alte Antwort");
    expect(results(fitted)).toHaveLength(1);
  });

  it("adds a data notice when dropping ordinary history with no tools", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "erste alte Frage" }, { role: "assistant", content: "a".repeat(2000) },
      { role: "user", content: "zweite alte Frage" }, { role: "assistant", content: "b".repeat(2000) }, question,
    ];
    const fitted = fitAnswerMessages(messages, 700);
    expect(tokenBound(fitted)).toBeLessThanOrEqual(700);
    expect(fitted.at(-1)).toEqual(question);
    expect(JSON.stringify(fitted)).toContain("gekuerzt");
    expect(JSON.stringify(fitted)).not.toContain("alte Frage");
    expect(fitted.some(message => message.role === "system")).toBe(false);
  });

  it("keeps system instructions and refuses to truncate the newest single result cell", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "Stuetze Zahlen auf die Daten." }, question,
      query("new"), result("new", [["untrennbare Zelle".repeat(1000)]]),
    ];
    const original = JSON.stringify(messages);
    expect(() => fitAnswerMessages(messages, 1200)).toThrow(ValidationError);
    expect(JSON.stringify(messages)).toBe(original);
  });

  it("never slices a text retrieval result to make it fit", () => {
    const messages: ModelMessage[] = [question, query("new"), { role: "tool", content: [{
      type: "tool-result", toolCallId: "new", toolName: "sql_ausfuehren", output: { type: "text", value: "vollstaendige Quelle ".repeat(3000) },
    }] }];
    expect(() => fitAnswerMessages(messages, 1200)).toThrow(ValidationError);
  });

  it.each([0, -1, NaN, Infinity, 1.5])("rejects an invalid maximum %s", max => {
    expect(() => fitAnswerMessages([question], max)).toThrow(ValidationError);
  });
});
