import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const sicherheitsHeader = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/**
 * Die WASM-Datei von sql.js wird zur Laufzeit per fs gelesen — das File
 * Tracing von Vercel sieht diesen Zugriff nicht und muss sie explizit
 * mitnehmen. Fehlt das Paket (noch), ignoriert Next den Pfad stillschweigend.
 */
const SQL_WASM = ["./node_modules/sql.js/dist/sql-wasm.wasm"];

const nextConfig: NextConfig = {
  // Die Dokument-Parser bringen eigene Worker/Binaries mit und vertragen sich
  // nicht mit dem Bundler — sie muessen zur Laufzeit aus node_modules kommen.
  // sql.js (SQLite als WASM) und der FalkorDB-Client ebenso.
  serverExternalPackages: ["unpdf", "mammoth", "exceljs", "sql.js", "falkordb"],

  // Sowohl die API-Routen als auch die vom Workflow SDK erzeugten Routen
  // (Schritte laufen unter /.well-known/workflow/...) brauchen die WASM-Datei.
  outputFileTracingIncludes: {
    "/api/**": SQL_WASM,
    "/.well-known/workflow/**": SQL_WASM,
  },

  async headers() {
    return [{ source: "/(.*)", headers: sicherheitsHeader }];
  },
};

// Schaltet die Direktiven "use workflow" und "use step" frei, auf denen die
// Dokumentverarbeitung aufsetzt.
export default withWorkflow(nextConfig);
