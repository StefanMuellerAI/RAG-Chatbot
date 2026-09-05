import { tool } from "ai";
import { z } from "zod";
import { KIND_LABEL, type CollectionKind } from "./collection-kinds";
import type { SammlungMitKlasse } from "./collections";
import { fehlerMeldung, RateLimitError, ToolUnavailableError } from "./errors";
import { MissingConfigError } from "./env";
import { runReadOnlyCypher } from "./graphstore";
import { runSql } from "./sql-executor";
import { withCapacity } from "./capacity";
import { erwirbSperre, gibSperreFrei, sperrSchluessel } from "./ratelimit";
import type { ToolName, ToolStep } from "./tools-types";

export type { ToolName, ToolStep } from "./tools-types";

/**
 * Werkzeuge, mit denen das Modell Tabellen- und Graph-Sammlungen befragt.
 *
 * Die Dokumentsuche (`dokumente_durchsuchen`) liegt weiter in lib/ai.ts, weil
 * sie den Fundstellensammler mitfuehrt. Hier stehen die beiden Werkzeuge, die
 * eine Abfrage ausfuehren und deren Ergebnis als Tabelle zurueckkommt.
 *
 * Sicherheitskern wie bei der Suche: Jeder Aufruf prueft die `collectionId`
 * gegen die Allowlist der Sitzung — die Liste ist bereits auf den Nutzer
 * gefiltert (`ladeSammlungen`), und hier faellt zusaetzlich heraus, was nicht
 * vom passenden Typ ist. Eine erfundene oder fremde ID kommt nicht durch.
 * Abgelehnt wird im Base-Stil als Rueckgabewert `{ ok: false, error }`, nicht
 * als Ausnahme: Das Modell soll die Meldung lesen und sich korrigieren koennen.
 */

/** Zeichenbudget fuer ein Werkzeugergebnis im Prompt — grosse Tabellen werden gekuerzt. */
export const ERGEBNIS_MAX_ZEICHEN = 24_000;
const ABFRAGE_MAX_ZEICHEN = 4_000;
/** So viele Zeilen wandern hoechstens als Vorschau in den Browser. */
const VORSCHAU_ZEILEN = 20;

type Abgelehnt = { ok: false; error: string };

type Tabellenergebnis = {
  ok: true;
  collection: string;
  columns: string[];
  rows: unknown[];
  rowCount: number;
  truncated: boolean;
};

/**
 * Kuerzt Zeilen, bis das Ergebnis ins Zeichenbudget passt.
 *
 * Halbieren statt zeilenweise abschneiden: Bei 200 Zeilen mit langen Zellen
 * waeren sonst bis zu 200 Serialisierungen noetig, so sind es hoechstens acht.
 */
export function capRows<T>(rows: T[], maxChars = ERGEBNIS_MAX_ZEICHEN): { rows: T[]; capped: boolean } {
  let ende = rows.length;
  while (ende > 0 && JSON.stringify(rows.slice(0, ende)).length > maxChars) {
    ende = Math.floor(ende / 2);
  }
  return { rows: rows.slice(0, ende), capped: ende < rows.length };
}

/**
 * Im Einzelmodus (genau eine Sammlung in der Allowlist) ist die Sammlung fest
 * gebunden: Das Modell muss keine ID nennen, und eine trotzdem mitgeschickte
 * wird ignoriert. Das Feld bleibt im Schema, nur optional — so haben beide
 * Modi denselben Eingabetyp.
 */
function festeSammlung(sammlungen: SammlungMitKlasse[]): SammlungMitKlasse | undefined {
  return sammlungen.length === 1 ? sammlungen[0] : undefined;
}

function collectionIdSchema(fest: SammlungMitKlasse | undefined) {
  return fest
    ? z.string().optional().describe("Nicht noetig — es gibt genau eine Sammlung.")
    : z.string().describe("ID der Sammlung aus der Liste in der Systemanweisung (Pflicht).");
}

function waehleSammlung(
  sammlungen: SammlungMitKlasse[],
  collectionId: string | undefined,
  kind: CollectionKind,
): { sammlung: SammlungMitKlasse } | { fehler: string } {
  const fest = festeSammlung(sammlungen);
  const sammlung = fest ?? sammlungen.find((eintrag) => eintrag.id === collectionId);

  if (!sammlung) {
    const erlaubt = sammlungen
      .filter((eintrag) => eintrag.kind === kind)
      .map((eintrag) => eintrag.id);
    return {
      fehler:
        `Die Sammlung ${collectionId ?? "(keine ID)"} existiert nicht oder ist nicht zugaenglich. ` +
        (erlaubt.length > 0
          ? `Erlaubte IDs fuer dieses Werkzeug: ${erlaubt.join(", ")}.`
          : `Es gibt keine Sammlung vom Typ ${KIND_LABEL[kind]}.`),
    };
  }

  if (sammlung.kind !== kind) {
    return {
      fehler:
        `Die Sammlung "${sammlung.name}" ist vom Typ ${KIND_LABEL[sammlung.kind]}; ` +
        `dieses Werkzeug braucht eine Sammlung vom Typ ${KIND_LABEL[kind]}.`,
    };
  }

  return { sammlung };
}

