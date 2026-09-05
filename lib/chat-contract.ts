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
  readonly maxOutput: number;
  readonly maxTotal: number;
  readonly maxStepOutput: number;
  reserved = 0;
  output = 0;
  constructor(detail: "compact" | "detailed") {
    this.maxOutput = detail === "detailed" ? 4800 : 2400;
    this.maxTotal = detail === "detailed" ? 160_000 : 100_000;
    this.maxStepOutput = detail === "detailed" ? 2400 : 1200;
  }
  reserve(input: number): number {
    const output = Math.min(this.maxStepOutput, this.maxOutput - this.output);
    if (input > this.maxStepInput || output <= 0 || this.reserved + input + output > this.maxTotal) {
      throw new ValidationError("Das Antwortbudget ist erreicht. Bitte die Frage eingrenzen oder eine Sammlung auswaehlen.");
    }
    this.reserved += input + output;
    return output;
  }
}
