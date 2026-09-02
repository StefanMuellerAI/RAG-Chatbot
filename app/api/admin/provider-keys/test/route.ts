import { testeModell } from "@/lib/ai";
import { errorResponse, readJson } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/user";
import { pruefeKennung } from "@/lib/admin";
import { ValidationError } from "@/lib/errors";
import { ladeAktiveModelle } from "@/lib/modellkatalog";
import { ANBIETER_LABEL, istKeyAnbieter, zerlegeKennung } from "@/lib/models";
import { ladeKey, pruefeKeyEingabe } from "@/lib/provider-keys";

export const runtime = "nodejs";

/**
 * Ohne aktives Katalogmodell des Anbieters: ein guenstiges Modell, das der
 * Anbieter unter dieser Kennung sicher kennt.
 */
const TESTMODELL = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5-mini",
} as const;

/**
 * Verbindung testen: ein Mini-Aufruf mit dem eingegebenen (noch nicht
 * gespeicherten) oder dem hinterlegten Key. Der Key aus der Anfrage wird
 * nirgends abgelegt.
 */
export async function POST(request: Request) {
  try {
    await requireAdmin();

    const eingabe = await readJson<{ provider?: unknown; key?: unknown; modelId?: unknown }>(
      request,
    );
    if (!istKeyAnbieter(eingabe.provider)) {
      throw new ValidationError("Unbekannter Anbieter. Zulaessig sind Anthropic und OpenAI.");
    }
    const provider = eingabe.provider;

    const apiKey =
      typeof eingabe.key === "string" && eingabe.key.trim()
        ? pruefeKeyEingabe(eingabe.key)
        : await ladeKey(provider);
    if (!apiKey) {
      throw new ValidationError(
        `Fuer ${ANBIETER_LABEL[provider]} ist kein API-Key hinterlegt. Bitte zuerst einen eingeben.`,
      );
    }

    let nativeId: string;
    if (typeof eingabe.modelId === "string" && eingabe.modelId.trim()) {
      // Volle Katalogkennung oder nur die native Kennung — beides zulaessig.
      const kennung = eingabe.modelId.trim();
      nativeId = kennung.includes("/")
        ? zerlegeKennung(pruefeKennung(kennung)).nativeId
        : kennung;
    } else {
      const aktiv = (await ladeAktiveModelle()).find((modell) => modell.provider === provider);
      nativeId = aktiv ? zerlegeKennung(aktiv.id).nativeId : TESTMODELL[provider];
    }

    const ergebnis = await testeModell({ provider, nativeId, apiKey });
    if (!ergebnis.ok) {
      return Response.json({ ok: false, error: ergebnis.fehler, modelId: nativeId }, { status: 502 });
    }
    return Response.json({ ok: true, modelId: nativeId });
  } catch (error) {
    return errorResponse(error);
  }
}
