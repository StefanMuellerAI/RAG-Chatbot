/**
 * Lasttest gegen den Frageweg.
 *
 *   npx tsx scripts/lasttest.ts --url https://... --cookie "__session=..." \
 *     --gleichzeitig 50 --dauer 60
 *
 * Der Chat liegt hinter der Anmeldung, deshalb braucht der Test ein echtes
 * Sitzungs-Cookie: im Browser anmelden, in den Entwicklerwerkzeugen unter
 * Application → Cookies den Wert von `__session` kopieren.
 *
 * Warum ueberhaupt messen und nicht rechnen: Die Zielgroessen dieses Umbaus -
 * rund 5.000 Fragen pro Minute und etwa 1.250 gleichzeitig offene Antworten -
 * ergeben sich aus den dokumentierten Grenzen der beteiligten Dienste. Was
 * daran stimmt, zeigt erst der Versuch. Der Test faehrt die Gleichzeitigkeit
 * deshalb stufenweise hoch und zeigt, wo die Latenz kippt und welcher Dienst
 * zuerst 429 sagt.
 *
 * WICHTIG: Jede Frage kostet echtes Geld beim Modellanbieter und verbraucht das
 * Tageskontingent des angemeldeten Kontos. Vor dem Lauf ein eigenes
 * Spend-Limit setzen und mit kleinen Werten anfangen.
 */

type Optionen = {
  url: string;
  cookie: string;
  gleichzeitig: number;
  dauer: number;
  frage: string;
};

type Ergebnis = {
  status: number;
  /** Zeit bis zum ersten Textstueck. Die entscheidet ueber das Empfinden. */
  ersterTokenMs: number | null;
  gesamtMs: number;
  abgeschlossen: boolean;
  fehler?: string;
};

function lieseOptionen(): Optionen {
  const argumente = process.argv.slice(2);
  const wert = (name: string, standard?: string): string => {
    const index = argumente.indexOf(`--${name}`);
    if (index === -1 || !argumente[index + 1]) {
      if (standard !== undefined) return standard;
      throw new Error(`--${name} fehlt.`);
    }
    return argumente[index + 1];
  };

  return {
    url: wert("url").replace(/\/$/, ""),
    cookie: wert("cookie"),
    gleichzeitig: Number(wert("gleichzeitig", "10")),
    dauer: Number(wert("dauer", "30")),
    frage: wert("frage", "Welche Gebuehren fallen an?"),
  };
}

