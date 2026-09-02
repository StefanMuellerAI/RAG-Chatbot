import { clerkClient } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { plans } from "./db/schema";
import { NotFoundError, ValidationError } from "./errors";
import { ausZwischenspeicher, verwirfZwischenspeicher } from "./ratelimit";

/**
 * Nutzer per Einladung in die App holen.
 *
 * Die Einladung selbst lebt bei Clerk: Clerk verschickt die E-Mail, haelt den
 * Status (offen, angenommen, widerrufen) und nimmt beim Registrieren den
 * Einladungslink entgegen. Diese Datei ist die duenne Schicht darueber —
 * Eingaben pruefen, den Plan mitgeben, Clerk-Fehler in Meldungen uebersetzen,
 * die ein Admin versteht.
 *
 * Der Plan reist als `publicMetadata.planId` mit der Einladung. Clerk kopiert
 * die Metadaten der Einladung beim Registrieren in `public_metadata` des neuen
 * Nutzers, und der Webhook (`user.created`) liest sie von dort. Es gibt also
 * keine zweite Tabelle, die mit Clerk abgeglichen werden muesste.
 *
 * Alle Funktionen setzen voraus, dass die Rolle bereits geprueft wurde
 * (requireAdmin in der jeweiligen Route).
 */

/** Wie lange ein Einladungslink gilt. Kuerzer als Clerks Vorgabe von 30 Tagen. */
export const EINLADUNG_GUELTIG_TAGE = 14;

/** Hoechstens so viele offene Einladungen zeigt die Liste. */
const LISTEN_OBERGRENZE = 100;

/**
 * Die Liste kommt von der Clerk-API und ist der langsamste Teil der Admin-
 * Seite. Eine Minute Zwischenspeicher reicht: Aendert der Admin selbst etwas,
 * wird der Eintrag verworfen; was andere in Clerk direkt tun, erscheint mit
 * hoechstens einer Minute Verzoegerung.
 */
const EINLADUNGEN_SCHLUESSEL = "wa:einladungen";
const EINLADUNGEN_LEBENSDAUER_SEKUNDEN = 60;

const EMAIL_MAX_ZEICHEN = 254;
// Bewusst grob: genau eine @, keine Leerzeichen, ein Punkt in der Domain. Die
// eigentliche Pruefung macht Clerk beim Anlegen; hier geht es darum, Tippfehler
// abzufangen, bevor sie zu einer verschickten Mail werden.
const EMAIL_MUSTER = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Einladung = {
  id: string;
  email: string;
  /** ISO-Zeitpunkte — die Karte bekommt sie serialisiert. */
  createdAt: string;
  expiresAt: string;
  /** Der Link aus der E-Mail. Fuer den Fall, dass die Mail nicht ankommt. */
  url: string | null;
  /** Plan aus den Metadaten der Einladung; null, wenn keiner hinterlegt ist. */
  planId: string | null;
};

export type EinladungEingabe = {
  email: unknown;
  /** Leer oder fehlend: der Standardplan. */
  planId?: unknown;
  /** Basis der App, z. B. https://wissen.example.de — daraus wird der Sign-up-Link. */
  appUrl: string;
};

// --- Lesen ------------------------------------------------------------------

/** Offene Einladungen, neueste zuerst. */
export async function ladeEinladungen(): Promise<Einladung[]> {
  return ausZwischenspeicher(EINLADUNGEN_SCHLUESSEL, EINLADUNGEN_LEBENSDAUER_SEKUNDEN, async () => {
    const client = await clerkClient();
    const { data } = await client.invitations.getInvitationList({
      status: "pending",
      orderBy: "-created_at",
      limit: LISTEN_OBERGRENZE,
    });
    return data.map(zuEinladung);
  });
}

// --- Anlegen ----------------------------------------------------------------

