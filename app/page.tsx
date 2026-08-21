import Link from "next/link";
import { connection } from "next/server";
import ChatBereich from "@/components/ChatBereich";
import NichtBereit from "@/components/NichtBereit";
import { requireKontextFuerSeite } from "@/lib/auth/user";
import { ladeSammlungen } from "@/lib/collections";
import { missingFor } from "@/lib/env";
import { leseTagesstand } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export default async function ChatSeite() {
  // Request-Zeit, nicht Build-Zeit: sonst waeren die Server-Variablen leer,
  // obwohl sie in Vercel gesetzt sind.
  await connection();
  const fehlt = missingFor("chat");
  if (fehlt.length > 0) return <NichtBereit bereich="Der Assistent" fehlt={fehlt} />;

  const kontext = await requireKontextFuerSeite("/");
  const [sammlungen, verbraucht] = await Promise.all([
    ladeSammlungen(kontext.userId),
    leseTagesstand(kontext.userId),
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
          {sammlungen.length === 1 ? "Sammlung" : "Sammlungen"} durchsuchbar ·{" "}
          {verbraucht} von {kontext.plan.maxQuestionsPerDay} Fragen heute genutzt
          {sammlungen.length > 1 && " · der Assistent waehlt selbst, wo er sucht"}
        </p>
      )}

      <ChatBereich />
    </>
  );
}
