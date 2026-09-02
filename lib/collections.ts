import { and, asc, eq } from "drizzle-orm";
import type { Kontext } from "./auth/user";
import {
  isCollectionKind,
  type CollectionKind,
  type CollectionSchema,
} from "./collection-kinds";
import { getDb } from "./db";
import { collections, sizeClasses } from "./db/schema";
import type { Collection, PresetId, SizeClass } from "./db/schema";
import { loescheUnterPraefix, sammlungsPraefix } from "./documents";
import { graphConfigured } from "./env";
import { NotFoundError, ValidationError } from "./errors";
import { deleteGraph } from "./graphstore";
import { STANDARD_PRESET, isPresetId } from "./presets";
import {
  pruefeGroessenklasse,
  pruefeNeueSammlung,
  pruefeSammlungsText,
} from "./quota";
import { loescheSammlung as loescheSammlungVektoren } from "./vector";

/**
 * Sammlungen eines Nutzers.
 *
 * Jede Funktion hier fuehrt die Nutzer-ID in der Abfrage mit. Das ist die
 * einzige Stelle, an der die Mandantentrennung durchgesetzt wird — es gibt
 * bewusst keine Funktion, die eine Sammlung nur anhand ihrer ID liefert, denn
 * genau die wuerde irgendwann versehentlich ohne Pruefung aufgerufen.
 */

export type SammlungMitKlasse = Collection & { sizeClass: SizeClass };

export async function ladeSammlungen(userId: string): Promise<SammlungMitKlasse[]> {
  const zeilen = await getDb()
    .select({ sammlung: collections, sizeClass: sizeClasses })
    .from(collections)
    .innerJoin(sizeClasses, eq(collections.sizeClassId, sizeClasses.id))
    .where(eq(collections.userId, userId))
    .orderBy(asc(collections.name));

  return zeilen.map((zeile) => ({ ...zeile.sammlung, sizeClass: zeile.sizeClass }));
}

export async function ladeSammlung(
  userId: string,
  collectionId: string,
): Promise<SammlungMitKlasse> {
  const [zeile] = await getDb()
    .select({ sammlung: collections, sizeClass: sizeClasses })
    .from(collections)
    .innerJoin(sizeClasses, eq(collections.sizeClassId, sizeClasses.id))
    .where(and(eq(collections.id, collectionId), eq(collections.userId, userId)))
    .limit(1);

  if (!zeile) throw new NotFoundError("Die Sammlung");
  return { ...zeile.sammlung, sizeClass: zeile.sizeClass };
}

/**
 * Mehrere Sammlungen auf einmal, gefiltert auf die des Nutzers.
 *
 * Herzstueck der Absicherung des Tool-Aufrufs: Das Modell nennt Sammlungs-IDs,
 * und hier fallen alle heraus, die dem Aufrufer nicht gehoeren. Halluziniert
 * das Modell eine ID oder wird es per Prompt-Injection zu einer fremden
 * verleitet, kommt sie hier nicht durch.
 */
export async function ladeEigeneSammlungen(
  userId: string,
  ids: string[],
): Promise<SammlungMitKlasse[]> {
  if (ids.length === 0) return [];

  const eigene = await ladeSammlungen(userId);
  const gesucht = new Set(ids);
  return eigene.filter((sammlung) => gesucht.has(sammlung.id));
}

export type SammlungEingabe = {
  name: unknown;
  beschreibung: unknown;
  preset: unknown;
  sizeClassId: unknown;
  /** Sammlungstyp; fehlt er, entsteht eine Dokumentensammlung. */
  kind?: unknown;
};

/**
 * Prueft den gewuenschten Sammlungstyp.
 *
 * Graph-Sammlungen gibt es nur, wenn FalkorDB angebunden ist. Ohne die
 * Pruefung hier entstuende eine Sammlung, in die sich nichts einspielen laesst
 * — und der Fehler kaeme erst beim ersten Upload, weit weg von seiner Ursache.
 */
function pruefeSammlungstyp(wert: unknown): CollectionKind {
  if (wert === undefined || wert === null || wert === "") return "vector";

  if (!isCollectionKind(wert)) {
    throw new ValidationError(
      "Bitte eine Art der Sammlung waehlen: Dokumente, Tabellen oder Graph.",
    );
  }

  if (wert === "graph" && !graphConfigured()) {
    throw new ValidationError(
      "Graph-Sammlungen sind auf dieser Instanz nicht verfuegbar: FALKORDB_URL ist nicht gesetzt.",
    );
  }

  return wert;
}

