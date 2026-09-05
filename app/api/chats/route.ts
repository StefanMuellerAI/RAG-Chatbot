import { errorResponse, readJson } from "@/lib/api";
import { requireKontext, requireUserId } from "@/lib/auth/user";
import { chatPage, pageSize } from "@/lib/chat-pages";
import {
  erstelleChat,
  ladeChats,
  loescheAlleChats,
  uebernehmeVerlauf,
  type VerlaufNachricht,
} from "@/lib/chats";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const userId = await requireUserId();
    const query = new URL(request.url).searchParams;
    return Response.json(await chatPage(userId, query.get("before"), pageSize(query.get("limit"), 30)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Legt einen Chat an — oder uebernimmt einen mitgebrachten Verlauf.
 *
 * Der zweite Fall greift genau einmal: wenn ein Nutzer, dessen Gespraeche noch
 * im Browser liegen, sich erstmals anmeldet.
 */
export async function POST(request: Request) {
  try {
    const { userId } = await requireKontext();

    type Eingabe = {
      titel?: string;
      uebernahme?: { titel: string; nachrichten: VerlaufNachricht[] }[];
    };

    // Ein leerer Koerper ist der Normalfall beim Anlegen eines Chats und darf
    // deshalb nicht als Fehler gelten.
    const eingabe: Eingabe = await readJson<Eingabe>(request).catch(() => ({}));

    if (Array.isArray(eingabe.uebernahme)) {
      const anzahl = await uebernehmeVerlauf(userId, eingabe.uebernahme);
      return Response.json({ uebernommen: anzahl, chats: await ladeChats(userId) });
    }

    return Response.json({ chat: await erstelleChat(userId, eingabe.titel), authenticatedUserId: userId }, {
      status: 201, headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE() {
  try {
    const userId = await requireUserId();
    return Response.json({ ok: true, entfernt: await loescheAlleChats(userId) });
  } catch (error) {
    return errorResponse(error);
  }
}
