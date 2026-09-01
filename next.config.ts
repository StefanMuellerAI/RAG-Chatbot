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
  serverExternalPackages: ["unpdf", "mammoth", "exceljs"],

  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