export async function erstelleSammlung(
  kontext: Kontext,
  eingabe: SammlungEingabe,
): Promise<Collection> {
  const { name, beschreibung } = pruefeSammlungsText(eingabe.name, eingabe.beschreibung);
  const kind = pruefeSammlungstyp(eingabe.kind);

  // Das Preset steuert nur das Zerlegen von Text und hat fuer Tabellen und
  // Graphen keine Bedeutung. Die Spalte ist Pflicht; damit weder eine
  // Migration noch ein Sonderfall in findPreset noetig wird, bekommen diese
  // Sammlungen serverseitig den Standardwert.
  let preset: PresetId;
  if (kind === "vector") {
    if (!isPresetId(eingabe.preset)) {
      throw new ValidationError(
        "Bitte eine der drei Verarbeitungsarten waehlen: Fliesstext, Tabellen und Zahlen oder Regelwerke.",
      );
    }
    preset = eingabe.preset;
  } else {
    preset = STANDARD_PRESET;
  }

  const klasse = await ladeGroessenklasse(String(eingabe.sizeClassId ?? ""));

  // Beide Kontingentpruefungen VOR dem Anlegen: die Anzahl der Sammlungen
  // gegen den Plan und die gewuenschte Groessenklasse gegen die hoechste, die
  // der Plan freischaltet.
  await pruefeNeueSammlung(kontext);
  pruefeGroessenklasse(kontext, klasse);

  const [angelegt] = await getDb()
    .insert(collections)
    .values({
      userId: kontext.userId,
      name,
      description: beschreibung,
      descriptionSource: beschreibung ? "user" : "auto",
      preset,
      kind,
      sizeClassId: klasse.id,
    })
    .returning();

  return angelegt;
}

export async function aktualisiereSammlung(
  userId: string,
  collectionId: string,
  eingabe: { name: unknown; beschreibung: unknown },
): Promise<void> {
  // Wirft, wenn die Sammlung nicht dem Nutzer gehoert.
  await ladeSammlung(userId, collectionId);

  const { name, beschreibung } = pruefeSammlungsText(eingabe.name, eingabe.beschreibung);

  await getDb()
    .update(collections)
    .set({
      name,
      description: beschreibung,
      // Eine von Hand eingetragene Beschreibung darf der automatische
      // Vorschlag spaeter nicht mehr ueberschreiben.
      descriptionSource: "user",
      updatedAt: new Date(),
    })
    .where(and(eq(collections.id, collectionId), eq(collections.userId, userId)));
}

/**
 * Loescht eine Sammlung mit allem, was daran haengt.
 *
 * Reihenfolge: erst die Vektoren bzw. der Graph, dann die Dateien, zuletzt
 * die Zeile. Bricht es zwischendurch ab, bleibt die Zeile stehen und der
 * Vorgang ist wiederholbar. Umgekehrt waeren Vektoren und Dateien verwaist und
 * ueber die Oberflaeche nicht mehr erreichbar.
 *
 * Die SQLite-Datei einer Tabellen-Sammlung liegt unter
 * files/<userId>/<collectionId>/_db/ und geht mit dem Praefix mit — sie
 * braucht keinen eigenen Schritt.
 */
export async function loescheSammlung(userId: string, collectionId: string): Promise<void> {
  const sammlung = await ladeSammlung(userId, collectionId);

  if (sammlung.kind === "graph") {
    // Einen nie beschriebenen Graphen toleriert deleteGraph von selbst.
    await deleteGraph(collectionId);
  } else if (sammlung.kind === "vector") {
    await loescheSammlungVektoren(collectionId);
  }

  await loescheUnterPraefix(sammlungsPraefix(userId, collectionId));

  // Die Dokumentzeilen gehen per ON DELETE CASCADE mit.
  await getDb()
    .delete(collections)
    .where(and(eq(collections.id, collectionId), eq(collections.userId, userId)));
}

/**
 * Traegt eine automatisch erzeugte Beschreibung nach.
 *
 * Nur wenn der Nutzer keine eigene hinterlegt hat. Die Beschreibung ist die
 * Grundlage, auf der das Modell spaeter entscheidet, ob diese Sammlung zur
 * Frage passt — eine leere Beschreibung macht die Sammlung praktisch unsichtbar.
 */
export async function setzeAutoBeschreibung(
  collectionId: string,
  beschreibung: string,
): Promise<void> {
  const sauber = beschreibung.replace(/\s+/g, " ").trim().slice(0, 400);
  if (!sauber) return;

  await getDb()
    .update(collections)
    .set({ description: sauber, descriptionSource: "auto", updatedAt: new Date() })
    .where(
      and(eq(collections.id, collectionId), eq(collections.descriptionSource, "auto")),
    );
}

/**
 * Haelt die Struktur einer Tabellen- oder Graph-Sammlung fest.
 *
 * Das Schema ist, was das Modell im Chat sieht, um SQL oder Cypher zu
 * formulieren. Es wird nach jeder Ingestion und jedem Loeschen neu bestimmt;
 * `null` bedeutet: nichts mehr drin.
 */
export async function setzeSammlungsSchema(
  userId: string,
  collectionId: string,
  schema: CollectionSchema | null,
): Promise<void> {
  await getDb()
    .update(collections)
    .set({ schema, updatedAt: new Date() })
    .where(and(eq(collections.id, collectionId), eq(collections.userId, userId)));
}

async function ladeGroessenklasse(id: string): Promise<SizeClass> {
  const klasse = await getDb().query.sizeClasses.findFirst({
    where: eq(sizeClasses.id, id),
  });

  if (!klasse) {
    throw new ValidationError(
      id
        ? `Die Groessenklasse "${id}" existiert nicht.`
        : "Bitte eine Groessenklasse waehlen.",
    );
  }

  return klasse;
}

/** Alle Groessenklassen, die der Plan des Nutzers freischaltet. */
export async function erlaubteGroessenklassen(kontext: Kontext): Promise<SizeClass[]> {
  const alle = await getDb().select().from(sizeClasses).orderBy(asc(sizeClasses.rank));
  return alle.filter((klasse) => klasse.rank <= kontext.maxSizeClass.rank);
}
