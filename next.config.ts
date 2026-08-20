import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // Die Dokument-Parser bringen eigene Worker/Binaries mit und vertragen sich
  // nicht mit dem Bundler — sie muessen zur Laufzeit aus node_modules kommen.
  serverExternalPackages: ["unpdf", "mammoth", "exceljs"],
};

// Schaltet die Direktiven "use workflow" und "use step" frei, auf denen die
// Dokumentverarbeitung aufsetzt.
export default withWorkflow(nextConfig);
