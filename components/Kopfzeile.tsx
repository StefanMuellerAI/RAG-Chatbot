import { Show, SignInButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import TabNav from "@/components/TabNav";
import { getKontext } from "@/lib/auth/user";

/**
 * Kopfbereich samt Reitern und Kontomenue.
 *
 * Serverkomponente, weil der Admin-Reiter nur erscheinen darf, wenn der Nutzer
 * die Rolle wirklich hat — und die steht in Postgres, nicht im Browser.
 */
export default async function Kopfzeile() {
  // Der Kopfbereich steht auch ueber der Anmeldeseite. Dort gibt es keinen
  // Nutzer, und bei einer frisch aufgesetzten Umgebung womoeglich noch keine
  // Datenbank. Beides darf die Seite nicht mitreissen, sonst kommt niemand
  // mehr bis zum Anmeldeformular.
  let istAdmin = false;
  try {
    istAdmin = (await getKontext())?.isAdmin ?? false;
  } catch {
    istAdmin = false;
  }

  return (
    <>
      <header className="kopf">
        <div className="kopf-inner">
          <Link href="/" className="wortmarke">
            Knowledge<span> Base</span>
          </Link>
          <div className="kopf-zusatz">Auskunft aus den eigenen Dokumenten</div>

          <div className="kopf-konto">
            {/* `Show` ist der Nachfolger von SignedIn/SignedOut ab Clerk Core 3. */}
            <Show when="signed-in">
              <UserButton />
            </Show>
            <Show when="signed-out">
              <SignInButton mode="modal">
                <button type="button" className="knopf knopf-sekundaer">
                  Anmelden
                </button>
              </SignInButton>
            </Show>
          </div>
        </div>
      </header>

      <Show when="signed-in">
        <TabNav istAdmin={istAdmin} />
      </Show>
    </>
  );
}
