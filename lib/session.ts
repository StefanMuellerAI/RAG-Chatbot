import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken, type Session } from "./auth";

/**
 * Sitzung der aktuellen Anfrage fuer Server-Komponenten und Route-Handler.
 * Der Proxy sperrt die Routen; hier wird die Identitaet gelesen, mit der
 * Eigentum an Sammlungen geprueft wird.
 */
export async function currentSession(): Promise<Session | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return verifySessionToken(token, secret);
}
