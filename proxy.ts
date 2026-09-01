import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

/**
 * Zugriffsschutz.
 *
 * - Admin-Bereich, Einstellungen, Nutzer- und Einladungsverwaltung sowie der
 *   Notausgang `/api/collection` verlangen die Rolle `admin`.
 * - Chat, Sammlungen und Dokumente verlangen eine beliebige Sitzung; das
 *   Eigentum prueft die jeweilige Route.
 * - Offen bleiben Anmeldung und das Annehmen einer Einladung.
 *
 * Seit Next 16 heisst diese Konvention `proxy` statt `middleware`.
 */
export const config = {
  matcher: [
    "/",
    "/sammlungen/:path*",
    "/admin/:path*",
    "/api/chat",
    "/api/upload",
    "/api/documents",
    "/api/documents/:path*",
    "/api/collections",
    "/api/collections/:path*",
    "/api/collection",
    "/api/settings",
    "/api/settings/:path*",
    "/api/users",
    "/api/users/:path*",
    "/api/invites",
    "/api/invites/:path*",
  ],
};

const ADMIN_PREFIXES = ["/admin", "/api/settings", "/api/users", "/api/invites", "/api/collection"];
const OPEN_PATHS = ["/api/invites/accept"];

function brauchtAdmin(pathname: string): boolean {
  // "/api/collection" (Notausgang) ja, "/api/collections" (Nutzer) nein.
  if (pathname === "/api/collections" || pathname.startsWith("/api/collections/")) return false;
  return ADMIN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (OPEN_PATHS.includes(pathname)) return NextResponse.next();

  const isApi = pathname.startsWith("/api/");
  const secret = process.env.AUTH_SECRET;

  // Ohne AUTH_SECRET laesst sich keine Sitzung pruefen. Dann wird zugesperrt
  // statt durchgewunken — sonst stuende alles bei fehlender Konfiguration
  // versehentlich offen.
  if (!secret) {
    return isApi
      ? NextResponse.json(
          { error: "AUTH_SECRET ist nicht gesetzt. Der geschuetzte Bereich bleibt gesperrt." },
          { status: 503 },
        )
      : redirectToLogin(request, "config");
  }

  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, secret);
  if (!session) {
    return isApi
      ? NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 })
      : redirectToLogin(request, "auth");
  }

  if (brauchtAdmin(pathname) && session.role !== "admin") {
    return isApi
      ? NextResponse.json({ error: "Nur fuer Administratoren." }, { status: 403 })
      : redirectToLogin(request, "admin");
  }

  return NextResponse.next();
}

function redirectToLogin(request: NextRequest, reason: string) {
  const url = new URL("/login", request.url);
  url.searchParams.set("grund", reason);
  url.searchParams.set("weiter", request.nextUrl.pathname);
  return NextResponse.redirect(url);
}
