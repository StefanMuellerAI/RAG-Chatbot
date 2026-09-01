import CollectionsPanel from "@/components/CollectionsPanel";
import DocumentsPanel from "@/components/DocumentsPanel";
import { listCollections } from "@/lib/collections";
import { listDocuments, type DocumentRecord } from "@/lib/documents";
import { missingFor } from "@/lib/env";
import { currentSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SammlungenSeite({
  searchParams,
}: {
  searchParams: Promise<{ sammlung?: string }>;
}) {
  const fehlt = missingFor("admin");
  const session = await currentSession();
  const { sammlung: gewaehlt } = await searchParams;

  let sammlungen: Awaited<ReturnType<typeof listCollections>> = [];
  let dokumente: DocumentRecord[] = [];
  let fehler: string | null = null;

  if (fehlt.length === 0 && session) {
    try {
      sammlungen = await listCollections(session.userId);
    } catch (error) {
      fehler = error instanceof Error ? error.message : "Die Sammlungen konnten nicht geladen werden.";
    }
  }

  // Die Auswahl kommt aus der URL — sie muss zu den eigenen Sammlungen gehoeren,
  // sonst wird schlicht die erste gezeigt.
  const aktive = sammlungen.find((sammlung) => sammlung.id === gewaehlt) ?? sammlungen[0] ?? null;

  if (aktive) {
    try {
      dokumente = await listDocuments(aktive.id);
    } catch (error) {
      fehler = error instanceof Error ? error.message : "Die Dokumente konnten nicht geladen werden.";
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
      {fehler && <div className="meldung">{fehler}</div>}

      <CollectionsPanel
        sammlungen={sammlungen.map(({ id, name, createdAt }) => ({ id, name, createdAt }))}
        aktiveId={aktive?.id ?? null}
      />

      {aktive && (
        <DocumentsPanel
          key={aktive.id}
          collectionId={aktive.id}
          collectionName={aktive.name}
          dokumente={dokumente}
        />
      )}
    </>
  );
}
