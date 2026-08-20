import { raeumeAuf } from "@/lib/aufraeumen";
import { optionalEnv } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Stuendlicher Aufraeumlauf (siehe vercel.json).
 *
 * Die Route ist in proxy.ts nicht als oeffentlich gefuehrt und damit fuer
 * Browser ohne Sitzung gesperrt. Vercels Cron-Aufruf bringt aber keine Sitzung
 * mit, sondern einen Authorization-Header mit CRON_SECRET — deshalb wird der
 * hier geprueft. Ohne gesetztes Geheimnis bleibt die Route zu: eine
 * unbeabsichtigt offene Wartungsroute waere ein Hebel, um Kontingente
 * zurueckzusetzen.
 */
export async function GET(request: Request) {
  const geheimnis = optionalEnv("CRON_SECRET");

  if (!geheimnis) {
    return Response.json(
      {
        error:
          "CRON_SECRET ist nicht gesetzt. Der Aufraeumlauf bleibt gesperrt, bis das Geheimnis hinterlegt ist.",
      },
      { status: 503 },
    );
  }

  if (request.headers.get("authorization") !== `Bearer ${geheimnis}`) {
    return Response.json({ error: "Nicht berechtigt." }, { status: 401 });
  }

  try {
    const bericht = await raeumeAuf();
    console.log("[cron] Aufraeumlauf:", bericht);
    return Response.json({ ok: true, ...bericht });
  } catch (error) {
    console.error("[cron] Aufraeumlauf fehlgeschlagen.", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unbekannter Fehler." },
      { status: 500 },
    );
  }
}