/**
 * Werkzeug `sql_ausfuehren`: eine lesende SQL-Abfrage gegen die SQLite-Datei
 * einer Tabellen-Sammlung. Der separate Dienst revalidiert den Blob-Cache
 * und fuehrt die Abfrage in einem terminierbaren Worker aus.
 */
export type ToolOptions = {
  signal?: AbortSignal;
  onStatus?: (phase: "sql" | "graph" | "queued", message: string) => void;
};

export function baueSqlWerkzeug(userId: string, sammlungen: SammlungMitKlasse[], options: ToolOptions = {}) {
  const fest = festeSammlung(sammlungen);

  return tool({
    description:
      "Fuehrt genau eine lesende SQL-Abfrage (SQLite-Dialekt, SELECT oder WITH) gegen " +
      "die Tabellen einer Tabellen-Sammlung aus. Hoechstens 200 Zeilen; aggregiere " +
      "und filtere in SQL, statt viele Zeilen zu lesen.",
    inputSchema: z.object({
      collectionId: collectionIdSchema(fest),
      sql: z
        .string()
        .min(1)
        .max(ABFRAGE_MAX_ZEICHEN)
        .describe("Eine einzelne SELECT-Abfrage ohne Semikolon."),
    }),
    execute: async ({ collectionId, sql }): Promise<Tabellenergebnis | Abgelehnt> => {
      const wahl = waehleSammlung(sammlungen, collectionId, "sql");
      if ("fehler" in wahl) return { ok: false, error: wahl.fehler };

      try {
        options.signal?.throwIfAborted();
        options.onStatus?.("sql", `Tabelle in „${wahl.sammlung.name}“ wird ausgewertet …`);
        const ergebnis = await withCapacity("sql", () => runSql({
          userId, id: wahl.sammlung.id,
          sqlBlobPath: `files/${userId}/${wahl.sammlung.id}/_db/sammlung.sqlite`,
        }, sql, { signal: options.signal }), { signal: options.signal, onWait: () => options.onStatus?.("queued", "Warte auf freie Tabellenkapazitaet …") });
          const { rows, capped } = capRows(ergebnis.rows, 6000);
          return {
            ok: true,
            collection: wahl.sammlung.name,
            columns: ergebnis.columns,
            rows,
            rowCount: ergebnis.rowCount,
            truncated: ergebnis.truncated || capped,
          };
      } catch (error) {
        if (options.signal?.aborted || error instanceof RateLimitError || error instanceof ToolUnavailableError || error instanceof MissingConfigError) throw error;
        return { ok: false, error: fehlerMeldung(error) };
      }
    },
  });
}

/**
 * Werkzeug `cypher_ausfuehren`: eine lesende Cypher-Abfrage gegen den Graphen
 * einer Graph-Sammlung (GRAPH.RO_QUERY — der Server lehnt Schreibzugriffe ab).
 */
