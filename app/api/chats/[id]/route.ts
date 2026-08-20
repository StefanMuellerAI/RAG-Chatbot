import { errorResponse, readJson } from "@/lib/api";
import { requireUserId } from "@/lib/auth/user";
import {
  benenneChatUm,
  haengeNachrichtAn,
  ladeNachrichten,
  loescheChat,
  type VerlaufNachricht,
} from "@/lib/chats";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";

type Kontextparameter = { params: Promise<{ id: string }> };

/** Die Nachrichten eines Chats. */
export async function GET(_request: Request, kontextparameter: Kontextparameter) {
  try {
    const userId = await requireUserId();
    const { id } = await kontextparameter.params;

    return Response.json({ nachrichten: await ladeNachrichten(userId, id) });
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
