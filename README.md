# Wissensassistent — mandantenfähiger RAG-Chatbot

Jeder Nutzer legt eigene Dokumentensammlungen an und stellt Fragen dazu. Die Antwort
stützt sich ausschließlich auf seine Unterlagen und nennt ihre Fundstellen. Bei mehreren
Sammlungen entscheidet das Modell selbst, wo es sucht.

- **Anmeldung**: Clerk mit Registrierung, Nutzerkonten und Rollen
- **Antworten**: Claude über das Vercel AI Gateway, Modell je Plan
- **Vektorsuche**: Pinecone Serverless, ein Namespace je Sammlung, Embedding im Dienst
- **Datenbank**: Neon Postgres mit Drizzle
- **Dateiablage**: Vercel Blob (privat, mandantenpräfigiert)
- **Drosselung und Kontingente**: Upstash Redis
- **Verarbeitung**: Vercel Workflow SDK
- **Formate**: PDF, DOCX, XLSX
- **Design**: in Anlehnung an stadt-koeln.de

Ausgelegt auf rund 15.000 gleichzeitig aktive Nutzer. Was das konkret bedeutet und wo die
Grenzen liegen, steht unter [Betrieb](#betrieb).

---

## Einrichtung

### 1. Dienste anbinden

```bash
vercel integration add clerk     # setzt die Clerk-Schlüssel
vercel integration add neon      # setzt DATABASE_URL
vercel integration add upstash   # setzt die Redis-Werte
```

Blob-Store im Vercel-Projekt unter **Storage → Create Database → Blob**; das setzt
`BLOB_READ_WRITE_TOKEN`. Pinecone-Schlüssel aus der [Pinecone-Konsole](https://app.pinecone.io).
Den Gateway-Schlüssel braucht es **lokal**; auf Vercel authentifiziert das AI Gateway
über den OIDC-Token des Projekts, ohne `AI_GATEWAY_API_KEY`.

Wer Neon oder Redis über **Storage** im Dashboard anlegt, bekommt oft andere Namen
(`POSTGRES_URL`, `KV_REST_API_URL` / `KV_REST_API_TOKEN`). Die App akzeptiert diese
Aliase. Nach dem Setzen der Variablen ist ein erneutes Deployment nötig.

Alle Variablen samt Zweck stehen in `.env.example`. Lokal:

```bash
cp .env.example .env.local   # und ausfüllen
npm install
```

### 2. Datenbank anlegen

```bash
npm run db:push    # Tabellen erzeugen
npm run db:seed    # Größenklassen S/M/L/XL und Pläne anlegen
```

Der Seed ist beliebig oft aufrufbar; bestehende Zeilen bleiben unberührt, damit
Admin-Anpassungen erhalten bleiben.

### 3. Pinecone-Index anlegen

```bash
npm run pinecone:init
```

**Dieser Schritt entscheidet, ob die Suche funktioniert.** Der Index muss mit eingebautem
Embedding-Modell entstehen, sonst nimmt er keinen Rohtext an — und das lässt sich
nachträglich nicht ändern. Ein von Hand in der Konsole angelegter Index ist der häufigste
Grund, warum am Ende nichts funktioniert. Das Skript legt einen Serverless-Index mit
`multilingual-e5-large` an (mehrsprachig, 1024 Dimensionen, Cosine); ein rein englisches
Modell liefert bei deutschen Dokumenten deutlich schlechtere Treffer.

### 4. Clerk-Webhook einrichten

Im Clerk-Dashboard unter **Webhooks** einen Endpunkt auf `https://<domain>/api/webhooks/clerk`
anlegen, Ereignisse `user.created`, `user.updated` und `user.deleted` abonnieren und das
Signaturgeheimnis als `CLERK_WEBHOOK_SIGNING_SECRET` hinterlegen.

Ohne Webhook läuft die Anwendung trotzdem: Fehlt die Nutzerzeile, wird sie beim ersten
Zugriff nachgezogen. Was dann fehlt, ist das Abräumen beim Löschen eines Kontos —
Namespaces und Dateien blieben liegen.

### 5. Ersten Admin bestimmen

Nach der ersten Registrierung in der Tabelle `users` einmalig `is_admin` auf `true`
setzen. Danach läuft die Rollenvergabe über die Nutzerliste im Admin-Bereich.

```sql
update users set is_admin = true where email = 'ihre@adresse.de';
```

### 6. Lokal starten

```bash
npm run dev
```

---

## Bedienung

**Chat** (`/`) — nur angemeldet. Die Frage geht an die Sammlungen des Nutzers; unter jeder
Antwort stehen die verwendeten Fundstellen mit Sammlung, Datei- und Seitenangabe,
zugeklappt, damit sie den Verlauf nicht zuschieben.

Bei mehreren Sammlungen wählt das Modell anhand von Name und Beschreibung selbst aus, wo
es sucht, und darf mehrere auf einmal nehmen. Bei nur einer Sammlung entfällt dieser
Schritt.

Findet die Suche nichts Passendes, wird das Modell gar nicht erst befragt — die App sagt
dann, dass sie dazu nichts hat. Das ist Absicht: eine erfundene Antwort wäre schlimmer als
keine.

Antworten werden als Markdown dargestellt. Rohes HTML wird dabei bewusst **nicht**
ausgeführt, sondern als Text angezeigt — der Antworttext ist über die hochgeladenen
Dokumente beeinflussbar, und genau dort wäre sonst ein Einfallstor.

**Sammlungen** (`/sammlungen`) — Anlegen, Dokumente einpflegen, entfernen. Beim Anlegen
sind drei Angaben zu machen: Name, eine Beschreibung des Inhalts, und die Art der
Unterlagen.

Die Beschreibung ist kein Zierfeld. Sie ist die Grundlage, auf der das Modell entscheidet,
ob eine Sammlung zur Frage passt — eine Sammlung ohne Beschreibung ist dort praktisch
unsichtbar. Wer keine hinterlegt, bekommt nach dem ersten Dokument einen Vorschlag.

**Administration** (`/admin`) — nur mit Rolle. Größenklassen und Pläne bearbeiten, Nutzern
Pläne zuweisen, Verbrauch einsehen.

---

## Größenklassen und Pläne

Zwei Begriffe, die sich leicht verwechseln lassen:

Eine **Größenklasse** sagt, wie viel in *eine* Sammlung passt: Dokumente, Seiten je
Dokument, Seiten insgesamt, Megabyte je Datei.

Ein **Plan** wird einem Nutzer zugewiesen und sagt, bis zu welcher Größenklasse er
Sammlungen anlegen darf, wie viele, wie viele Fragen pro Tag, und mit welchem Modell.

Ein Nutzer auf Plan `L` darf also S-, M- und L-Sammlungen anlegen. Neue Registrierungen
erhalten `S`.

Die Startwerte:

| Klasse | Dokumente | Seiten/Dok. | Seiten gesamt | MB/Datei |
|---|---|---|---|---|
| S | 20 | 100 | 2.000 | 25 |
| M | 100 | 300 | 20.000 | 50 |
| L | 500 | 1.000 | 150.000 | 100 |
| XL | 2.000 | 2.000 | 600.000 | 200 |

| Plan | bis Klasse | Sammlungen | Fragen/Tag | Modell |
|---|---|---|---|---|
| S | S | 3 | 200 | Haiku 4.5 |
| M | M | 10 | 1.000 | Haiku 4.5 |
| L | L | 25 | 5.000 | Sonnet 5 |
| XL | XL | 100 | 25.000 | Opus 5 |

Alle Werte sind im Admin-Bereich zur Laufzeit änderbar; sie stehen deshalb in Tabellen und
nicht im Code. Eine Zuweisung greift sofort, eine Änderung an der Plan-Definition
innerhalb einer Minute — der Nutzerkontext liegt so lange im Zwischenspeicher.

---

## Verarbeitungspresets

Beim Anlegen einer Sammlung wird eine von drei Arten gewählt. Sie gilt für die ganze
Sammlung, damit die Abschnitte darin vergleichbar lang bleiben — sonst hinge die Rangfolge
der Treffer von der Abschnittslänge ab statt vom Inhalt.

**Fließtext** — Berichte, Handbücher, Protokolle. Große Abschnitte, Schnitt an Absatz- und
Satzgrenzen, überlappend gegen Aussagen, die genau auf einer Kante liegen.

**Tabellen und Zahlen** — Preislisten, Öffnungszeiten, Gebührentabellen. Zeilenblöcke, und
die Kopfzeile wird in *jeden* Abschnitt wiederholt: Ein Zahlenblock aus der Mitte einer
Tabelle ist ohne seine Spaltenüberschriften bedeutungslos. Keine Überlappung — eine doppelt
geführte Tabellenzeile ist kein gewonnener Zusammenhang, sondern ein zweiter Treffer mit
gleichem Inhalt.

**Regelwerke** — Satzungen, Verträge, AGB. Kleine, präzise Abschnitte, Schnitt an
Paragraphengrenzen, die zugehörige Überschrift bleibt am Abschnitt.

Die Logik ist durch `npm run pruefe:chunks` abgedeckt. Das ist kein Selbstzweck: Zwei
Fehler darin hätten falsche Antworten erzeugt — eine Bestimmung mit der Überschrift einer
anderen, und eine Schnittkante, die aus drei Abschnitten vierundfünfzig fast gleiche
machte.

---

## Prüfungen

```bash
npm run pruefe            # Chunks, Kontingente und Environment-Erkennung
npm run pruefe:chunks     # die drei Zerlegungsstrategien
npm run pruefe:kontingente # Grenzen der Pläne und Größenklassen
npm run pruefe:env        # Aliase und OIDC der Environment-Variablen
npm run typecheck
npm run lint
```

Kein Testframework, weil es um zwei Sätze reiner Funktionen geht. Beide sind aber die
Stellen, an denen ein Fehler teuer wird: Die Zerlegung entscheidet, was zitiert wird, die
Kontingente entscheiden, was ein Nutzer anlegen darf. Ein Fehler dort fällt entweder nie
auf, weil zu lasch, oder erst beim Nutzer, weil zu streng.

Die Kontingentprüfung testet ausdrücklich die Grenzen selbst — genau am Limit muss es noch
gehen, einen Schritt darüber nicht mehr.

---

## Aufbau

```
app/
  page.tsx                        Chat
  sammlungen/                     eigene Sammlungen, Detailansicht mit Upload
  admin/                          Größenklassen, Pläne, Nutzer, Verbrauch
  sign-in/ · sign-up/             Clerk
  api/chat/                       Retrieval, Tool-Aufruf, Antwort-Streaming (NDJSON)
  api/chats/                      Verlauf
  api/collections/                Sammlungen, Upload-Anmeldung
  api/documents/                  Verarbeitung, Löschen, Download
  api/admin/                      Stammdaten und Rollen
  api/upload/                     Token für den Direkt-Upload zu Vercel Blob
  api/webhooks/clerk/             Nutzerdaten spiegeln
  api/cron/aufraeumen/            stündlicher Aufräumlauf
proxy.ts                          stellt die Clerk-Sitzung bereit
workflows/
  ingest.ts                       Dokumentverarbeitung in wiederholbaren Schritten
  aufraeumen.ts                   Abräumen nach dem Löschen eines Kontos
lib/
  db/                             Drizzle-Schema, Verbindung, Seed
  auth/user.ts                    Clerk-Identität zu Plan, Rolle, Größenklasse
  collections.ts · documents.ts   Sammlungen und Dokumente, Nutzer-ID stets in der Abfrage
  vector.ts                       Pinecone: schreiben, suchen, löschen
  ai.ts                           Modell, Systemanweisung, Suchwerkzeug
  presets.ts · chunk.ts           die drei Verarbeitungsarten
  extract.ts                      PDF · DOCX · XLSX → Text und Seitenzahl
  quota.ts · ratelimit.ts         Grenzen und Drosselung
  chats.ts · chatVerlauf.ts       Verlauf, Server und Client-Fassade
  admin.ts · models.ts            Stammdaten und Modellpreise
  aufraeumen.ts                   Überreste des laufenden Betriebs
```

### Entwurfsentscheidungen

**Jede Ressource prüft selbst, und zwar dort, wo sie auf Daten zugreift.** Der
naheliegende Weg — ein Muster aller geschützten Pfade und eine Prüfung im Proxy — ist von
Clerk ausdrücklich verworfen, und der Grund ist einleuchtend: Ein Pfadmuster kann von dem
abweichen, wie Next.js Anfragen tatsächlich zuordnet, und dann steht eine geschützte
Ressource offen, obwohl das Muster sie zu decken scheint. Bei einer mandantenfähigen
Anwendung wiegt dieser Unterschied schwer.

Seiten leiten über `requireKontextFuerSeite()` zur Anmeldung, API-Routen antworten mit
401 und JSON. Das ist auch die genauere Antwort: Eine Weiterleitung auf eine HTML-Seite
lässt jedes `fetch` im Browser mit einem Folgefehler scheitern, dessen Ursache man nicht
mehr erkennt.

**Die Nutzer-ID steht in der `WHERE`-Klausel, nicht in einer Prüfung danach.** Eine fremde
ID liefert damit dasselbe wie eine erfundene — nichts. Es gibt bewusst keine Funktion, die
eine Sammlung nur anhand ihrer ID liefert; genau die würde irgendwann ohne Prüfung
aufgerufen.

**Den Collection-IDs aus dem Tool-Aufruf wird nicht geglaubt.** Sie stammen aus einem Text,
den hochgeladene Dokumente mitbeeinflussen, und werden gegen die Sammlungen des Aufrufers
gefiltert, bevor Pinecone angefragt wird. Halluziniert das Modell eine fremde ID oder wird
es per Prompt-Injection dazu verleitet, kommt sie nicht durch.

**Ein Namespace je Sammlung statt eines Metadatenfilters.** Pinecone rechnet nach der Größe
des *angefragten* Namespace ab — eine kleine Sammlung kostet das Minimum, egal wie viele
Sammlungen es insgesamt gibt. Ein Filter über einen gemeinsamen Namespace würde bei jeder
Abfrage den gesamten Bestand abrechnen, denn gefiltert wird nach dem Durchsuchen.
Zusätzlich sind Namespaces harte Trennwände: Ein vergessener Filter könnte fremde
Dokumente offenlegen, ein falscher Namespace liefert schlicht nichts.

**Uploads laufen am Server vorbei, aber nicht an der Prüfung.** Der Browser meldet die
Datei erst an — dabei wird das Kontingent geprüft und der Ablagepfad auf dem Server
gebildet —, lädt sie dann mit einem kurzlebigen Token direkt in den Blob-Store. Die
Token-Ausgabe verlangt, dass zu dem Pfad eine Anmeldung vorliegt. Damit hängt jeder Upload
an einer erfolgten Kontingentprüfung.

**Die Seitengrenze wird zweistufig geprüft.** Dateigröße und Dokumentzahl vorher, die
Seitenzahl erst nach der Textextraktion: Ein 400-seitiges PDF kann als 3-MB-Datei ankommen
und jede Größenprüfung vorher bestehen.

**Abschnitts-IDs sind deterministisch** (`<docId>#<n>`). Deshalb ist die Wiederholung eines
Verarbeitungsschrittes gefahrlos — sie überschreibt dieselben Einträge statt Duplikate
anzulegen — und ein Dokument lässt sich ohne mitgeführte ID-Liste entfernen.

**Die Konfiguration wird erst im Request gelesen**, und zwar als `process.env.NAME`
mit festem Literal. Next.js ersetzt nur diese Form; ein dynamisches
`process.env[name]` bleibt im Server-Bundle leer, obwohl die Werte in Vercel
stehen. Fehlende Variablen führen zu einer benannten Meldung in der Oberfläche
statt zu einem abgebrochenen Build. Marketplace-Aliase (`POSTGRES_URL`,
`KV_REST_API_*`) und der Vercel-OIDC-Token für das AI Gateway zählen mit.

**Modell-Routing ist nicht nur ein Kostenhebel.** Anthropic zählt seine Minutenlimits
getrennt pro Modell. Last über Haiku, Sonnet und Opus zu verteilen verdreifacht damit den
verfügbaren Durchsatz.

---

## Betrieb

### Vor dem Produktivgang

**Fluid Compute mit In-Function-Concurrency einschalten** (Pro oder Enterprise, im
Projekt unter Settings → Functions). Die Antwortströme sind I/O-gebunden und warten fast
nur. Ohne geteilte Instanzen wird jede gleichzeitige Antwort als eigene Instanz nach
Wall-Clock abgerechnet — bei über tausend gleichzeitigen Antworten ist das der größte
vermeidbare Kostenposten.

**Höhere Anthropic-Limits beantragen.** Bei 15.000 gleichzeitig aktiven Nutzern mit einer
Frage alle zwei bis drei Minuten fallen etwa 5.000 bis 7.500 Fragen pro Minute an, also
grob 4,5 Mio. Output-Token pro Minute. Das Scale-Tier gibt 2 Mio. pro Modell. Mit der
Verteilung über drei Modelle wird es knapp erreichbar; darüber braucht es eine verhandelte
Zusage.

**Ein eigenes Spend-Limit setzen**, unterhalb des Tier-Caps. Es ist die letzte Notbremse,
wenn Kontingente und Drosselung nicht greifen.

**`GLOBAL_QUESTIONS_PER_MINUTE` festlegen.** Die Tageskontingente der einzelnen Pläne
summieren sich bei 15.000 Nutzern zu einem Vielfachen dessen, was der Modellanbieter pro
Minute liefert. Ohne diese Obergrenze bringt schon ein normaler Montagmorgen die Anwendung
in die 429er-Zone des Anbieters — und dort trifft es alle gleichzeitig.

### Lasttest

```bash
npm run lasttest -- --url https://... --cookie "__session=..." \
  --gleichzeitig 50 --dauer 60
```

Der Chat liegt hinter der Anmeldung, der Test braucht daher ein echtes Sitzungs-Cookie.
Er fährt eine konstante Zahl offener Anfragen statt einer konstanten Rate: Bei fester Rate
stauen sich die Anfragen, sobald es langsamer wird, und man misst am Ende die eigene
Warteschlange.

Jede Frage kostet echtes Geld und verbraucht das Tageskontingent des Kontos. Klein
anfangen.

Zielgrößen zur Einordnung: rund 5.000 Fragen pro Minute, etwa 1.250 gleichzeitig offene
Antworten. Vercel selbst ist dabei nicht der Engpass — 30.000 gleichzeitige Funktionen auf
Hobby und Pro lassen zwei Größenordnungen Luft. Der Engpass ist der Modellanbieter.

### Beobachtbarkeit

Die Tabelle `usage_events` verbucht je Frage Modell, Token und Kosten in Mikro-Dollar. Der
Admin-Bereich zeigt daraus Tages- und Monatssummen sowie die zwanzig größten Verbraucher —
wenn die Rechnung ungewöhnlich aussieht, steht die Ursache dort oben.

Abweisungen (429 und 409) landen strukturiert im Log:

```json
{"ereignis":"abweisung","status":429,"code":"zu_viele_anfragen","userId":"user_..."}
```

Ihre Häufigkeit ist die wichtigste laufende Kennzahl: Steigt sie, sind entweder die
Kontingente zu knapp bemessen oder ein Konto verhält sich auffällig.

### Aufräumlauf

Stündlich per Cron (`vercel.json`), geschützt über `CRON_SECRET`. Er verwirft angemeldete
Uploads, die nie ankamen — sie verkleinern sonst das Kontingent, ohne dass etwas dafür da
wäre —, setzt hängende Verarbeitungen auf Fehler und entfernt alte Webhook-Kennungen.

### Übernahme aus der Einzelnutzer-Fassung

```bash
npm run migriere:altdaten -- <clerk-user-id> L
```

Legt eine Sammlung an und übernimmt die Dokumente aus der alten Blob-Struktur. Die
Vektoren werden neu erzeugt und nicht kopiert: Der alte Bestand lag in einem
Upstash-Index mit `bge-m3`, jetzt ist es Pinecone mit `multilingual-e5-large`. Vektoren
aus verschiedenen Modellen sind nicht vergleichbar — sie zu kopieren ergäbe eine Suche,
die zufällige Treffer liefert.

Die alten Blobs bleiben unberührt und können nach einer Sichtprobe entfernt werden.

---

## Grenzen

- **Gescannte PDFs ohne Texterkennung** liefern keinen Text. Die Verarbeitung meldet das
  ausdrücklich, statt ein leeres Dokument anzulegen. Abhilfe: die Datei vorher durch OCR
  schicken.
- **Alte Binärformate `.doc` und `.xls`** werden nicht unterstützt. Einmal als `.docx`
  bzw. `.xlsx` speichern genügt.
- **Seitenzahlen bei DOCX und XLSX sind Schätzungen.** DOCX kennt keine Seiten — der
  Umbruch entsteht erst beim Druck. Für die Kontingentprüfung wird gerechnet: 3.000
  Zeichen bzw. 50 Tabellenzeilen je Seite.
- **Sammlungen sind nicht teilbar.** Jede gehört genau einem Nutzer. Team-Freigaben wären
  über Clerk-Organisationen möglich, brauchen aber das B2B-Add-on.
- **Das Verarbeitungspreset lässt sich nachträglich nicht ändern.** Es müssten alle
  Dokumente der Sammlung neu zerlegt werden; einfacher ist eine neue Sammlung.
- **Contextual Retrieval ist nicht eingebaut.** Eine LLM-generierte Kontextzeile pro
  Abschnitt verbessert die Trefferqualität deutlich, kostet bei diesem Mengenzuschnitt
  aber einen Modellaufruf pro Abschnitt.
