import { z } from "zod";
import { errorResponse, readJson } from "@/lib/api";
import { requireUserId } from "@/lib/auth/user";
import { saveFeedback } from "@/lib/chat-generation";
import { ValidationError } from "@/lib/errors";

const schema = z.object({ messageId: z.uuid(), helpful: z.boolean(), reason: z.string().trim().max(500).optional() });
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await context.params;
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new ValidationError("Bitte eine gueltige Rueckmeldung uebermitteln.");
    const { messageId, ...feedback } = parsed.data;
    await saveFeedback(userId, id, messageId, feedback);
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
