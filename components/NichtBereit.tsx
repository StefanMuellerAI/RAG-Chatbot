import { auth } from "@clerk/nextjs/server";
import { envDiagnose } from "@/lib/env";

/**
 * Hinweis auf eine unvollstaendige Einrichtung.
 *
 * Die Meldung faellt unterschiedlich aus, je nachdem wer sie liest. Angemeldeten
 * nennt sie die fehlenden Variablen — genau das macht ein erstes Deployment
 * nachvollziehbar, statt es in einem unerklaerlichen Fehler enden zu lassen.
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
  const diagnose = userId ? envDiagnose() : null;

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

  return (
    <div className="meldung">
      <b>{bereich} ist noch nicht einsatzbereit.</b>{" "}
      {userId ? (
        <>
          <p>
            Es fehlen folgende Environment-Variablen: <code>{fehlt.join(", ")}</code>. Sie
            werden im Vercel-Projekt unter <i>Settings &rarr; Environment Variables</i>{" "}
            hinterlegt — fuer <b>Production</b>, <b>Preview</b> und <b>Development</b>, nicht
            nur fuer Development. Danach ist ein erneutes Deployment noetig.
          </p>
          {diagnose && (
            <p className="meldung-diagnose">
              Diese Instanz laeuft als <code>{diagnose.vercelEnv}</code>.{" "}
              {diagnose.gesetzt.length > 0 ? (
                <>
                  Gesetzt (Namen, keine Werte): <code>{diagnose.gesetzt.join(", ")}</code>.{" "}
                </>
              ) : (
                <>Kein bekannter Key ist in dieser Funktion gesetzt. </>
              )}
              Leer: <code>{diagnose.leer.join(", ")}</code>.
            </p>
          )}
        </>
      ) : (
        <>Die Einrichtung ist noch nicht abgeschlossen. Bitte an die Administration wenden.</>
      )}
    </div>
  );
}
