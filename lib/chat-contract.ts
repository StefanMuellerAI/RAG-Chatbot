import { z } from "zod";
import { ValidationError } from "./errors";

export const chatRequestSchema = z.object({
  chatId: z.uuid(),
  requestId: z.uuid(),
  question: z.string().trim().min(1).max(2000),
  collectionIds: z.array(z.uuid()).max(100).optional(),
  detail: z.enum(["compact", "detailed"]).default("compact"),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type GenerationStatus = "streaming" | "completed" | "failed" | "aborted";

/** Conservative upper estimate for UTF-8 text, not an exact tokenizer. */
export function tokenBound(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

export class AnswerBudget {
  readonly maxStepInput = 32_000;
  readonly maxTotal: number;
  readonly maxResearchOutput = 3600;
  readonly maxStepOutput = 1200;
  readonly maxAnswerOutput: number;
  reserved = 0;
  output = 0;
  private researchOutput = 0;
  private answerReserved = false;
  private pending?: { kind: "research" | "answer"; output: number };
  constructor(detail: "compact" | "detailed") {
    this.maxAnswerOutput = detail === "detailed" ? 4800 : 2400;
    this.maxTotal = detail === "detailed" ? 160_000 : 100_000;
  }

  /** Every research call must leave room for a full final input AND answer. */
  canResearch(input: number): boolean {
    return !this.answerReserved && Number.isSafeInteger(input) && input >= 0 && input <= this.maxStepInput
      && this.researchOutput + this.maxStepOutput <= this.maxResearchOutput
      && this.reserved + input + this.maxStepOutput + this.maxStepInput + this.maxAnswerOutput <= this.maxTotal;
  }

  reserve(input: number, kind: "research" | "answer" = "answer"): number {
    const output = kind === "research" ? this.maxStepOutput : this.maxAnswerOutput;
    if (!Number.isSafeInteger(input) || input < 0 || input > this.maxStepInput || this.answerReserved
      || this.reserved + input + output > this.maxTotal || kind === "research" && !this.canResearch(input)) {
      throw new ValidationError("Das Antwortbudget ist erreicht. Bitte die Frage eingrenzen oder eine Sammlung auswaehlen.");
    }
    this.reserved += input + output;
    this.pending = { kind, output };
    if (kind === "answer") this.answerReserved = true;
    return output;
  }

  record(outputTokens: number | undefined): void {
    if (!this.pending) return;
    // Missing provider usage must not make subsequent research calls free.
    const spent = Number.isSafeInteger(outputTokens) && outputTokens! >= 0 ? outputTokens! : this.pending.output;
    this.output += spent;
    if (this.pending.kind === "research") this.researchOutput += spent;
    this.pending = undefined;
  }
}
