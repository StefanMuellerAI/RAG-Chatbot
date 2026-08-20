import { seedStammdaten } from "../lib/db/seed";

/**
 * Legt Groessenklassen und Plaene an. Beliebig oft aufrufbar; bestehende
 * Zeilen bleiben unberuehrt, damit Admin-Anpassungen erhalten bleiben.
 *
 *   npm run db:push && npm run db:seed
 */
async function main() {
  await seedStammdaten();
  console.log("Stammdaten angelegt: Groessenklassen S/M/L/XL und Plaene S/M/L/XL.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
