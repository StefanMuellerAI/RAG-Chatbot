import { clerkMiddleware } from "@clerk/nextjs/server";

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
 *   API-Routen  requireKontext() / requireUserId() / requireAdmin() — liefern 401 bzw. 403
 *
 * Das ist nicht nur die sicherere, sondern auch die genauere Antwort: Eine
 * API-Route soll 401 mit JSON liefern und keine Weiterleitung auf eine
 * HTML-Seite, an der ein `fetch` im Browser scheitert.
 */
export default clerkMiddleware();

export const config = {
  matcher: [
    // Interne Next-Pfade und statische Dateien auslassen, sofern sie nicht
    // in den Suchparametern auftauchen.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Fuer API-Routen immer laufen.
    "/(api|trpc)(.*)",
  ],
};