export async function erstelleEinladung(eingabe: EinladungEingabe): Promise<Einladung> {
  const email = pruefeEmail(eingabe.email);
  const planId = await pruefePlan(eingabe.planId);
  const basis = pruefeAppUrl(eingabe.appUrl);

  const client = await clerkClient();

  try {
    const einladung = await client.invitations.createInvitation({
      emailAddress: email,
      redirectUrl: `${basis}/sign-up`,
      expiresInDays: EINLADUNG_GUELTIG_TAGE,
      publicMetadata: { planId },
      notify: true,
    });
    await verwirfZwischenspeicher(EINLADUNGEN_SCHLUESSEL);
    return zuEinladung(einladung);
  } catch (error) {
    throw uebersetzeClerkFehler(error, email);
  }
}

/** Prueft eine E-Mail-Adresse und liefert sie normalisiert (getrimmt, klein) zurueck. */
export function pruefeEmail(wert: unknown): string {
  const email = typeof wert === "string" ? wert.trim().toLowerCase() : "";

  if (!email) throw new ValidationError("Bitte eine E-Mail-Adresse angeben.");
  if (email.length > EMAIL_MAX_ZEICHEN || !EMAIL_MUSTER.test(email)) {
    throw new ValidationError(`"${email}" ist keine gueltige E-Mail-Adresse.`);
  }

  return email;
}

/**
 * Liefert die Kennung des Plans, den der neue Nutzer bekommen soll.
 *
 * Ein Tippfehler in der Kennung wuerde sonst erst im Webhook auffallen — und
 * dort still auf den Standardplan fallen, ohne dass der Admin es je erfaehrt.
 */
async function pruefePlan(wert: unknown): Promise<string> {
  const gewuenscht = typeof wert === "string" ? wert.trim() : "";
  const vorhanden = await getDb()
    .select({ id: plans.id, isDefault: plans.isDefault })
    .from(plans);

  if (!gewuenscht) {
    const standard = vorhanden.find((plan) => plan.isDefault);
    if (!standard) {
      throw new ValidationError(
        "Es ist kein Standardplan hinterlegt. Bitte einen Plan waehlen oder im Abschnitt Plaene einen als Standard markieren.",
      );
    }
    return standard.id;
  }

  if (!vorhanden.some((plan) => plan.id === gewuenscht)) {
    throw new ValidationError(`Der Plan "${gewuenscht}" existiert nicht.`);
  }
  return gewuenscht;
}

