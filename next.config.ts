import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // Die Dokument-Parser bringen eigene Worker/Binaries mit und vertragen sich
  // nicht mit dem Bundler — sie muessen zur Laufzeit aus node_modules kommen.
  // sql.js (SQLite als WASM) und der FalkorDB-Client ebenso.
  serverExternalPackages: ["unpdf", "mammoth", "exceljs", "sql.js", "falkordb"],

  // Die WASM-Datei von sql.js wird zur Laufzeit per fs gelesen — das File
  // Tracing von Vercel sieht diesen Zugriff nicht und muss sie explizit mitnehmen.
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/sql.js/dist/sql-wasm.wasm"],
  },

  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
