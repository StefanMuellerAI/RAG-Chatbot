import Link from "next/link";
import { connection } from "next/server";
import ChatBereich from "@/components/ChatBereich";
import NichtBereit from "@/components/NichtBereit";
import { requireKontextFuerSeite } from "@/lib/auth/user";
import { ladeSammlungen, ladeSammlungsStatus } from "@/lib/collections";
import { missingFor } from "@/lib/env";
import { leseTagesstand } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export default async function ChatSeite() {
  // Request-Zeit, nicht Build-Zeit: sonst waeren die Server-Variablen leer,
  // obwohl sie in Vercel gesetzt sind.
  await connection();
  const fehlt = await missingFor("chat");
  if (fehlt.length > 0) return <NichtBereit bereich="Der Assistent" fehlt={fehlt} />;

  const kontext = await requireKontextFuerSeite("/");
  const [sammlungen, verbraucht, sammlungsStatus] = await Promise.all([
    ladeSammlungen(kontext.userId),
    leseTagesstand(kontext.userId),
    ladeSammlungsStatus(kontext.userId),
  ]);

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

      <ChatBereich key={kontext.userId} userId={kontext.userId} sammlungen={sammlungen.map((sammlung) => ({
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
