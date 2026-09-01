import Link from "next/link";
import InviteAcceptForm from "@/components/InviteAcceptForm";
import { getInviteByToken } from "@/lib/invites";

export const dynamic = "force-dynamic";

export default async function EinladungSeite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  let email: string | null = null;
  let fehler: string | null = null;
  try {
    email = (await getInviteByToken(token))?.email ?? null;
  } catch (error) {
    fehler = error instanceof Error ? error.message : "Die Einladung konnte nicht geprueft werden.";
  }

  if (fehler) {
    return (
      <div className="karte anmeldung">
        <h1 className="karte-titel">Einladung</h1>
        <div className="meldung">{fehler}</div>
      </div>
    );
  }

  if (!email) {
    return (
      <div className="karte anmeldung">
        <h1 className="karte-titel">Einladung ungueltig</h1>
        <p className="hinweis-text">
          Dieser Einladungslink ist abgelaufen, wurde bereits verwendet oder widerrufen. Bitte
          eine neue Einladung anfordern.
        </p>
        <Link className="knopf knopf-sekundaer" href="/login">
          Zur Anmeldung
        </Link>
      </div>
    );
  }

  return <InviteAcceptForm token={token} email={email} />;
}
