import { ANBIETER_LABEL, zerlegeKennung, type Anbieter, type KeyAnbieter } from "./models";

/**
 * Modell-Listen direkt vom Anbieter und Preise aus dem oeffentlichen
 * Gateway-Katalog.
 *
 * Eine fest einprogrammierte Liste waere nach wenigen Monaten veraltet — der
 * Admin soll sehen, was sein Konto tatsaechlich freigeschaltet hat. Die Preise
 * kommen aus `GET https://ai-gateway.vercel.sh/v1/models`, damit er sie nicht
 * abtippen muss; er kann sie im Katalog trotzdem aendern.
 *
 * Format des Gateway-Katalogs (geprueft gegen die Antwort vom 2. 9. 2026):
 * `{ object: "list", data: [{ id: "anthropic/claude-sonnet-4.5", name, type:
 * "language" | "embedding" | …, pricing: { input: "0.000003", output:
 * "0.000015", input_cache_read?: "0.0000003", … } }] }` — Betraege in
 * US-Dollar JE TOKEN als Zeichenketten. Je 1 Mio. Token also mal 1.000.000.
 */

/** Ein Modell, wie es der Admin zur Aufnahme in den Katalog angeboten bekommt. */
export type VerfuegbaresModell = {
  /** Katalogkennung "<praefix>/<native-id>". */
  id: string;
  provider: Anbieter;
  label: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  /** false, wenn der Gateway-Katalog keinen Preis kannte — dann stehen Nullen. */
  preisGefunden: boolean;
};

export type Preis = {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
};

const GATEWAY_KATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";

/** Modelle, die im OpenAI-Katalog stehen, aber keinen Chat fuehren koennen. */
const OPENAI_AUSSCHLUSS =
  /realtime|audio|tts|transcribe|whisper|image|dall-e|embedding|search|moderation|instruct|babbage|davinci|computer-use|sora|codex/i;

// --- Preisumrechnung ----------------------------------------------------------

/**
 * "0.0000001" (US-Dollar je Token) → 0.1 (US-Dollar je 1 Mio. Token).
 * Gerundet auf sechs Stellen: 1e-7 * 1e6 ergibt in Gleitkommaarithmetik
 * 0.09999999999999999, und das soll im Formular nicht so stehen.
 */
export function preisJeMillion(jeToken: string | number | undefined): number | undefined {
  if (jeToken === undefined || jeToken === null) return undefined;
  const wert = typeof jeToken === "number" ? jeToken : Number(jeToken);
  if (!Number.isFinite(wert) || wert < 0) return undefined;
  return Math.round(wert * 1_000_000 * 1_000_000) / 1_000_000;
}

type GatewayPricing = {
  input?: string | number;
  output?: string | number;
  input_cache_read?: string | number;
};

/** Preis aus einem Gateway-Eintrag; Cache-Lesen faellt auf ein Zehntel der Eingabe zurueck. */
export function preisAusGateway(pricing: GatewayPricing | undefined): Preis | undefined {
  const input = preisJeMillion(pricing?.input);
  const output = preisJeMillion(pricing?.output);
  if (input === undefined || output === undefined) return undefined;

  const cache = preisJeMillion(pricing?.input_cache_read);
  return {
    inputPerMillion: input,
    outputPerMillion: output,
    cacheReadPerMillion: cache ?? Math.round(input * 100_000) / 1_000_000,
  };
}

// --- Kennungen tolerant vergleichen -----------------------------------------

/**
 * Normalform einer nativen Kennung fuer den Vergleich mit dem Gateway-Katalog.
 *
 * Anthropic liefert "claude-sonnet-4-5-20250929", das Gateway fuehrt
 * "claude-sonnet-4.5"; OpenAI liefert "gpt-5-mini-2025-08-07", das Gateway
 * "gpt-5-mini". Klein, Punkte zu Bindestrichen, Datumsanhaenge weg, "-latest" weg.
 */
export function normalisiereKennung(nativeId: string): string {
  return nativeId
    .toLowerCase()
    .replace(/\./g, "-")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "")
    .replace(/-+$/, "");
}

export type GatewayEintrag = { id: string; name?: string; type?: string; pricing?: GatewayPricing };

/**
 * Sucht im Gateway-Katalog den Preis zu einer nativen Kennung eines Anbieters.
 * Erst exakt, dann tolerant (Punkt/Bindestrich, Datumsanhang).
 */
export function ordnePreisZu(
  praefix: string,
  nativeId: string,
  katalog: readonly GatewayEintrag[],
): Preis | undefined {
  const gesucht = normalisiereKennung(nativeId);

  const treffer =
    katalog.find((eintrag) => eintrag.id === `${praefix}/${nativeId}`) ??
    katalog.find((eintrag) => {
      const teile = zerlegeKennung(eintrag.id);
      return teile.praefix === praefix && normalisiereKennung(teile.nativeId) === gesucht;
    });

  return treffer ? preisAusGateway(treffer.pricing) : undefined;
}

