import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const config = [
  ...coreWebVitals,
  ...typescript,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      // Vom Workflow SDK beim Build erzeugte Routen. Sie gehoeren nicht ins
      // Repository und sind nicht von Hand zu pflegen.
      "app/.well-known/**",
    ],
  },
];

export default config;
