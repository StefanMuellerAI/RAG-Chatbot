/**
 * Mehrnutzer-Lasttest. Ohne --run wird ausschliesslich die Fixture geprueft.
 *
 * npm run lasttest -- --url https://staging.example.org \
 *   --identities-file /private/tmp/lasttest-identities.json --dry-run
 * npm run lasttest -- --url https://staging.example.org \
 *   --identities-file /private/tmp/lasttest-identities.json --stages 100,250,500,1000 \
 *   --duration 30 --timeout 300 --report /private/tmp/lasttest-report.json --run
 *
 * Fixture (Cookies nur in der privaten Datei, nie als CLI-Argument):
 * {"identities":[{"id":"test-001","cookie":"__session=...","scenarios":[
 *   {"type":"vector","question":"Welche Gebuehren fallen an?","collectionIds":["UUID"]},
 *   {"type":"sql","question":"Wie hoch ist der Umsatz?","collectionIds":["UUID"]},
 *   {"type":"graph","question":"Welche Firmen sind verbunden?","collectionIds":["UUID"]}
 * ]}]}
 *
 * Stufe 1000 braucht 1000 verschiedene Testkonten mit gueltigen Sitzungen und
 * passenden Sammlungen. Die Typen sind Fixture-Labels und muessen zu den
 * ausgewaehlten Sammlungen passen. --burst sendet je Stufe genau eine Frage
 * pro Konto; sonst wird nach jeder Antwort bis zum Zeitende nachgelegt.
 *
 * --run erstellt einen Chat je Konto und erzeugt kostenpflichtige Anfragen.
 * Kontingente und Providerkapazitaet vor dem echten Lauf festlegen. Berichte
 * enthalten keine Cookies, Fragen, Antworten oder Konto-IDs.
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  createLoadChat, registerAuthenticatedUser, runLoadStage, validateFixture, validateStages, validateTarget,
  type PreparedIdentity,
} from "../lib/loadtest";

function readOptions() {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const flagNames = new Set(["--dry-run", "--run", "--burst", "--help"]);
  const valueNames = new Set(["--url", "--identities-file", "--stages", "--duration", "--timeout", "--report"]);
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i];
    if (flags.has(name) || values.has(name)) throw new Error("Eine Option wurde mehrfach angegeben.");
    if (flagNames.has(name)) flags.add(name);
    else if (valueNames.has(name) && args[i + 1] && !args[i + 1].startsWith("--")) values.set(name, args[++i]);
    else throw new Error("Unbekannte Option oder fehlender Wert. Hilfe: --help. Cookies nur ueber --identities-file.");
  }
  if (flags.has("--help")) return null;
  if (flags.has("--run") && flags.has("--dry-run")) throw new Error("--run und --dry-run schliessen sich aus.");
  const required = (key: string) => {
    const value = values.get(key);
    if (!value) throw new Error(`${key} fehlt.`);
    return value;
  };
  const seconds = (key: string, fallback: number, max: number) => {
    const value = Number(values.get(key) ?? fallback);
    if (!Number.isFinite(value) || value <= 0 || value > max) {
      throw new Error(`${key} muss groesser als 0 und hoechstens ${max} Sekunden sein.`);
    }
    return value * 1_000;
  };
  return {
    url: validateTarget(required("--url")), identitiesFile: required("--identities-file"),
    stages: validateStages(values.get("--stages") ?? "100,250,500,1000"),
    durationMs: seconds("--duration", 30, 3_600), timeoutMs: seconds("--timeout", 300, 300),
    report: values.get("--report") ?? "lasttest-report.json",
    run: flags.has("--run"), burst: flags.has("--burst"),
  };
}

async function main() {
  const options = readOptions();
  if (!options) {
    console.log("Lasttest: --url ORIGIN --identities-file DATEI [--stages 100,250,500,1000] " +
      "[--duration SEKUNDEN] [--timeout SEKUNDEN] [--burst] [--report DATEI] [--dry-run | --run]\n" +
      "Ohne --run: nur Fixture-Pruefung, keine Netzwerkanfragen. Cookies ausschliesslich in der Fixture.");
    return;
  }
  let raw: unknown;
  try { raw = JSON.parse(await readFile(options.identitiesFile, "utf8")); }
  catch { throw new Error("Die Identitaeten-Datei konnte nicht als JSON gelesen werden."); }
  const maximum = Math.max(...options.stages);
  const fixture = validateFixture(raw, maximum);
  const scenarioCounts = { vector: 0, sql: 0, graph: 0 };
  for (const identity of fixture.identities.slice(0, maximum)) {
    for (const scenario of identity.scenarios) scenarioCounts[scenario.type] += 1;
  }
  console.log(JSON.stringify({
    mode: options.run ? "run" : "dry-run", fixtureEntries: maximum, authenticatedAccountsVerified: false,
    stages: options.stages, burst: options.burst, scenarioCounts,
    durationSeconds: options.durationMs / 1_000, timeoutSeconds: options.timeoutMs / 1_000,
  }, null, 2));
  if (!options.run) {
    console.log("Fixture gueltig. Kontentrennung und Sitzungen sind erst bei --run serverseitig pruefbar. Keine Chats angelegt und keine Modellanfragen gesendet.");
    return;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const prepared: PreparedIdentity[] = new Array(maximum);
  const authenticatedUsers = new Set<string>();
  const stages: Awaited<ReturnType<typeof runLoadStage>>[] = [];
  let next = 0;
  try {
    // Separat begrenzte Vorbereitung; Chat-ID bleibt je Identitaet stabil.
    await Promise.all(Array.from({ length: Math.min(16, maximum) }, async () => {
      while (next < maximum && !controller.signal.aborted) {
        const index = next++;
        const identity = fixture.identities[index];
        try {
          const chat = await createLoadChat(identity, { ...options, signal: controller.signal });
          registerAuthenticatedUser(authenticatedUsers, chat.authenticatedUserId);
          prepared[index] = { identity, ...chat };
        } catch (error) { controller.abort(); throw error; }
      }
    }));
    const setupElapsedMs = performance.now() - start;
    if (controller.signal.aborted) throw new Error("Lasttest waehrend der Vorbereitung abgebrochen.");
    console.log(`${authenticatedUsers.size} getrennte Testkonten serverseitig bestaetigt und Testchats vorbereitet.`);
    for (let index = 0; index < options.stages.length && !controller.signal.aborted; index += 1) {
      const concurrency = options.stages[index];
      console.log(`Stufe ${concurrency} startet.`);
      const report = await runLoadStage(prepared.slice(0, concurrency), {
        ...options, signal: controller.signal, scenarioOffset: index,
      });
      stages.push(report);
      // Jede abgeschlossene Stufe bleibt auch bei spaeterem Abbruch erhalten.
      await writeFile(options.report, JSON.stringify({
        version: 1, startedAt, finishedAt: new Date().toISOString(),
        aborted: controller.signal.aborted, setupElapsedMs,
        verifiedDistinctAccounts: authenticatedUsers.size,
        wallElapsedMs: performance.now() - start, stages,
        notes: [
          "Raten verwenden die tatsaechliche Stufendauer einschliesslich auslaufender Antworten.",
          "Phasenzeiten sind clientseitige Statusabstaende; nicht reine Server-Rechenzeit.",
          "HTTP/Streams messen keine Browserdarstellung. Typen stammen aus der Fixture.",
          "Kontentrennung wurde vor der Last anhand der serverseitig bestaetigten Nutzeridentitaeten geprueft.",
          "Modellantworten zaehlen nur bei completed, Text, modelInvoked=true und ohne Streamfehler.",
        ],
      }, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ concurrency, ...report.total }, null, 2));
    }
    if (controller.signal.aborted) process.exitCode = 130;
    else if (stages.some((stage) => stage.total.successfulAnswers < stage.total.requests)) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Lasttest fehlgeschlagen.");
  process.exitCode = 1;
});