export function baueCypherWerkzeug(sammlungen: SammlungMitKlasse[], options: ToolOptions = {}) {
  const fest = festeSammlung(sammlungen);

  return tool({
    description:
      "Fuehrt genau eine lesende Cypher-Abfrage (openCypher, FalkorDB) gegen den Graphen " +
      "einer Graph-Sammlung aus. Hoechstens 200 Zeilen. Referenziere den Beziehungs-Alias " +
      "in RETURN oder WHERE, wenn du Kanten zaehlst.",
    inputSchema: z.object({
      collectionId: collectionIdSchema(fest),
      cypher: z
        .string()
        .min(1)
        .max(ABFRAGE_MAX_ZEICHEN)
        .describe("Eine einzelne MATCH/RETURN-Abfrage ohne Semikolon."),
    }),
    execute: async ({ collectionId, cypher }): Promise<Tabellenergebnis | Abgelehnt> => {
      const wahl = waehleSammlung(sammlungen, collectionId, "graph");
      if ("fehler" in wahl) return { ok: false, error: wahl.fehler };

      try {
        options.signal?.throwIfAborted();
        options.onStatus?.("graph", `Beziehungen in „${wahl.sammlung.name}“ werden ausgewertet …`);
        const ergebnis = await withCapacity("graph", async () => {
          // Rebuilds clear the graph before replaying scripts. A short exclusive
          // collection lock prevents chat answers from using that partial state.
          const key = sperrSchluessel(wahl.sammlung.id);
          const owner = randomUUID();
          const expiresAt = Date.now() + 30_000;
          let acquired: boolean;
          try { acquired = await erwirbSperre(key, owner, 30); }
          catch (error) {
            if (error instanceof MissingConfigError) throw error;
            throw new ToolUnavailableError("Die Graph-Sperre ist derzeit nicht erreichbar. Bitte erneut versuchen.");
          }
          if (!acquired) throw new RateLimitError(5);
          try {
            options.signal?.throwIfAborted();
            // Keep room for FalkorDB's 10-second read timeout after Redis latency.
            if (Date.now() + 15_000 >= expiresAt) throw new RateLimitError(5);
            const result = await runReadOnlyCypher(wahl.sammlung.id, cypher);
            options.signal?.throwIfAborted();
            if (Date.now() >= expiresAt) throw new RateLimitError(5);
            return result;
          } finally { await gibSperreFrei(key, owner); }
        }, {
          signal: options.signal, onWait: () => options.onStatus?.("queued", "Warte auf freie Graphkapazitaet …"),
        });
        options.signal?.throwIfAborted();
        const { rows, capped } = capRows(ergebnis.rows, 6000);
        return {
          ok: true,
          collection: wahl.sammlung.name,
          columns: ergebnis.columns,
          rows,
          rowCount: ergebnis.rowCount,
          truncated: ergebnis.truncated || capped,
        };
      } catch (error) {
        if (options.signal?.aborted || error instanceof RateLimitError || error instanceof ToolUnavailableError || error instanceof MissingConfigError) throw error;
        return { ok: false, error: fehlerMeldung(error) };
      }
    },
  });
}

export function isToolName(wert: unknown): wert is ToolName {
  return (
    wert === "dokumente_durchsuchen" || wert === "sql_ausfuehren" || wert === "cypher_ausfuehren"
  );
}

/**
 * Werkzeugaufruf plus Ergebnis -> Ereignis fuer den Browser.
 *
 * Die Oberflaeche zeigt unter der Antwort, was das Modell abgefragt hat. Fuer
 * SQL und Cypher gehoert eine Vorschau der Zeilen dazu; die Suche meldet nur
 * die Trefferzahl, denn ihre Treffer erscheinen ohnehin als Fundstellen.
 *
 * `sammlungen` ist die Allowlist der Sitzung; sie liefert den Namen zur ID.
 * Im Einzelmodus ist die Sammlung fest gebunden, egal was im Aufruf stand.
 */
export function toStep(
  sammlungen: SammlungMitKlasse[],
  toolName: string,
  input: unknown,
  output: unknown,
  error?: unknown,
): ToolStep | null {
  if (!isToolName(toolName)) return null;

  const eingabe = (input ?? {}) as {
    collectionId?: string;
    collectionIds?: string[];
    suchbegriff?: string;
    sql?: string;
    cypher?: string;
  };
  const ergebnis = (output ?? {}) as {
    ok?: boolean;
    error?: string;
    columns?: string[];
    rows?: unknown[];
    rowCount?: number;
    truncated?: boolean;
    abschnitte?: unknown[];
  };

  // Die Suche nennt mehrere IDs; die Kopfzeile zeigt dann alle Namen.
  const ids =
    toolName === "dokumente_durchsuchen"
      ? (eingabe.collectionIds ?? [])
      : [festeSammlung(sammlungen)?.id ?? eingabe.collectionId ?? ""].filter(Boolean);
  const gefunden = ids
    .map((id) => sammlungen.find((sammlung) => sammlung.id === id))
    .filter((sammlung): sammlung is SammlungMitKlasse => sammlung !== undefined);

  const step: ToolStep = {
    tool: toolName,
    collectionId: ids.join(",") || "?",
    collectionName:
      gefunden.length > 0
        ? gefunden.map((sammlung) => sammlung.name).join(" · ")
        : ids.join(", ") || "unbekannt",
    query: eingabe.suchbegriff ?? eingabe.sql ?? eingabe.cypher ?? "",
  };

  if (error !== undefined) {
    step.error = fehlerMeldung(error);
  } else if (ergebnis.ok === false) {
    step.error = ergebnis.error ?? "Unbekannter Fehler.";
  } else if (toolName === "dokumente_durchsuchen") {
    step.rowCount = ergebnis.abschnitte?.length ?? 0;
  } else {
    step.columns = ergebnis.columns;
    step.rowCount = ergebnis.rowCount;
    step.truncated = ergebnis.truncated;
    step.preview = (ergebnis.rows ?? []).slice(0, VORSCHAU_ZEILEN);
  }

  return step;
}
import { randomUUID } from "node:crypto";