async function eineFrage(optionen: Optionen): Promise<Ergebnis> {
  const start = Date.now();
  let ersterToken: number | null = null;

  try {
    const antwort = await fetch(`${optionen.url}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: optionen.cookie,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: optionen.frage }],
      }),
    });

    if (!antwort.ok || !antwort.body) {
      const text = await antwort.text().catch(() => "");
      return {
        status: antwort.status,
        ersterTokenMs: null,
        gesamtMs: Date.now() - start,
        abgeschlossen: false,
        fehler: text.slice(0, 160),
      };
    }

    const leser = antwort.body.getReader();
    const decoder = new TextDecoder();
    let puffer = "";
    let abgeschlossen = false;

    for (;;) {
      const { done, value } = await leser.read();
      if (done) break;

      puffer += decoder.decode(value, { stream: true });
      const zeilen = puffer.split("\n");
      puffer = zeilen.pop() ?? "";

      for (const zeile of zeilen) {
        if (!zeile.trim()) continue;
        const ereignis = JSON.parse(zeile) as { type?: string };

        if (ereignis.type === "text" && ersterToken === null) {
          ersterToken = Date.now() - start;
        }
        if (ereignis.type === "done") abgeschlossen = true;
      }
    }

    return {
      status: antwort.status,
      ersterTokenMs: ersterToken,
      gesamtMs: Date.now() - start,
      abgeschlossen,
    };
  } catch (error) {
    return {
      status: 0,
      ersterTokenMs: null,
      gesamtMs: Date.now() - start,
      abgeschlossen: false,
      fehler: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const optionen = lieseOptionen();

  console.log(
    `Lasttest gegen ${optionen.url}\n` +
      `  gleichzeitig: ${optionen.gleichzeitig}\n` +
      `  Dauer:        ${optionen.dauer} s\n`,
  );

  const ergebnisse: Ergebnis[] = [];
  const ende = Date.now() + optionen.dauer * 1000;
  let laufend = 0;

  /**
   * Konstante Gleichzeitigkeit statt konstanter Rate.
   *
   * Bei fester Rate stauen sich die Anfragen, sobald der Dienst langsamer wird,
   * und der Test misst am Ende die eigene Warteschlange. Mit einer festen Zahl
   * offener Anfragen entspricht der Aufbau dem, was tatsaechlich passiert: Jeder
   * Nutzer wartet auf seine Antwort, bevor er die naechste Frage stellt.
   */
  await new Promise<void>((fertig) => {
    const nachlegen = () => {
      while (laufend < optionen.gleichzeitig && Date.now() < ende) {
        laufend += 1;
        void eineFrage(optionen).then((ergebnis) => {
          ergebnisse.push(ergebnis);
          laufend -= 1;

          if (ergebnisse.length % 10 === 0) {
            process.stdout.write(`\r  ${ergebnisse.length} Antworten …`);
          }

          if (Date.now() < ende) nachlegen();
          else if (laufend === 0) fertig();
        });
      }

      if (laufend === 0 && Date.now() >= ende) fertig();
    };

    nachlegen();
  });

  berichte(ergebnisse, optionen);
}

function berichte(ergebnisse: Ergebnis[], optionen: Optionen): void {
  const gelungen = ergebnisse.filter((e) => e.abgeschlossen);
  const gedrosselt = ergebnisse.filter((e) => e.status === 429);
  const kontingent = ergebnisse.filter((e) => e.status === 409);
  const kaputt = ergebnisse.filter(
    (e) => !e.abgeschlossen && e.status !== 429 && e.status !== 409,
  );

  const proMinute = (ergebnisse.length / optionen.dauer) * 60;

  console.log(`\n\nErgebnis nach ${optionen.dauer} s\n`);
  console.log(`  Anfragen insgesamt      ${ergebnisse.length}`);
  console.log(`  hochgerechnet je Minute ${Math.round(proMinute)}`);
  console.log(`  vollstaendig            ${gelungen.length}`);
  console.log(`  gedrosselt (429)        ${gedrosselt.length}`);
  console.log(`  Kontingent (409)        ${kontingent.length}`);
  console.log(`  fehlerhaft              ${kaputt.length}`);

  if (gelungen.length > 0) {
    const bisToken = gelungen
      .map((e) => e.ersterTokenMs)
      .filter((wert): wert is number => wert !== null);

    console.log(`\n  Zeit bis zum ersten Wort`);
    console.log(`    Median   ${perzentil(bisToken, 50)} ms`);
    console.log(`    p95      ${perzentil(bisToken, 95)} ms`);

    const gesamt = gelungen.map((e) => e.gesamtMs);
    console.log(`\n  Antwortdauer insgesamt`);
    console.log(`    Median   ${perzentil(gesamt, 50)} ms`);
    console.log(`    p95      ${perzentil(gesamt, 95)} ms`);
  }

  if (kaputt.length > 0) {
    console.log(`\n  Fehlerbilder (die ersten fuenf)`);
    for (const eintrag of kaputt.slice(0, 5)) {
      console.log(`    Status ${eintrag.status}: ${eintrag.fehler ?? "ohne Meldung"}`);
    }
  }

  // Die Einordnung ist der Zweck der Uebung: Zahlen ohne Deutung fuehren zu
  // falschen Schluessen.
  console.log(`\n  Deutung`);
  if (gedrosselt.length > ergebnisse.length * 0.05) {
    console.log(
      `    Ueber 5 Prozent gedrosselt. Entweder greift das Kurzfenster je Nutzer\n` +
        `    (der Test faehrt mit EINEM Konto, echte Last verteilt sich), oder\n` +
        `    GLOBAL_QUESTIONS_PER_MINUTE ist zu niedrig gesetzt.`,
    );
  }
  if (kaputt.length > 0) {
    console.log(
      `    Fehlerhafte Antworten deuten auf den Modellanbieter oder die\n` +
        `    Vektor-Datenbank. Die Meldungen oben nennen die Quelle.`,
    );
  }
  if (gedrosselt.length === 0 && kaputt.length === 0) {
    console.log(`    Keine Drosselung, keine Fehler. Gleichzeitigkeit weiter erhoehen.`);
  }
}

function perzentil(werte: number[], anteil: number): number {
  if (werte.length === 0) return 0;
  const sortiert = [...werte].sort((a, b) => a - b);
  const index = Math.min(
    Math.floor((anteil / 100) * sortiert.length),
    sortiert.length - 1,
  );
  return sortiert[index];
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
