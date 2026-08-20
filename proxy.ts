import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { clerkKonfigurationFehlt } from "@/lib/env";

/**
 * Stellt die Clerk-Sitzung fuer Seiten und Routen bereit.
 *
 * Seit Next 16 heisst diese Konvention `proxy` statt `middleware`.
 *
 * Hier wird bewusst NICHT geschuetzt. Der naheliegende Weg — ein Muster aller
 * geschuetzten Pfade und `auth.protect()` an dieser Stelle — ist von Clerk
 * ausdruecklich verworfen, und der Grund ist einleuchtend: Ein Pfadmuster kann
 * von dem abweichen, wie Next.js Anfragen tatsaechlich zuordnet, und dann steht
 * eine geschuetzte Ressource offen, obwohl das Muster sie zu decken scheint. Bei
 * einer mandantenfaehigen Anwendung wiegt dieser Unterschied schwer.
 *
 * Stattdessen prueft jede Ressource selbst, und zwar dort, wo sie auf Daten
 * zugreift:
 *
 *   Seiten      requireKontextFuerSeite() — leitet zur Anmeldung
 *   API-Routen  requireKontext() / requireUserId() / requireAdmin() — 401 bzw. 403
 *
 * Das ist nicht nur die sicherere, sondern auch die genauere Antwort: Eine
 * API-Route soll 401 mit JSON liefern und keine Weiterleitung auf eine
 * HTML-Seite, an der ein `fetch` im Browser scheitert.
 */

const clerk = clerkMiddleware();

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  /**
   * Vorschaltung fuer den Fall, dass die Clerk-Schluessel fehlen.
   *
   * Ohne sie wirft `clerkMiddleware` tief im eigenen Code, und jede Anfrage —
   * auch die Anmeldeseite — endet in einem 500 mit einem Stacktrace, der auf
   * eine Datei in `.next/server/chunks` zeigt. Dass eine Environment-Variable
   * fehlt, laesst sich daran gerade noch ablesen; welche Umgebung betroffen ist
   * und dass ein neues Deployment noetig ist, nicht mehr.
   *
   * Zugesperrt und nicht durchgewunken: Eine fehlende Konfiguration darf nie in
   * einen ungeschuetzten Zustand fuehren.
   */
  const fehlt = clerkKonfigurationFehlt();
  if (fehlt.length > 0) return konfigurationsfehler(request, fehlt);

  return clerk(request, event);
}

function konfigurationsfehler(request: NextRequest, fehlt: string[]): NextResponse {
  const hinweis =
    `Die Anmeldung ist nicht konfiguriert. Es fehlen: ${fehlt.join(", ")}. ` +
    `Diese Variablen im Vercel-Projekt unter Settings -> Environment Variables ` +
    `hinterlegen und danach neu deployen.`;

  /**
   * Zwei Fallen, die diesen Zustand fast immer erklaeren, und beide sieht man an
   * der Variablenliste allein nicht:
   *
   * Erstens gelten Environment-Variablen auf Vercel je Deployment. Sie
   * nachtraeglich zu setzen wirkt nicht auf ein bestehendes Deployment — es
   * braucht ein neues.
   *
   * Zweitens werden sie je Umgebung freigeschaltet. Nur fuer Production gesetzt
   * und eine Preview-URL geoeffnet ergibt genau dieses Bild.
   */
  const erlaeuterung =
    `Zu pruefen sind zwei Dinge: Sind die Variablen fuer die Umgebung freigegeben, ` +
    `in die deployt wurde (Production, Preview, Development)? Und ist nach dem ` +
    `Hinterlegen ein neues Deployment erfolgt? Auf Vercel gelten ` +
    `Environment-Variablen je Deployment; ein bestehendes uebernimmt sie nicht ` +
    `nachtraeglich. Der Publishable Key muss dabei schon beim Build vorliegen, ` +
    `damit er auch im Browser-Bundle landet.`;

  console.error(`[Konfiguration] ${hinweis} ${erlaeuterung}`);

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: hinweis, hinweis: erlaeuterung, code: "konfiguration", variables: fehlt },
      { status: 503 },
    );
  }

  return new NextResponse(seite(hinweis, erlaeuterung), {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Eigenes HTML statt einer React-Seite: An dieser Stelle laeuft noch keine
 * Anwendung. Das Layout selbst braucht den Clerk-Provider und wuerde am
 * gleichen fehlenden Schluessel scheitern.
 */
function seite(hinweis: string, erlaeuterung: string): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nicht konfiguriert — Wissensassistent</title>
<style>
  body { margin:0; background:#f4f4f4; color:#1a1a1a;
         font-family:Arial,"Helvetica Neue",Helvetica,system-ui,sans-serif; line-height:1.55; }
  .kopf { background:#fff; border-bottom:4px solid #e1141c; padding:18px 20px; }
  .wortmarke { font-size:24px; font-weight:700; }
  .wortmarke span { color:#e1141c; }
  .inhalt { max-width:720px; margin:0 auto; padding:26px 20px; }
  .meldung { border-left:4px solid #e1141c; background:#fdf0f0; padding:16px 18px; }
  code { background:#ebebeb; padding:1px 5px; font-size:14px; }
  p { margin:0 0 12px; }
  p:last-child { margin-bottom:0; }
</style>
</head>
<body>
  <div class="kopf"><div class="wortmarke">Wissens<span>assistent</span></div></div>
  <div class="inhalt">
    <div class="meldung">
      <p><b>${hinweis}</b></p>
      <p>${erlaeuterung}</p>
    </div>
  </div>
</body>
</html>`;
}

export const config = {
  matcher: [
    // Interne Next-Pfade und statische Dateien auslassen, sofern sie nicht
    // in den Suchparametern auftauchen.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Fuer API-Routen immer laufen.
    "/(api|trpc)(.*)",
  ],
};
