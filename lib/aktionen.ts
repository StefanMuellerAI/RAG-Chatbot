import { refresh } from "next/cache";
import { beschreibeFehler, protokolliere } from "./api";

/**
 * Gemeinsamer Rahmen fuer Server Actions.
 *
 * Eine Action ersetzt das Paar "fetch gegen die API-Route, danach
 * router.refresh()": Sie fuehrt die Mutation aus und laesst Next die aktuelle
 * Route im selben Roundtrip neu rendern (`refresh` aus next/cache). Der Client
 * bekommt Ergebnis und frisches RSC-Payload in einer Antwort.
 *
 * Fehler werden als Wert zurueckgegeben, nicht geworfen: Eine Exception aus
 * einer Action kommt im Produktionsbetrieb nur als anonyme Meldung beim
 * Client an. Die Zuordnung zu Meldung und Code teilt sich die Datei mit den
 * API-Routen (lib/api.ts), damit beide Wege dasselbe sagen.
 *
 * Diese Datei traegt bewusst kein "use server": Sie ist eine Hilfsfunktion,
 * die von den Action-Dateien importiert wird, kein Einstiegspunkt.
 */

export type AktionsErgebnis<T = undefined> =
  | { ok: true; daten: T }
  | { ok: false; fehler: string; code: string };

type Optionen = {
  /** Fuer das strukturierte Log von Abweisungen (429/409). */
  userId?: string;
  /**
   * Standard true: Route nach Erfolg neu rendern. false fuer Actions, deren
   * Ergebnis der Client selbst einarbeitet und die keine Server-Daten aendern,
   * die auf der Seite zu sehen sind.
   */
  neuRendern?: boolean;
};

export async function alsAktion<T>(
  arbeit: () => Promise<T>,
  optionen: Optionen = {},
): Promise<AktionsErgebnis<T>> {
  try {
    const daten = await arbeit();
    if (optionen.neuRendern !== false) refresh();
    return { ok: true, daten };
  } catch (error) {
    const bild = beschreibeFehler(error);
    protokolliere(bild, error, "einer Server Action", optionen.userId);
    return { ok: false, fehler: bild.body.error, code: bild.body.code };
  }
}
