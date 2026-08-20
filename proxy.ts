import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Zugriffsschutz der gesamten Anwendung.
 *
 * Seit Next 16 heisst diese Konvention `proxy` statt `middleware`.
 *
 * Umgekehrte Logik gegenueber dem Vorgaenger: Frueher war alles offen und
 * einzelne Pfade wurden gesperrt. Jetzt ist alles gesperrt und einzelne Pfade
 * sind offen. Bei einer mandantenfaehigen Anwendung ist das der einzig
 * vertretbare Zuschnitt — eine vergessene Route darf nicht bedeuten, dass
 * fremde Dokumente erreichbar sind.
 *
 * Auch der Chat liegt jetzt hinter der Anmeldung, denn er durchsucht die
 * Collections des angemeldeten Nutzers. Ohne Identitaet gibt es nichts zu
 * durchsuchen.
 *
 * Die Rollenpruefung fuer den Admin-Bereich passiert NICHT hier, sondern in
 * den Routen und Seiten selbst: sie liest users.is_admin aus Postgres, und ein
 * Datenbankzugriff je Request waere hier bei 15.000 Nutzern verschwendet.
 */

const oeffentlich = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  // Clerk stellt Webhooks ohne Sitzung zu; die Echtheit wird in der Route
  // selbst ueber die Svix-Signatur geprueft.
  "/api/webhooks(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  if (!oeffentlich(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Interne Next-Pfade und statische Dateien auslassen, sofern sie nicht
    // in den Suchparametern auftauchen.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Fuer API-Routen immer laufen.
    "/(api|trpc)(.*)",
  ],
};