// --- Gateway-Katalog laden --------------------------------------------------

let gatewayKatalog: { eintraege: GatewayEintrag[]; gueltigBis: number } | null = null;
const GATEWAY_LEBENSDAUER_MS = 10 * 60_000;

/**
 * Oeffentlicher Gateway-Katalog, zehn Minuten je Instanz gehalten. Ein Fehler
 * beim Laden liefert eine leere Liste: Dann fehlen Preise, aber die Anbieter-
 * Liste kommt trotzdem an, und der Admin kann sie von Hand ergaenzen.
 */
export async function ladeGatewayKatalog(): Promise<GatewayEintrag[]> {
  if (gatewayKatalog && gatewayKatalog.gueltigBis > Date.now()) return gatewayKatalog.eintraege;

  try {
    const antwort = await fetch(GATEWAY_KATALOG_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!antwort.ok) throw new Error(`Status ${antwort.status}`);
    const body = (await antwort.json()) as { data?: GatewayEintrag[] };
    const eintraege = (body.data ?? []).filter(
      (eintrag) => typeof eintrag?.id === "string" && eintrag.id.includes("/"),
    );
    gatewayKatalog = { eintraege, gueltigBis: Date.now() + GATEWAY_LEBENSDAUER_MS };
    return eintraege;
  } catch (error) {
    console.warn("Gateway-Katalog konnte nicht geladen werden.", error);
    return [];
  }
}

// --- Listen der Anbieter ----------------------------------------------------

type Roheintrag = { nativeId: string; label: string };

async function listeAnthropic(apiKey: string): Promise<Roheintrag[]> {
  const antwort = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await lies<{
    data?: { id: string; display_name?: string; created_at?: string }[];
  }>(antwort, "anthropic");

  return (body.data ?? [])
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .map((modell) => ({ nativeId: modell.id, label: modell.display_name ?? modell.id }));
}

async function listeOpenAI(apiKey: string): Promise<Roheintrag[]> {
  const antwort = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await lies<{ data?: { id: string; created?: number }[] }>(antwort, "openai");

  return (body.data ?? [])
    .filter((modell) => /^(gpt-|o\d)/.test(modell.id) && !OPENAI_AUSSCHLUSS.test(modell.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((modell) => ({ nativeId: modell.id, label: modell.id }));
}

async function lies<T>(antwort: Response, provider: KeyAnbieter): Promise<T> {
  if (antwort.ok) return (await antwort.json()) as T;

  const label = ANBIETER_LABEL[provider];
  if (antwort.status === 401 || antwort.status === 403) {
    throw new Error(`${label} hat den API-Key abgelehnt. Bitte den Key pruefen.`);
  }

  let detail = "";
  try {
    const body = (await antwort.json()) as { error?: { message?: string } | string };
    detail = typeof body.error === "string" ? body.error : (body.error?.message ?? "");
  } catch {
    // Kein JSON — die Statusmeldung reicht.
  }
  throw new Error(`${label} antwortete mit Status ${antwort.status}${detail ? `: ${detail}` : "."}`);
}

/**
 * Modelle eines Key-Anbieters, mit vorbelegten Preisen aus dem Gateway-Katalog.
 * Der Key wird nur fuer diese eine Anfrage verwendet und nirgends abgelegt.
 */
export async function verfuegbareModelleVonAnbieter(
  provider: KeyAnbieter,
  apiKey: string,
): Promise<VerfuegbaresModell[]> {
  const [roh, katalog] = await Promise.all([
    provider === "anthropic" ? listeAnthropic(apiKey) : listeOpenAI(apiKey),
    ladeGatewayKatalog(),
  ]);

  return roh.map((eintrag) => {
    const preis = ordnePreisZu(provider, eintrag.nativeId, katalog);
    return {
      id: `${provider}/${eintrag.nativeId}`,
      provider,
      label: eintrag.label,
      inputPerMillion: preis?.inputPerMillion ?? 0,
      outputPerMillion: preis?.outputPerMillion ?? 0,
      cacheReadPerMillion: preis?.cacheReadPerMillion ?? 0,
      preisGefunden: preis !== undefined,
    };
  });
}

/** Sprachmodelle des Gateway-Katalogs — fuer Modelle ohne eigenen Key. */
export async function verfuegbareModelleVomGateway(): Promise<VerfuegbaresModell[]> {
  const katalog = await ladeGatewayKatalog();

  return katalog
    .filter((eintrag) => (eintrag.type ?? "language") === "language")
    .map((eintrag) => {
      const preis = preisAusGateway(eintrag.pricing);
      return {
        id: eintrag.id,
        provider: "gateway" as const,
        label: eintrag.name?.trim() || zerlegeKennung(eintrag.id).nativeId,
        inputPerMillion: preis?.inputPerMillion ?? 0,
        outputPerMillion: preis?.outputPerMillion ?? 0,
        cacheReadPerMillion: preis?.cacheReadPerMillion ?? 0,
        preisGefunden: preis !== undefined,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
