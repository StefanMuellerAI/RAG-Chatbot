import { errorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/user";
import { envDiagnose, graphConfigured, providerKeySecretKonfiguriert } from "@/lib/env";
import { sqlJsDiagnose } from "@/lib/sqlstore";

export const runtime = "nodejs";

/**
 * Laufzeit-Diagnose fuer den Betreiber, nur fuer Admins.
 *
 * Nach einem Deployment beantwortet ein Aufruf die Fragen, die sich sonst erst
 * beim ersten Nutzer zeigen: Liegt die WASM-Datei von sql.js im Bundle (File
 * Tracing), ist FalkorDB konfiguriert, koennen Anbieter-Keys verschluesselt
 * werden (PROVIDER_KEY_SECRET), welche Umgebungsvariablen sieht die Instanz.
 * Es werden nur Namen und Versionen zurueckgegeben, keine Werte.
 */
export async function GET() {
  try {
    await requireAdmin();

    const [sqlJs, umgebung] = await Promise.all([sqlJsDiagnose(), envDiagnose()]);

    return Response.json({
      sqlJs,
      falkordbKonfiguriert: graphConfigured(),
      providerKeySecretKonfiguriert: providerKeySecretKonfiguriert(),
      umgebung,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
