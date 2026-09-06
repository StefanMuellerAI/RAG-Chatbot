import Link from "next/link";
import { connection } from "next/server";
import ChatBereich from "@/components/ChatBereich";
import NichtBereit from "@/components/NichtBereit";
import { requireKontextFuerSeite } from "@/lib/auth/user";
import { ladeChatSeite } from "@/lib/chat-pages";
import type { Startzustand } from "@/lib/chatVerlauf";
import { missingFor } from "@/lib/env";
import { starteMessung } from "@/lib/messung";
import { leseTagesstand } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export default async function ChatSeite({
  searchParams,
}: {
  searchParams: Promise<{ chat?: string }>;
}) {
  // Request-Zeit, nicht Build-Zeit: sonst waeren die Server-Variablen leer,
  // obwohl sie in Vercel gesetzt sind.
  await connection();
  const messung = starteMessung("page_render", { route: "/" });
  const fehlt = await missingFor("chat");
  if (fehlt.length > 0) return <NichtBereit bereich="Der Assistent" fehlt={fehlt} />;
  messung.phase("env");

  const kontext = await requireKontextFuerSeite("/");
  messung.phase("kontext");
  // Sammlungen, Verarbeitungsstand, Chatliste und der per Adresse gewaehlte
  // Chat kommen in einem Datenbank-Batch; der Tagesstand parallel aus Redis.
  const { chat } = await searchParams;
  const [seite, verbraucht] = await Promise.all([
    ladeChatSeite(kontext.userId, chat ?? null),
    leseTagesstand(kontext.userId),
  ]);
  const { sammlungen, status: sammlungsStatus } = seite;
  messung.phase("daten");
  messung.ende({ sammlungen: sammlungen.length, chats: seite.chats.chats.length });

  const start: Startzustand = {
    chats: seite.chats.chats,
    nextCursor: seite.chats.nextCursor,
    aktiverChat: seite.aktiverChat
      ? {
          chat: seite.aktiverChat.chat,
          nextCursor: seite.aktiverChat.nextCursor,
          // Nur, was der Browser auch ueber die API bekaeme: keine Roh-Spalten.
          messages: seite.aktiverChat.messages.map((nachricht) => ({
            id: nachricht.id,
            role: nachricht.role,
            content: nachricht.content,
            sources: nachricht.sources ?? undefined,
            steps: nachricht.steps ?? undefined,
            status: nachricht.status,
            requestId: nachricht.requestId,
            fehler: nachricht.fehler,
            feedback: nachricht.feedback ?? null,
            request: nachricht.request ?? null,
          })),
        }
      : null,
  };

  return (
    <>
      {sammlungen.length === 0 ? (
        <div className="meldung meldung-neutral">
          <b>Noch keine Sammlung angelegt.</b> Der Assistent antwortet ausschliesslich aus
          Ihren eigenen Unterlagen. Legen Sie unter{" "}
          <Link href="/sammlungen">Sammlungen</Link> eine an und pflegen Sie Dokumente ein.
        </div>
      ) : (
        <p className="kontingentzeile">
          {sammlungen.length}{" "}
          {sammlungen.length === 1 ? "Sammlung" : "Sammlungen"} verfügbar ·{" "}
          {verbraucht} von {kontext.plan.maxQuestionsPerDay} Fragen heute genutzt
          {sammlungen.length > 1 && " · der Assistent waehlt selbst, wo er sucht"}
        </p>
      )}

      <ChatBereich key={kontext.userId} userId={kontext.userId} start={start} sammlungen={sammlungen.map((sammlung) => ({
        id: sammlung.id,
        name: sammlung.name,
        kind: sammlung.kind,
        documentCount: sammlung.documentCount,
        updatedAt: sammlung.updatedAt.toISOString(),
        processingStatus: sammlungsStatus[sammlung.id] ?? { ready: 0, pending: 0, failed: 0 },
      }))} />
    </>
  );
}
