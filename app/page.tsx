import ChatBereich from "@/components/ChatBereich";
import { missingFor } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function ChatSeite() {
  const fehlt = missingFor("chat");

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
      <ChatBereich />
    </>
  );
}
