import AdminPanel from "@/components/AdminPanel";
import { listDocuments, type DocumentRecord } from "@/lib/documents";
import { missingFor } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function AdminSeite() {
  const fehlt = missingFor("admin");

  // Die Liste wird serverseitig geladen: das spart den Ladezustand beim
  // Aufruf, und nach jeder Aenderung genuegt ein router.refresh().
  let dokumente: DocumentRecord[] = [];
  let ladeFehler: string | null = null;

  if (fehlt.length === 0) {
    try {
      dokumente = await listDocuments();
    } catch (error) {
      ladeFehler =
        error instanceof Error ? error.message : "Die Dokumentenliste konnte nicht geladen werden.";
    }
  }

  return (
    <>
      {fehlt.length > 0 && (
        <div className="meldung">
          <b>Die Dokumentenverwaltung ist noch nicht einsatzbereit.</b> Es fehlen folgende
          Environment-Variablen: <code>{fehlt.join(", ")}</code>.
        </div>
      )}
      <AdminPanel dokumente={dokumente} ladeFehler={ladeFehler} />
    </>
  );
}
