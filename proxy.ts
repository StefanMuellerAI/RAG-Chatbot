import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

/**
 * Zugriffsschutz fuer den Admin-Bereich und alle schreibenden Routen.
 * Der Chat (`/` und `/api/chat`) bleibt bewusst offen.
 *
 * Seit Next 16 heisst diese Konvention `proxy` statt `middleware`.
 */
export const config = {
  matcher: [
    "/admin/:path*",
    "/api/upload",
    "/api/documents",
    "/api/documents/:path*",
    "/api/collection",
  ],
};

export async function proxy(request: NextRequest) {
  const secret = process.env.AUTH_SECRET;
  const isApi = request.nextUrl.pathname.startsWith("/api/");

  // Ohne AUTH_SECRET laesst sich keine Sitzung pruefen. Dann wird zugesperrt
  // statt durchgewunken — sonst stuende der Admin bei fehlender Konfiguration
  // versehentlich offen.
  if (!secret) {
    return isApi
      ? NextResponse.json(
          { error: "AUTH_SECRET ist nicht gesetzt. Der Admin-Bereich bleibt gesperrt." },
          { status: 503 },
        )
      : redirectToLogin(request, "config");
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token, secret)) return NextResponse.next();

  return isApi
    ? NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 })
    : redirectToLogin(request, "auth");
}

function redirectToLogin(request: NextRequest, reason: string) {
  const url = new URL("/login", request.url);
  url.searchParams.set("grund", reason);
  url.searchParams.set("weiter", request.nextUrl.pathname);
  return NextResponse.redirect(url);
}
