import { auth } from "@clerk/nextjs/server";

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

  return (
    <div className="meldung">
      <b>{bereich} ist noch nicht einsatzbereit.</b>{" "}
      {userId ? (
        <>
          Es fehlen folgende Environment-Variablen: <code>{fehlt.join(", ")}</code>. Sie
          werden im Vercel-Projekt unter <i>Settings &rarr; Environment Variables</i>{" "}
          hinterlegt; danach ist ein erneutes Deployment noetig. Die Einrichtungsschritte
          stehen in der README.
        </>
      ) : (
        <>Die Einrichtung ist noch nicht abgeschlossen. Bitte an die Administration wenden.</>
      )}
    </div>
  );
}
