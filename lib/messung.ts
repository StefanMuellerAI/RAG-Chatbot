/**
 * Leichte Zeitmessung fuer Seiten und Server Actions.
 *
 * Ein strukturiertes Log je Aufruf, im selben Stil wie `chat_run`: Phasen in
 * Millisekunden, Gesamtdauer, keine Inhalte. In der Vercel-Observability laesst
 * sich nach `event` filtern. Damit lassen sich Aenderungen am Frageweg und an
 * den Seiten vorher und nachher vergleichen, statt nach Gefuehl zu urteilen.
 *
 * Bewusst kein Server-Timing-Header: Serverkomponenten koennen keine
 * Antwortkopfzeilen setzen, das Log ist der Ort, an dem die Zahlen ohnehin
 * ausgewertet werden.
 */
export type Messung = {
  /** Schliesst die laufende Phase ab und beginnt die naechste. */
  phase(name: string): void;
  /** Schreibt das Log; weitere Felder kommen mit hinein. */
  ende(zusatz?: Record<string, unknown>): void;
};

export function starteMessung(event: string, felder: Record<string, unknown> = {}): Messung {
  const start = Date.now();
  let letzte = start;
  const phasen: Record<string, number> = {};
  return {
    phase(name) {
      const jetzt = Date.now();
      phasen[name] = (phasen[name] ?? 0) + (jetzt - letzte);
      letzte = jetzt;
    },
    ende(zusatz = {}) {
      console.log(
        JSON.stringify({ event, ...felder, phasen, gesamtMs: Date.now() - start, ...zusatz }),
      );
    },
  };
}
