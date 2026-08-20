import { SignIn } from "@clerk/nextjs";

/**
 * Der Catch-all-Abschnitt `[[...sign-in]]` ist Vorgabe von Clerk: die
 * Komponente bildet mehrere Schritte (Passwort, Zwei-Faktor, Zuruecksetzen)
 * auf Unterpfade ab und braucht sie alle unter derselben Seite.
 */
export default function AnmeldeSeite() {
  return (
    <div className="anmeldung">
      <SignIn />
    </div>
  );
}
