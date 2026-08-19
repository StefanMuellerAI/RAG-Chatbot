import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Die Dokument-Parser bringen eigene Worker/Binaries mit und vertragen sich
  // nicht mit dem Bundler — sie muessen zur Laufzeit aus node_modules kommen.
  serverExternalPackages: ["unpdf", "mammoth", "exceljs"],
};

export default nextConfig;
