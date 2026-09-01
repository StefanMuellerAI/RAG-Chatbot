import ChatPanel, { type ChatSammlung } from "@/components/ChatPanel";
import { listCollections } from "@/lib/collections";
import { missingFor } from "@/lib/env";
import { currentSession } from "@/lib/session";
import { SettingsIncompleteError, resolveSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function ChatSeite() {
  const fehlt = missingFor("chat");
  const session = await currentSession();

  let sammlungen: ChatSammlung[] = [];
  let hinweis: string | null = null;

  if (fehlt.length === 0 && session) {
    // Modell und API-Key kommen aus den Admin-Einstellungen, nicht aus der
    // Umgebung — deshalb wird hier nachgesehen, ob der Chat antworten kann.
    const [einstellungen, eigene] = await Promise.allSettled([
      resolveSettings(),
      listCollections(session.userId),
    ]);

    if (einstellungen.status === "rejected") {
      const grund = einstellungen.reason;
      hinweis =
        grund instanceof SettingsIncompleteError
          ? session.role === "admin"
            ? grund.message
            : "Der Administrator hat noch kein Modell eingerichtet. Bitte spaeter erneut versuchen."
          : grund instanceof Error
            ? grund.message
            : "Die Einstellungen konnten nicht geladen werden.";
    }

    if (eigene.status === "fulfilled") {
      sammlungen = eigene.value.map(({ id, name }) => ({ id, name }));
    } else {
      hinweis ??= eigene.reason instanceof Error ? eigene.reason.message : "Die Sammlungen konnten nicht geladen werden.";
    }
  }

  return (
    <>
      {fehlt.length > 0 && (
        <div className="meldung">
          <b>Der Assistent ist noch nicht einsatzbereit.</b> Es fehlen folgende
          Environment-Variablen: <code>{fehlt.join(", ")}</code>. Sie werden im
          Vercel-Projekt unter <i>Settings &rarr; Environment Variables</i> hinterlegt;
          danach ist ein erneutes Deployment noetig.
        </div>
      )}
      {hinweis && (
        <div className="meldung">
          <b>Der Assistent ist noch nicht einsatzbereit.</b> {hinweis}
        </div>
      )}
      <ChatPanel sammlungen={sammlungen} />
    </>
  );
}