function pruefeAppUrl(wert: string): string {
  let url: URL;
  try {
    url = new URL(wert);
  } catch {
    throw new ValidationError("Die Adresse der Anwendung konnte nicht bestimmt werden.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ValidationError("Die Adresse der Anwendung konnte nicht bestimmt werden.");
  }
  return url.origin;
}

// --- Widerrufen -------------------------------------------------------------

export async function widerrufeEinladung(id: unknown): Promise<void> {
  const kennung = typeof id === "string" ? id.trim() : "";
  if (!kennung) throw new ValidationError("Es wurde keine Einladung angegeben.");

  const client = await clerkClient();
  try {
    await client.invitations.revokeInvitation(kennung);
  } catch (error) {
    throw uebersetzeClerkFehler(error);
  }
  await verwirfZwischenspeicher(EINLADUNGEN_SCHLUESSEL);
}

// --- Plan aus der Einladung -------------------------------------------------

/**
 * Der Plan, den eine angenommene Einladung vorgibt — oder null.
 *
 * Liest `planId` aus den oeffentlichen Metadaten eines Clerk-Nutzers und prueft,
 * ob der Plan noch existiert. Er kann zwischen Einladung und Registrierung
 * geloescht worden sein; dann gilt wieder der Standardplan. Wird vom Webhook
 * und vom Fallback in lib/auth/user.ts genutzt, damit beide Wege zum selben
 * Ergebnis kommen.
 */
export async function planAusEinladung(metadaten: unknown): Promise<string | null> {
  if (!metadaten || typeof metadaten !== "object") return null;

  const planId = (metadaten as { planId?: unknown }).planId;
  if (typeof planId !== "string" || !planId.trim()) return null;

  const plan = await getDb().query.plans.findFirst({
    columns: { id: true },
    where: eq(plans.id, planId.trim()),
  });
  return plan?.id ?? null;
}

// --- Abbildung --------------------------------------------------------------

/** Die Felder der Clerk-Ressource, die hier gebraucht werden. */
type ClerkEinladung = {
  id: string;
  emailAddress: string;
  publicMetadata: Record<string, unknown> | null;
  createdAt: number;
  url?: string;
  /** Die Ressource fuehrt `expires_at` nicht als Feld, das Rohobjekt aus der API schon. */
  raw?: { id: string; expires_at?: number | null } | null;
};

export function zuEinladung(einladung: ClerkEinladung): Einladung {
  const planId = einladung.publicMetadata?.planId;
  const ablauf =
    einladung.raw?.expires_at ??
    einladung.createdAt + EINLADUNG_GUELTIG_TAGE * 24 * 60 * 60 * 1000;

  return {
    id: einladung.id,
    email: einladung.emailAddress,
    createdAt: new Date(einladung.createdAt).toISOString(),
    expiresAt: new Date(ablauf).toISOString(),
    url: einladung.url ?? null,
    planId: typeof planId === "string" && planId ? planId : null,
  };
}

// --- Clerk-Fehler -----------------------------------------------------------

/**
 * Gestalt eines `ClerkAPIResponseError` aus @clerk/backend. Absichtlich ohne
 * Import der Klasse: geprueft wird die Form, nicht die Herkunft — das macht
 * die Uebersetzung auch fuer Tests mit nachgebauten Fehlern verlaesslich.
 */
type ClerkApiFehler = {
  status: number;
  errors: { code: string; message?: string; longMessage?: string }[];
};

function istClerkApiFehler(error: unknown): error is ClerkApiFehler {
  if (!error || typeof error !== "object") return false;
  const kandidat = error as Partial<ClerkApiFehler>;
  return typeof kandidat.status === "number" && Array.isArray(kandidat.errors);
}

/**
 * Uebersetzt die Antwort der Clerk-API in eine Meldung fuer den Admin.
 *
 * Die Codes, die beim Einladen vorkommen:
 *   duplicate_record          es liegt schon eine offene Einladung vor
 *   form_identifier_exists    fuer die Adresse gibt es bereits ein Konto
 *   form_param_format_invalid Clerk haelt die Adresse fuer ungueltig
 *   resource_not_found        die Einladung gibt es nicht (Widerrufen)
 *
 * Alles andere mit Status 4xx wird mit Clerks eigener Meldung weitergegeben;
 * 5xx und unbekannte Fehler bleiben, was sie sind — die Route antwortet dann
 * mit 500 und der Fehler landet im Log.
 */
export function uebersetzeClerkFehler(error: unknown, email?: string): Error {
  if (!istClerkApiFehler(error)) {
    return error instanceof Error ? error : new Error("Unbekannter Fehler bei Clerk.");
  }

  const codes = new Set(error.errors.map((fehler) => fehler.code));
  const wer = email ? `"${email}"` : "diese E-Mail-Adresse";

  if (codes.has("duplicate_record")) {
    return new ValidationError(
      `Fuer ${wer} liegt bereits eine offene Einladung vor. Sie steht in der Liste und laesst sich dort widerrufen, falls sie neu verschickt werden soll.`,
    );
  }
  if (codes.has("form_identifier_exists")) {
    return new ValidationError(
      `Fuer ${wer} gibt es bereits ein Konto. Eine Einladung ist nicht noetig — der Plan laesst sich in der Nutzerliste zuweisen.`,
    );
  }
  if (codes.has("form_param_format_invalid")) {
    return new ValidationError(`Clerk akzeptiert ${wer} nicht als E-Mail-Adresse.`);
  }
  if (codes.has("resource_not_found") || error.status === 404) {
    return new NotFoundError("Die Einladung");
  }

  if (error.status >= 400 && error.status < 500) {
    const meldung = error.errors
      .map((fehler) => fehler.longMessage ?? fehler.message)
      .filter(Boolean)
      .join(" ");
    return new ValidationError(meldung ? `Clerk hat die Anfrage abgelehnt: ${meldung}` : "Clerk hat die Anfrage abgelehnt.");
  }

  return error instanceof Error ? error : new Error("Unbekannter Fehler bei Clerk.");
}
