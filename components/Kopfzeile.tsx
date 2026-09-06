import { Show, SignInButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { Suspense } from "react";
import TabNav from "@/components/TabNav";
import { getKontext } from "@/lib/auth/user";

/**
 * Kopfbereich samt Reitern und Kontomenue.
 *
 * Der Admin-Reiter darf nur erscheinen, wenn der Nutzer die Rolle wirklich hat,
 * und die steht in Postgres, nicht im Browser. Diese Abfrage liegt in einer
 * eigenen Suspense-Grenze: Das Geruest der Seite geht sofort an den Browser,
 * die Reiter folgen, sobald der Kontext da ist. Vorher wartete jede Seite mit
 * dem ersten Byte auf diesen Aufruf.
 */
export default function Kopfzeile() {
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
        <Suspense fallback={<TabNav istAdmin={false} />}>
          <Reiter />
        </Suspense>
      </Show>
    </>
  );
}

async function Reiter() {
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
  return <TabNav istAdmin={istAdmin} />;
}
