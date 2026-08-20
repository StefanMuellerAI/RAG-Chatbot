import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { requireEnv } from "../env";
import * as schema from "./schema";

/**
 * Zugriff auf Neon Postgres.
 *
 * Die Verbindung wird erst beim ersten Aufruf gebaut, niemals beim Import:
 * `next build` wertet Modulcode auf oberster Ebene aus, und beim allerersten
 * Deployment existiert DATABASE_URL noch nicht. Ein Zugriff auf Modulebene
 * wuerde den Build abbrechen, bevor man Gelegenheit hatte, die Variable zu
 * hinterlegen — dieselbe Ueberlegung wie in lib/env.ts.
 *
 * Bewusst KEIN Proxy-Wrapper um den Client. Bibliotheken, die den Adapter
 * inspizieren (Methoden pruefen, Eigenschaften durchlaufen), brechen daran
 * ohne verwertbare Fehlermeldung.
 *
 * Der HTTP-Treiber haelt keine Verbindung offen. Das passt zu vielen kurzen,
 * gleichzeitigen Funktionsaufrufen und ist der Grund, warum unten alle
 * Zaehleraenderungen als einzelne atomare Statements formuliert sind statt
 * als Transaktion: der HTTP-Treiber kennt keine interaktiven Transaktionen.
 */

type Database = ReturnType<typeof erzeuge>;

function erzeuge() {
  const env = requireEnv("DATABASE_URL");
  return drizzle(neon(env.DATABASE_URL), { schema });
}

let zwischenspeicher: Database | null = null;

export function getDb(): Database {
  zwischenspeicher ??= erzeuge();
  return zwischenspeicher;
}

export { schema };
