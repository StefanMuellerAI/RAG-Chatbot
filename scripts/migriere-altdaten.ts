import { get, list } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { chunkBlocks } from "../lib/chunk";
import { getDb } from "../lib/db";
import { collections, sizeClasses, users } from "../lib/db/schema";
import {
  blobPfad,
  legeDokumentAn,
  schliesseDokumentAb,
  schreibeDatei,
} from "../lib/documents";
import { extractBlocks } from "../lib/extract";
import { findPreset } from "../lib/presets";
import { upsertChunks } from "../lib/vector";

/**
 * Uebernimmt den Bestand der Einzelnutzer-Fassung in eine Sammlung.
 *
 *   npx dotenv -e .env.local -- tsx scripts/migriere-altdaten.ts <clerk-user-id> [groessenklasse]
 *
 * Vorher lagen die Metadaten als JSON-Blobs unter documents/<id>.json und die
 * Dateien unter files/<uuid>/<name>. Beides passt nicht in die neue Struktur:
 * Die Metadaten gehoeren in die Datenbank, und die Pfade muessen
 * mandantenpraefigiert sein, weil die Pruefung bei der Ausgabe des
 * Upload-Tokens daran haengt.
 *
 * Die Vektoren werden neu erzeugt und nicht uebertragen. Sie muessten es auch:
 * Der Bestand lag in einem Upstash-Index mit bge-m3, jetzt ist es Pinecone mit
 * multilingual-e5-large. Vektoren aus verschiedenen Modellen sind nicht
 * vergleichbar - sie zu kopieren ergaebe eine Suche, die zufaellige Treffer
 * liefert.
 *
 * Die alten Blobs bleiben liegen. Sie nach einem halb gelungenen Lauf zu
 * loeschen waere nicht rueckholbar; das Abraeumen ist ein eigener, bewusster
 * Schritt.
 */

type AlterSatz = {
  id: string;
  filename: string;
  size: number;
  contentType: string;
  uploadedAt: string;
  chunkCount: number;
  filePath: string;
};

const META_PREFIX = "documents/";

async function main() {
  const [userId, klasseWunsch = "L"] = process.argv.slice(2);

  if (!userId) {
    throw new Error(
      "Aufruf: tsx scripts/migriere-altdaten.ts <clerk-user-id> [groessenklasse]\n" +
        "Die Clerk-Nutzer-ID steht im Admin-Bereich in der Nutzerliste.",
    );
  }

  const db = getDb();

  const nutzer = await db.query.users.findFirst({
    where: eq(users.clerkUserId, userId),
  });
  if (!nutzer) {
    throw new Error(
      `Der Nutzer "${userId}" existiert nicht in der Datenbank. Er muss sich einmal ` +
        `angemeldet haben, damit seine Zeile angelegt wird.`,
    );
  }

  const klasse = await db.query.sizeClasses.findFirst({
    where: eq(sizeClasses.id, klasseWunsch),
  });
  if (!klasse) throw new Error(`Die Groessenklasse "${klasseWunsch}" existiert nicht.`);

  const altsaetze = await lieseAlteSaetze();
  if (altsaetze.length === 0) {
    console.log("Keine Altdaten unter documents/ gefunden. Nichts zu tun.");
    return;
  }

  console.log(`${altsaetze.length} Dokumente gefunden. Groessenklasse: ${klasse.id}`);

  if (altsaetze.length > klasse.maxDocuments) {
    throw new Error(
      `${altsaetze.length} Dokumente passen nicht in eine Sammlung der Klasse ` +
        `${klasse.id} (${klasse.maxDocuments}). Bitte eine groessere Klasse angeben.`,
    );
  }

  const [sammlung] = await db
    .insert(collections)
    .values({
      userId,
      name: "Uebernommener Bestand",
      description:
        "Aus der Einzelnutzer-Fassung uebernommene Dokumente. Bitte Name und " +
        "Beschreibung anpassen — der Assistent entscheidet daran, wann er hier sucht.",
      descriptionSource: "user",
      preset: "fliesstext",
      sizeClassId: klasse.id,
    })
    .returning();

  console.log(`Sammlung ${sammlung.id} angelegt.`);

  const preset = findPreset("fliesstext");
  let gelungen = 0;
  let gescheitert = 0;

  for (const alt of altsaetze) {
    try {
      console.log(`  ${alt.filename} …`);

      const quelle = await get(alt.filePath, { access: "private" });
      if (!quelle) throw new Error("Originaldatei nicht gefunden.");

      const puffer = await new Response(quelle.stream as ReadableStream).arrayBuffer();

      const docId = crypto.randomUUID();
      const zielpfad = blobPfad(userId, sammlung.id, docId, alt.filename);

      await schreibeDatei(zielpfad, Buffer.from(puffer), alt.contentType);

      const satz = await legeDokumentAn({
        id: docId,
        collectionId: sammlung.id,
        userId,
        filename: alt.filename,
        contentType: alt.contentType,
        blobPath: zielpfad,
        sizeBytes: puffer.byteLength,
      });

      const { bloecke, seiten } = await extractBlocks(
        puffer,
        alt.filename,
        alt.contentType,
      );
      const abschnitte = chunkBlocks(bloecke, preset);

      if (abschnitte.length === 0) {
        throw new Error("Kein Text gewinnbar (vermutlich ein Scan ohne Texterkennung).");
      }

      await upsertChunks(sammlung.id, satz.id, alt.filename, abschnitte);
      await schliesseDokumentAb(satz.id, sammlung.id, seiten, abschnitte.length);

      console.log(`    ${seiten} Seiten, ${abschnitte.length} Abschnitte`);
      gelungen += 1;
    } catch (error) {
      console.error(
        `    fehlgeschlagen: ${error instanceof Error ? error.message : error}`,
      );
      gescheitert += 1;
    }
  }

  console.log(
    `\nFertig. ${gelungen} uebernommen, ${gescheitert} fehlgeschlagen.\n` +
      `Die alten Blobs unter documents/ und files/<uuid>/ liegen unveraendert weiter ` +
      `und koennen nach einer Sichtprobe entfernt werden.`,
  );
}

async function lieseAlteSaetze(): Promise<AlterSatz[]> {
  const saetze: AlterSatz[] = [];
  let cursor: string | undefined;

  do {
    const seite = await list({ prefix: META_PREFIX, cursor, limit: 250 });

    for (const blob of seite.blobs) {
      try {
        const ergebnis = await get(blob.url, { access: "private" });
        if (!ergebnis) continue;

        const satz = JSON.parse(
          await new Response(ergebnis.stream as ReadableStream).text(),
        ) as AlterSatz;

        if (satz.filePath && satz.filename) saetze.push(satz);
      } catch {
        console.warn(`  Metadatensatz ${blob.pathname} unlesbar, wird uebersprungen.`);
      }
    }

    cursor = seite.hasMore ? seite.cursor : undefined;
  } while (cursor);

  return saetze;
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
