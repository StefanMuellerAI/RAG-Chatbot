import { errorResponse, readJson } from "@/lib/api";
import { requireUserId } from "@/lib/auth/user";
import {
  benenneChatUm,
  haengeNachrichtAn,
  loescheChat,
  type VerlaufNachricht,
} from "@/lib/chats";
import { ValidationError } from "@/lib/errors";
import { messagePage, pageSize } from "@/lib/chat-pages";

export const runtime = "nodejs";

type Kontextparameter = { params: Promise<{ id: string }> };

/** Die Nachrichten eines Chats. */
export async function GET(request: Request, kontextparameter: Kontextparameter) {
  try {
    const userId = await requireUserId();
    const { id } = await kontextparameter.params;

    const query = new URL(request.url).searchParams;
    return Response.json(await messagePage(userId, id, query.get("before"), pageSize(query.get("limit"), 40)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Haengt eine Nachricht an. */
export async function POST(request: Request, kontextparameter: Kontextparameter) {
  try {
    const userId = await requireUserId();
    const { id } = await kontextparameter.params;

    const eingabe = await readJson<{ nachricht?: VerlaufNachricht }>(request);
    if (!eingabe.nachricht) throw new ValidationError("Es wurde keine Nachricht uebermittelt.");

    await haengeNachrichtAn(userId, id, eingabe.nachricht);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, kontextparameter: Kontextparameter) {
  try {
    const userId = await requireUserId();
    const { id } = await kontextparameter.params;

    const eingabe = await readJson<{ titel?: string }>(request);
    await benenneChatUm(userId, id, String(eingabe.titel ?? ""));

    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, kontextparameter: Kontextparameter) {
  try {
    const userId = await requireUserId();
    const { id } = await kontextparameter.params;

    await loescheChat(userId, id);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
