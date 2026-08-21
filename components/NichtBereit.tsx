import { auth } from "@clerk/nextjs/server";
import { envDiagnose } from "@/lib/env";

/**
 * Hinweis auf eine unvollstaendige Einrichtung.
 *
 * Die Meldung faellt unterschiedlich aus, je nachdem wer sie liest. Angemeldeten
 * nennt sie die fehlenden Variablen und die konkreten naechsten Schritte.
 * Einem nicht angemeldeten Besucher sagt sie nur, dass es noch nicht laeuft:
 * Die Namen der Variablen verraten den Aufbau der Anwendung, und dafuer gibt es
 * keinen Grund.
 *
 * `auth()` genuegt hier und nicht `getKontext()`: Letzteres braeuchte die
 * Datenbank, und die ist unter Umstaenden genau das, was fehlt.
 */
export default async function NichtBereit({
  bereich,
  fehlt,
}: {
  bereich: string;
  fehlt: string[];
}) {
  const { userId } = await auth().catch(() => ({ userId: null }));
  const diagnose = userId ? await envDiagnose() : null;

  if (diagnose) {
    console.info(
      JSON.stringify({
        ereignis: "env-diagnose",
        vercelEnv: diagnose.vercelEnv,
        gesetzt: diagnose.gesetzt,
        leer: diagnose.leer,
        fehlt,
      }),
    );
  }

  const schritte = naechsteSchritte(fehlt);

  return (
    <div className="meldung">
      <b>{bereich} ist noch nicht einsatzbereit.</b>{" "}
      {userId ? (
        <>
          <p>
            Es fehlen: <code>{fehlt.join(", ")}</code>.
          </p>
          {schritte.length > 0 && (
            <ul className="meldung-schritte">
              {schritte.map((schritt) => (
                <li key={schritt}>{schritt}</li>
              ))}
            </ul>
          )}
          {diagnose && (
            <p className="meldung-diagnose">
              Instanz: <code>{diagnose.vercelEnv}</code>. Gesetzt:{" "}
              <code>{diagnose.gesetzt.join(", ") || "(nichts)"}</code>. Leer:{" "}
              <code>{diagnose.leer.join(", ")}</code>.
            </p>
          )}
        </>
      ) : (
        <>Die Einrichtung ist noch nicht abgeschlossen. Bitte an die Administration wenden.</>
      )}
    </div>
  );
}

function naechsteSchritte(fehlt: string[]): string[] {
  const schritte: string[] = [];
  if (fehlt.includes("DATABASE_URL")) {
    schritte.push(
      "Postgres: im Vercel-Projekt Storage → Create Database → Neon. Das setzt DATABASE_URL automatisch.",
    );
  }
  if (
    fehlt.includes("UPSTASH_REDIS_REST_URL") ||
    fehlt.includes("UPSTASH_REDIS_REST_TOKEN")
  ) {
    schritte.push(
      "Redis: Storage → Create Database → Upstash Redis. Das setzt KV_REST_API_URL und KV_REST_API_TOKEN.",
    );
  }
  if (fehlt.includes("AI_GATEWAY_API_KEY")) {
    schritte.push(
      "AI Gateway: unter vercel.com/dashboard/ai-gateway einen API-Key anlegen und als AI_GATEWAY_API_KEY setzen, oder in Project Settings → Security „OIDC Federation“ einschalten.",
    );
  }
  if (fehlt.includes("PINECONE_API_KEY")) {
    schritte.push("Pinecone: PINECONE_API_KEY aus der Pinecone-Konsole hinterlegen.");
  }
  if (fehlt.includes("BLOB_READ_WRITE_TOKEN")) {
    schritte.push("Blob: Storage → Create Database → Blob.");
  }
  if (schritte.length > 0) {
    schritte.push("Nach dem Anlegen der Stores ein erneutes Deployment ausloesen.");
  }
  return schritte;
}
