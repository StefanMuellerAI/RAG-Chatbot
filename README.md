# Wissensassistent — mandantenfähiger RAG-Chatbot

Jeder Nutzer legt eigene Sammlungen an und stellt Fragen dazu. Die Antwort stützt sich
ausschließlich auf seine Unterlagen und nennt ihre Fundstellen. Bei mehreren Sammlungen
entscheidet das Modell selbst, wo es sucht — und womit.

Eine Sammlung hat einen von drei Typen (siehe [Drei Arten von Sammlungen](#drei-arten-von-sammlungen)):

- **Dokumente** — PDF, DOCX, XLSX und MP3 werden zerlegt bzw. transkribiert und semantisch durchsucht; die
  Antwort zitiert Fundstellen.
- **Tabellen** — CSV-Dateien werden zu Tabellen einer SQLite-Datenbank; das Modell
  schreibt SQL und rechnet mit den Zahlen statt sie zu schätzen.
- **Graph** — Cypher-Skripte werden zu einem Graphen in FalkorDB; das Modell schreibt
  Cypher für Fragen nach Beziehungen und Wegen.

- **Anmeldung**: Clerk mit Registrierung, Einladungen, Nutzerkonten und Rollen
- **Antworten**: Modell je Plan aus einem im Admin gepflegten Katalog — über das Vercel AI
  Gateway oder, mit eigenem Key, direkt bei Anthropic bzw. OpenAI
- **Vektorsuche**: Pinecone Serverless, ein Namespace je Sammlung, Embedding im Dienst
- **Tabellen**: SQLite-Datei je Sammlung in Vercel Blob, abgefragt durch einen separaten SQL-Dienst mit terminierbaren Workern
- **Graphen**: FalkorDB, ein Graph je Sammlung (optional, über `FALKORDB_URL`)
- **Datenbank**: Neon Postgres mit Drizzle
- **Dateiablage**: Vercel Blob (privat, mandantenpräfigiert)
- **Drosselung, Kontingente und Schreibsperren**: Upstash Redis
- **Verarbeitung**: Vercel Workflow SDK
- **Formate**: PDF, DOCX, XLSX, MP3 · CSV · Cypher-Skripte
- **Design**: in Anlehnung an stadt-koeln.de

Das Lasttestziel sind 1.000 gleichzeitig laufende Antworten. Verteilte Zulassung,
Modellbudgets und SQL-Isolation sind vorbereitet; eine Kapazitätszusage erfordert den
Lastnachweis mit realen Dienstquoten. [Migration, Grenzen und Abnahme](docs/scaling-and-chat.md).

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
Den Gateway-Schlüssel braucht es **lokal**. Auf Vercel liegt der OIDC-Token am
Request-Header `x-vercel-oidc-token`, nicht in `process.env` — deshalb reicht
dort kein manuell hinterlegtes `VERCEL_OIDC_TOKEN`. OIDC Federation in den
Projekteinstellungen muss an sein; sonst einen `AI_GATEWAY_API_KEY` setzen.

`PINECONE_INDEX` ist optional und fällt auf `wissensassistent` zurück.

Wer Neon oder Redis über **Storage** im Dashboard anlegt, bekommt oft andere Namen
(`POSTGRES_URL`, `KV_REST_API_URL` / `KV_REST_API_TOKEN`). Die App akzeptiert diese
Aliase. Ohne Neon und ohne Redis bleibt der Chat gesperrt — Clerk, Blob und der
Pinecone-Key allein reichen nicht. Nach dem Setzen der Variablen ist ein erneutes
Deployment nötig.

Redis ist außerdem Pflicht für **Tabellen- und Graph-Sammlungen**: Beide schreiben je
Sammlung in *eine* Datei bzw. *einen* Graphen, und zwei gleichzeitige Uploads dürfen das
nicht ungeordnet tun. Die Verarbeitung nimmt dafür eine Schreibsperre in Redis
(`SET NX EX`). Fehlt Redis, bricht der Schritt mit einer klaren Meldung ab, statt ohne
Sperre weiterzulaufen.

Alle Variablen samt Zweck stehen in `.env.example`. Lokal:

```bash
cp .env.example .env.local   # und ausfüllen
npm install
```

### 2. Datenbank anlegen

```bash
npm run db:migrate # Migrationen auf neuer oder bereits migrationsverwalteter Datenbank anwenden
npm run db:seed    # Größenklassen S/M/L/XL, Pläne und Modellkatalog anlegen
```

Der Seed ist beliebig oft aufrufbar; bestehende Zeilen bleiben unberührt, damit
Admin-Anpassungen erhalten bleiben. Wer die Datenbank aus einer früheren Fassung
übernimmt, gleicht zuerst den bestehenden Migrationsstand ab. Bei bisherigem `db:push`
nicht unbesehen alle Migrationen erneut ausführen. `0004` ergänzt serverseitige
Chat-Generierungen, Status und Feedback; sie muss vor dem neuen App-Deployment angewendet
werden. [Rollout-Anleitung](docs/scaling-and-chat.md#migration-und-rollout).

Für SQL-Abfragen zusätzlich den [SQL-Dienst](services/sql/README.md) betreiben und
`SQL_EXECUTOR_URL` sowie `SQL_EXECUTOR_TOKEN` in der App setzen.

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

### 6. FalkorDB anbinden (optional, nur für Graph-Sammlungen)

Unter [app.falkordb.cloud](https://app.falkordb.cloud) eine Instanz anlegen — der
Free-Tier reicht zum Ausprobieren (100 MB, von allen Graphen gemeinsam genutzt, ohne
TLS) — und die Verbindung hinterlegen:

```bash
FALKORDB_URL=falkor://benutzer:passwort@host:port
```

Ohne diese Variable ist der Typ **Graph** beim Anlegen einer Sammlung ausgegraut;
Dokumente und Tabellen funktionieren unabhängig davon. Die Anwendung baut die
Verbindung erst im Request auf, ein fehlender Wert bricht also keinen Build.

### 7. Eigene Anbieter-Keys (optional)

Wer Modelle von Anthropic oder OpenAI direkt statt über das Gateway ansprechen will,
setzt ein Geheimnis für die Verschlüsselung der Keys und trägt die Keys danach im
Admin-Bereich ein (siehe [KI-Modelle pflegen](#ki-modelle-pflegen)):

```bash
PROVIDER_KEY_SECRET=$(openssl rand -base64 32)
```

Ein Wechsel dieses Werts macht alle hinterlegten Keys unlesbar; sie müssen dann neu
eingegeben werden.

### 8. Lokal starten

```bash
npm run dev
```

Nach einem Deployment lohnt ein Aufruf von `GET /api/admin/diagnose` (als Admin
angemeldet) — er meldet, ob sql.js samt WASM-Datei im Bundle liegt und ob FalkorDB
konfiguriert ist; Einzelheiten unter [Betrieb](#betrieb).

---

## Bedienung

**Chat** (`/`) — nur angemeldet. Die Frage geht an die Sammlungen des Nutzers; unter jeder
Antwort stehen die verwendeten Fundstellen mit Sammlung, Datei- und Seitenangabe,
zugeklappt, damit sie den Verlauf nicht zuschieben.

Der Frageweg hängt davon ab, welche Sammlungen ein Nutzer hat:

1. **Genau eine Dokumentensammlung** — Direktsuche wie bisher: Die Fundstellen werden
   der Frage vorangestellt, ohne Werkzeugaufruf. Findet die Suche nichts Passendes, wird
   das Modell gar nicht erst befragt — die App sagt dann, dass sie dazu nichts hat. Das
   ist Absicht: eine erfundene Antwort wäre schlimmer als keine.
2. **Genau eine Tabellen- oder Graph-Sammlung** — Werkzeugmodus mit fest gebundener
   Sammlung und nur dem passenden Werkzeug (`sql_ausfuehren` bzw. `cypher_ausfuehren`).
3. **Mehrere Sammlungen** — Werkzeugmodus mit den Werkzeugen der vorhandenen Typen. Das
   Modell wählt anhand von Name, Beschreibung und Schema selbst aus, wo es sucht, und darf
   mehrere Sammlungen auf einmal nehmen.

Im Werkzeugmodus *muss* der erste Schritt ein Werkzeugaufruf sein — sonst könnte das
Modell antworten, ohne eine Zeile gesehen zu haben. Danach darf es nachfassen: bis zu
drei Schritte, wenn nur gesucht wird, bis zu sechs, sobald SQL oder Cypher im Spiel ist,
damit eine am Schema gescheiterte Abfrage nach der Fehlermeldung korrigiert werden kann.

Unter der Antwort steht bei SQL und Cypher ein Block **Abfragen**: je Schritt die
Abfrage, die Sammlung, die Zeilenzahl und eine Vorschau der ersten Zeilen — bei Fehlern
die Meldung. Die Abfrage ist dort der Beleg: Wer der Zahl nicht traut, liest die Abfrage.
Die Schritte werden mit der Nachricht gespeichert (`messages.steps`) und erscheinen im
Verlauf wieder.

Zwei Eigenheiten des Werkzeugmodus, die man kennen sollte:

- **Modellhebung.** Pläne mit Gemini 2.5 Flash Lite werden im Werkzeugmodus auf Gemini
  2.5 Flash gehoben; alle anderen Modelle — auch alle direkt angebundenen — bleiben, wie
  der Plan sie vorgibt. Grund: Flash Lite liefert nach einem Werkzeugergebnis regelmäßig
  leeren Text statt einer Antwort ([vercel/ai#13017](https://github.com/vercel/ai/issues/13017)).
  Das kostet je Token etwa das Drei- bis Sechsfache (Eingabe 0,10 → 0,30 $, Ausgabe
  0,40 → 2,50 $ je Mio.). Verbucht wird das tatsächlich genutzte Modell, nicht das des
  Plans. Die Hebung ist fest kodiert (`lib/models.ts`) und betrifft ausschließlich diese
  eine Kennung; Gemini 2.5 Flash sollte deshalb im Katalog bleiben.
- **Nachtrag bei leerem Abschlusstext.** Endet ein Lauf nach Werkzeugergebnissen ohne
  ein Wort Antwort — auch dann, wenn die Schrittgrenze mitten in den Abfragen greift —,
  folgt ein weiterer Modellaufruf mit dem bisherigen Verlauf und der Bitte, die
  Ergebnisse zusammenzufassen; Werkzeuge sind dabei gesperrt. Beide Aufrufe landen in
  einer Verbuchung.

Antworten werden als Markdown dargestellt. Rohes HTML wird dabei bewusst **nicht**
ausgeführt, sondern als Text angezeigt — der Antworttext ist über die hochgeladenen
Dokumente beeinflussbar, und genau dort wäre sonst ein Einfallstor.

**Sammlungen** (`/sammlungen`) — Anlegen, Dateien einpflegen, entfernen. Beim Anlegen
sind vier Angaben zu machen: der Typ (Dokumente, Tabellen oder Graph), Name, eine
Beschreibung des Inhalts, und bei Dokumentensammlungen die Art der Unterlagen. Der Typ
lässt sich nachträglich nicht ändern.

Die Beschreibung ist kein Zierfeld. Sie ist die Grundlage, auf der das Modell entscheidet,
ob eine Sammlung zur Frage passt — eine Sammlung ohne Beschreibung ist dort praktisch
unsichtbar. Wer keine hinterlegt, bekommt nach dem ersten Dokument einen Vorschlag.

Tabellen- und Graph-Sammlungen zeigen in der Detailansicht ihr **Schema**: Tabellen mit
Spalten, Typen, Zeilenzahl und Beispielwerten bzw. Labels, Beziehungstypen und
Eigenschaften des Graphen. Dasselbe Schema bekommt das Modell in der Systemanweisung —
ohne es könnte es keine Abfrage formulieren, die trifft.

**Administration** (`/admin`) — nur mit Rolle. Größenklassen und Pläne bearbeiten, den
Modellkatalog und Anbieter-Keys pflegen, Nutzer einladen, Nutzern Pläne zuweisen,
Verbrauch einsehen.

---

## Drei Arten von Sammlungen

| | Dokumente (`vector`) | Tabellen (`sql`) | Graph (`graph`) |
|---|---|---|---|
| **Eingabe** | PDF, DOCX, XLSX, MP3 (wird transkribiert) | CSV mit Kopfzeile; `;` oder `,` als Trenner, Dezimalkomma wird erkannt | `.cypher`, `.cql`, `.txt` mit `CREATE`/`MERGE`-Statements, durch `;` getrennt |
| **Speicher** | Pinecone-Namespace je Sammlung | SQLite-Datei in Blob (`files/<userId>/<collectionId>/_db/sammlung.sqlite`), isolierte Worker im separaten SQL-Dienst | FalkorDB-Graph `c_<collectionId>` |
| **Abfrage der KI** | `dokumente_durchsuchen` (semantische Suche) | `sql_ausfuehren` — SQLite-Dialekt, ein `SELECT`/`WITH` | `cypher_ausfuehren` — openCypher, `GRAPH.RO_QUERY` |
| **Grenzen je Datei** | MB/Datei und Seiten der Größenklasse | zusätzlich 20 MB, 200.000 Zeilen, 200 Spalten; SQLite-Datei der Sammlung höchstens 50 MB | zusätzlich 5 MB, 5.000 Statements; FalkorDB-Free-Tier 100 MB für alle Graphen zusammen |
| **Löschen einer Datei** | Abschnitte per Präfix `<docId>#` aus dem Namespace | Tabelle gedroppt, Datei zurückgeschrieben | Graph gelöscht und aus den übrigen Skripten neu aufgebaut |
| **Seiten fürs Kontingent** | echte bzw. geschätzte Seiten (siehe [Grenzen](#grenzen)) | Zeilen ÷ 50 | Zeichen ÷ 3.000 |

Zwei Dinge sind bei Tabellen und Graphen anders als bei Dokumenten:

**Eine Datei je Tabelle.** Der Tabellenname entsteht aus dem Dateinamen
(`Umsatz 2025.csv` → `umsatz_2025`). Wer dieselbe Datei erneut hochlädt, ersetzt die
Tabelle — und der frühere Satz in der Übersicht weicht, damit die Zähler stimmen.
Spaltennamen werden zu sicheren Bezeichnern (klein, `[a-z0-9_]`, Umlaute aufgelöst), je
Spalte wird der engste passende Typ bestimmt (`INTEGER`, `REAL`, `TEXT`).

**Ein Graph je Sammlung, Skripte in Reihenfolge.** Spätere Skripte dürfen auf Knoten
früherer verweisen. Deshalb wird beim Löschen eines Skripts — und nach einem
fehlgeschlagenen Import — der Graph aus den übrigen Skripten in Upload-Reihenfolge neu
aufgebaut; ein halb eingespieltes Skript bleibt nie liegen.

### Sicherheitsmodell der Werkzeuge

Was das Modell an Abfragen formuliert, stammt aus einem Text, den hochgeladene Dateien
mitbeeinflussen. Die Werkzeuge behandeln es deshalb wie Nutzereingaben:

- **Allowlist je Sitzung.** Jeder Aufruf prüft die `collectionId` gegen die auf den Nutzer
  gefilterten Sammlungen, zusätzlich gegen den Typ. Bei genau einer Sammlung ist sie fest
  gebunden; eine trotzdem mitgeschickte ID wird ignoriert. Ablehnungen kommen als
  Rückgabewert `{ ok: false, error }`, damit das Modell sich korrigieren kann.
- **SQL nur lesend.** Genau ein Statement, es muss mit `SELECT` oder `WITH` beginnen, kein
  Semikolon, keine Schreibbefehle, kein `PRAGMA`, kein `ATTACH` (Schlüsselwörter werden
  außerhalb von Literalen und Kommentaren geprüft). Die Abfrage wird in
  `SELECT * FROM (…) LIMIT 200` gehüllt. Und selbst wenn etwas durchkäme: Die Datenbank
  ist eine Wegwerf-Kopie im Speicher, die nach dem Aufruf geschlossen wird.
- **Cypher nur lesend.** `GRAPH.RO_QUERY` — der Server lehnt Schreiboperationen ab —, ein
  Statement, 10 Sekunden Timeout, `LIMIT 200` wird ergänzt, falls es fehlt. Der Graphname
  entsteht aus der geprüften Sammlungs-ID, eine Abfrage kann nie über Sammlungen hinweg
  lesen.
- **Begrenzte Schritte und Größen.** Höchstens 6 Schritte je Frage, Abfragen bis 4.000
  Zeichen, Ergebnisse werden auf 24.000 Zeichen im Prompt gekürzt, Zellen auf 200 Zeichen;
  in den Browser gehen höchstens 20 Vorschauzeilen.

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
| S | S | 3 | 200 | Gemini 2.5 Flash Lite |
| M | M | 10 | 1.000 | Gemini 2.5 Flash Lite |
| L | L | 25 | 5.000 | Gemini 2.5 Flash |
| XL | XL | 100 | 25.000 | GPT-5 mini |

Alle Werte sind im Admin-Bereich zur Laufzeit änderbar; sie stehen deshalb in Tabellen und
nicht im Code. Eine Zuweisung greift sofort, eine Änderung an der Plan-Definition
innerhalb einer Minute — der Nutzerkontext liegt so lange im Zwischenspeicher. Zur Auswahl
stehen die aktiven Modelle des Katalogs (Abschnitt [KI-Modelle pflegen](#ki-modelle-pflegen));
ein Plan lässt sich nur mit einem vorhandenen, aktiven Modell speichern.

---

## Nutzer einladen

Der Abschnitt **Einladungen** im Admin-Bereich holt Personen gezielt in die App. Der Admin
trägt eine E-Mail-Adresse ein und wählt den Plan, den die Person nach der Registrierung
haben soll (vorausgewählt ist der Standardplan). Clerk verschickt daraufhin eine E-Mail
mit einem Link, der zur Registrierungsseite (`/sign-up`) führt; die Adresse ist dort
bereits eingetragen und bestätigt.

Der Ablauf im Einzelnen:

1. **Einladen.** Die Adresse wird normalisiert (getrimmt, kleingeschrieben) und der Plan
   gegen die vorhandenen Pläne geprüft. Liegt für die Adresse schon eine offene
   Einladung oder ein Konto vor, lehnt Clerk ab — die Meldung sagt, was zu tun ist.
2. **Link als Rückfallebene.** Nach dem Anlegen zeigt die Karte den Einladungslink zum
   Kopieren. Es ist derselbe Link wie in der E-Mail; er hilft, wenn die Mail im
   Spam-Ordner landet oder gar nicht ankommt.
3. **Plan übernehmen.** Der gewählte Plan reist als `publicMetadata.planId` mit der
   Einladung. Bei der Registrierung kopiert Clerk diese Metadaten in das Nutzerkonto,
   und der Webhook (`user.created`) legt die Nutzerzeile mit genau diesem Plan an.
   Existiert der Plan inzwischen nicht mehr, gilt der Standardplan. Der Fallback, der
   die Nutzerzeile ohne Webhook beim ersten Zugriff nachzieht, liest dasselbe Feld —
   die Vorgabe geht also auch dann nicht verloren, wenn die erste Seite des neuen
   Nutzers schneller ist als die Zustellung des Webhooks.
4. **Gültigkeit.** Eine Einladung gilt **14 Tage**. Danach verfällt der Link; die Person
   muss neu eingeladen werden.
5. **Widerrufen.** Offene Einladungen stehen in der Tabelle mit Plan, Erstelldatum und
   Ablauf. *Widerrufen* macht den Link unbrauchbar — hindert die Person aber nicht an
   einer normalen Registrierung, solange diese offen ist (siehe unten).

**Nur Eingeladene zulassen.** Standardmäßig kann sich bei Clerk jeder registrieren; die
Einladung ist dann nur eine Abkürzung mit Plan-Vorgabe. Soll die App ausschließlich
Eingeladenen offenstehen, im Clerk-Dashboard unter **Configure → Restrictions** den
Sign-up-Modus auf **Restricted** stellen. Die Registrierungsseite bleibt dann für alle
anderen gesperrt, Einladungslinks funktionieren weiter.

Was noch im Clerk-Dashboard liegt: Absender und Text der Einladungs-E-Mail unter
**Customization → Emails** (Vorlage *Invitation*); in Produktionsinstanzen verschickt Clerk
nur über eine verifizierte eigene Domain. Die Liste offener Einladungen kommt bei jedem
Aufruf des Admin-Bereichs direkt von Clerk; ist Clerk nicht erreichbar, bleibt der Rest
der Konsole bedienbar und die Karte zeigt einen Hinweis.

---

## KI-Modelle pflegen

Der Abschnitt **KI-Modelle** im Admin-Bereich ersetzt die früher fest kodierte
Modellliste. Er besteht aus zwei Teilen.

**Anbieter-Keys.** Je Anbieter (Anthropic, OpenAI) kann ein eigener API-Key hinterlegt
werden. Er wird mit AES-256-GCM verschlüsselt in `provider_keys` abgelegt; der Schlüssel
dazu wird per HKDF aus `PROVIDER_KEY_SECRET` abgeleitet. Die Oberfläche zeigt nur eine
Maske (`sk-ant-…7f3a`) und den Zeitpunkt der letzten Änderung; der Klartext verlässt den
Server nie — nicht in Antworten, nicht in Logs, nicht in Fehlermeldungen. „Verbindung
testen" schickt einen Mini-Aufruf an den Anbieter, wahlweise mit dem gerade eingegebenen,
noch nicht gespeicherten Key. Fehlt `PROVIDER_KEY_SECRET`, zeigt die Karte das an, und
Keys lassen sich nicht speichern; der Katalog funktioniert dann mit Gateway-Modellen.

**Modellkatalog** (Tabelle `models`). Jeder Eintrag hat eine Kennung der Form
`<präfix>/<native-id>` (z. B. `anthropic/claude-sonnet-4-5`, `google/gemini-2.5-flash`),
einen Anbieter, eine Bezeichnung, drei Preise in US-Dollar je 1 Mio. Token (Eingabe,
Ausgabe, Cache-Treffer), eine Sortierung und die Marke **aktiv**. Nur aktive Modelle
stehen den Plänen zur Auswahl; ohne Eingabe- und Ausgabepreis lässt sich ein Modell nicht
aktiv setzen, weil der Verbrauch sonst mit 0 $ verbucht würde. Ein Modell, das ein Plan
nutzt, kann weder gelöscht noch deaktiviert werden.

Neue Einträge kommen auf zwei Wegen: als **eigene Kennung** von Hand oder über **Modelle
vom Anbieter laden**. Letzteres holt mit dem hinterlegten Key die Modell-Liste von
Anthropic (`GET /v1/models`) bzw. OpenAI (`GET /v1/models`, gefiltert auf Chat-Modelle),
oder die Sprachmodelle des öffentlichen Gateway-Katalogs. Die Preise werden dabei aus
`GET https://ai-gateway.vercel.sh/v1/models` vorbelegt — dort stehen sie in US-Dollar je
Token als Zeichenkette (`"input": "0.000003"`), die App rechnet auf je 1 Mio. Token um.
Kennungen werden tolerant zugeordnet (Anthropic liefert `claude-sonnet-4-5-20250929`, der
Gateway-Katalog führt `claude-sonnet-4.5`). Fehlt ein Treffer, bleibt der Preis 0 und das
Modell wird inaktiv aufgenommen, bis jemand die Preise einträgt.

**Routing.** Der Anbieter eines Katalogeintrags entscheidet, wohin der Aufruf geht:

| Anbieter im Katalog | Key hinterlegt | Weg |
|---|---|---|
| AI Gateway | — | `gateway("<kennung>")` |
| Anthropic / OpenAI | ja | direkt per `@ai-sdk/anthropic` bzw. `@ai-sdk/openai` mit der nativen Kennung hinter dem `/` |
| Anthropic / OpenAI | nein | Gateway, als Rückfall |

Die Spalte **Anbindung** in der Tabelle zeigt den tatsächlichen Weg. Bei direkter
Anbindung muss die Kennung mit dem Anbieterpräfix beginnen (`anthropic/…`); die Kosten
werden in beiden Fällen mit den Katalogpreisen verbucht. Der Katalog liegt eine Minute im
Zwischenspeicher (Redis, wie der Nutzerkontext) und wird nach jeder Admin-Änderung
verworfen; der entschlüsselte Key wird je Instanz eine Minute im Prozess gehalten — nicht
in Redis, denn dort gehört kein Klartext hin. Ein neuer oder gelöschter Key greift auf
anderen Instanzen deshalb erst nach bis zu einer Minute.

Die drei Startmodelle (Gemini 2.5 Flash Lite, Gemini 2.5 Flash, GPT-5 mini) legt der Seed
mit ihren bisherigen Preisen als Gateway-Einträge an. Trägt ein Plan eine Kennung, die
nicht mehr im Katalog steht, antwortet der Chat mit dem Standardmodell
(`google/gemini-2.5-flash-lite`).

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

**Expertenmodus** — Unter den Preset-Karten lässt sich beim Anlegen ein zugeklappter
Bereich öffnen, in dem Abschnittsgröße, Überlappung, Treffer je Suche (topK) und die
Mindest-Ähnlichkeit für diese Sammlung übersteuert werden können. Gespeichert wird nur die
Abweichung vom Preset (`collections.processing`, JSON); `effektiveVerarbeitung` in
`lib/presets.ts` legt beides übereinander. Sammlungen ohne Abweichung folgen damit weiterhin
späteren Anpassungen der Presets. Die Grenzen stehen in `VERARBEITUNG_GRENZEN`; die
Überlappung muss unter der halben Abschnittsgröße bleiben, sonst kriecht die Zerlegung
zeichenweise voran.

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
npm test                  # Vitest: CSV, Cypher-Skripte, SQL-Sperre, Werkzeuge, Katalog, Chunker, Modelle, Keys
npm run typecheck
npm run lint
```

Die `pruefe:*`-Skripte sind bewusst ohne Testframework: Es geht um zwei Sätze reiner
Funktionen, und beide sind die Stellen, an denen ein Fehler teuer wird. Die Zerlegung
entscheidet, was zitiert wird, die Kontingente entscheiden, was ein Nutzer anlegen darf.
Ein Fehler dort fällt entweder nie auf, weil zu lasch, oder erst beim Nutzer, weil zu
streng.

Die Kontingentprüfung testet ausdrücklich die Grenzen selbst — genau am Limit muss es noch
gehen, einen Schritt darüber nicht mehr.

Mit den Sammlungstypen kam Vitest dazu (`tests/`). Dort liegt, was sich ohne Dienste
prüfen lässt: das CSV-Lesen samt Typerkennung und deutscher Zahlen, das Zerlegen von
Cypher-Skripten, die Lese-Sperre für SQL (was durchkommt und was nicht), die
Werkzeug-Allowlist, der Katalog in der Systemanweisung und der Chunker. sql.js läuft
dabei gegen eine In-Memory-Datenbank, Blob und FalkorDB sind gemockt. Mit dem
Modellkatalog kamen die Verschlüsselung der Anbieter-Keys, die Kostenrechnung mit
Katalogpreisen, die Routing-Entscheidung, die Umrechnung der Gateway-Preise und die
tolerante Kennungs-Zuordnung dazu; die Key-Verwaltung läuft gegen eine Tabelle im
Speicher.

---

## Aufbau

```
app/
  page.tsx                        Chat
  sammlungen/                     eigene Sammlungen, Detailansicht mit Upload
  sammlungen/actions.ts           Server Actions: Sammlung anlegen, Name und Beschreibung ändern
  admin/                          Größenklassen, Pläne, KI-Modelle, Einladungen, Nutzer, Verbrauch
  admin/actions.ts                Server Actions aller Admin-Mutationen (ein Roundtrip, Seite kommt frisch zurück)
  sign-in/ · sign-up/             Clerk
  api/chat/                       Retrieval, Werkzeugmodus, Antwort-Streaming (NDJSON)
  api/chats/                      Verlauf
  api/collections/                Sammlungen lesen und löschen, Upload-Anmeldung
  api/documents/                  Verarbeitung, Löschen je Typ, Download
  api/admin/                      lesende Routen zu Stammdaten, Modellkatalog, Anbieter-Keys, Einladungen; Key-Test, Diagnose
  api/upload/                     Token für den Direkt-Upload zu Vercel Blob
  api/webhooks/clerk/             Nutzerdaten spiegeln
  api/cron/aufraeumen/            stündlicher Aufräumlauf
proxy.ts                          stellt die Clerk-Sitzung bereit
workflows/
  ingest.ts                       Verarbeitung je Typ in wiederholbaren Schritten, Sperre je Sammlung
  aufraeumen.ts                   Abräumen nach dem Löschen eines Kontos
components/
  ChatBereich.tsx · ChatPanel.tsx Chat mit Fundstellen und Abfragen-Block
  SammlungenBereich.tsx           Anlegen mit Typwahl, Upload je Typ
  SchemaCard.tsx                  Tabellen bzw. Labels einer Sammlung
  BestaetigungsDialog.tsx         Löschbestätigungen als natives <dialog> statt window.confirm
lib/
  db/                             Drizzle-Schema, Verbindung, Seed
  auth/user.ts                    Clerk-Identität zu Plan, Rolle, Größenklasse
  api.ts · aktionen.ts            Fehler → HTTP-Antwort bzw. → Rückgabewert einer Server Action
  collection-kinds.ts             die drei Typen: Labels, Endungen, Schema-Typen
  collections.ts · documents.ts   Sammlungen und Dokumente, Nutzer-ID stets in der Abfrage
  vector.ts                       Pinecone: schreiben, suchen, löschen
  sqlstore.ts                     SQLite-Datei in Blob, sql.js, Lese-Sperre für SQL
  graphstore.ts                   FalkorDB: importieren, beschreiben, lesend abfragen
  csv.ts · cypher-script.ts       CSV → Tabelle, Skript → Statements, Grenzen
  ingest.ts                       Einspielen und Entfernen je Typ (ohne Request, ohne Sperre)
  ai.ts                           Modellzugriff (direkt oder Gateway), Systemanweisung, Katalog, Suchwerkzeug
  tools.ts · tools-types.ts       Werkzeuge sql_ausfuehren, cypher_ausfuehren, Schritt-Ereignisse
  presets.ts · chunk.ts           die drei Verarbeitungsarten
  extract.ts                      PDF · DOCX · XLSX → Text und Seitenzahl
  mp3-teile.ts · transcribe.ts    MP3-Rahmenplan, Transkription (Gateway), Zeitversatz
  quota.ts · ratelimit.ts         Grenzen, Drosselung, Schreibsperre (SET NX EX)
  chats.ts · chatVerlauf.ts       Verlauf, Server und Client-Fassade
  admin.ts · models.ts            Stammdaten, Modellkatalog-Pflege, Kostenrechnung, Modellhebung
  modellkatalog.ts                Katalog aus Postgres mit Zwischenspeicher, Rückfall auf Standard
  provider-keys.ts · crypto.ts    Anbieter-Keys verschlüsselt speichern, maskieren, laden
  einladungen.ts                  Clerk-Einladungen anlegen, auflisten, widerrufen; Plan aus der Einladung
  anbieter-modelle.ts             Modell-Listen von Anthropic/OpenAI, Preise aus dem Gateway-Katalog
  aufraeumen.ts                   Überreste des laufenden Betriebs
tests/                            Vitest (npm test)
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
es per Prompt-Injection dazu verleitet, kommt sie nicht durch. Für `sql_ausfuehren` und
`cypher_ausfuehren` gilt dieselbe Allowlist, zusätzlich mit Typprüfung; die Abfrage selbst
wird obendrein auf Lesezugriff beschränkt (siehe
[Sicherheitsmodell der Werkzeuge](#sicherheitsmodell-der-werkzeuge)).

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

**Modell-Routing berücksichtigt auch Quoten.** Vor Änderungen die tatsächlichen
Account-, Modell- und Gatewaylimits prüfen. Mehrere Modelle bedeuten nicht automatisch
einen entsprechend höheren verfügbaren Gesamtdurchsatz.

---

## Betrieb

### Vor dem Produktivgang

**Fluid Compute und Dienstregionen prüfen.** `vercel.json` aktiviert Fluid für neue
Deployments. Kontrollieren, dass die Einstellung im konkreten Projekt greift und dass
Datenbanken, SQL-Dienst und Chat in passenden Regionen laufen. Gemeinsame Instanzen
können die vielen wartenden Streams effizienter bedienen.

**Modellquoten bestätigen lassen.** Bei 1.000 laufenden Antworten und durchschnittlich
30 Sekunden Antwortdauer entstehen etwa 2.000 neue Fragen/min. Bei 600 Ausgabetokens je
Antwort sind das 1,2 Mio. Ausgabetokens/min plus Eingabe und Werkzeugschritte. Diese
Beispielrechnung ersetzt keine Messung. Die konservativen Modellbudgets der App müssen
auf die bestätigte Anbieterleistung abgestimmt werden.

**Ein eigenes Spend-Limit setzen**, unterhalb des Tier-Caps. Es ist die letzte Notbremse,
wenn Kontingente und Drosselung nicht greifen.

**Fragen, laufende Arbeit und Tokens begrenzen.** `GLOBAL_QUESTIONS_PER_MINUTE` ergänzt
die Plan-Kontingente; `*_MAX_CONCURRENT` steuert laufende Arbeit. Rollende Modellbudgets
zählen jeden Schritt und jede Wiederholung. Uploads haben zusätzliche Teilbudgets.
Siehe [.env.example](.env.example) und [Betriebsanleitung](docs/scaling-and-chat.md).

### Nach dem Deployment: Diagnose

```
GET /api/admin/diagnose        (als Admin angemeldet)
```

Antwortet mit vier Dingen, die sich sonst erst beim ersten Nutzer zeigen: ob sql.js samt
WASM-Datei geladen werden konnte (mit SQLite-Version), ob `FALKORDB_URL` gesetzt ist, ob
`PROVIDER_KEY_SECRET` gesetzt ist (`providerKeySecretKonfiguriert`), und welche
Umgebungsvariablen die Instanz sieht — nur Namen, keine Werte.

Der erste Punkt ist der heikle. sql.js liest seine WASM-Datei zur Laufzeit per `fs`, und
das File Tracing von Vercel sieht diesen Zugriff nicht. `next.config.ts` nimmt die Datei
deshalb über `outputFileTracingIncludes` ausdrücklich mit — für `/api/**` *und* für
`/.well-known/workflow/**`, denn die Verarbeitungsschritte des Workflow SDK laufen unter
dem zweiten Pfad. Meldet die Diagnose `sqlJs.ok: false`, fehlt genau das. Zusätzlich
stehen `sql.js` und `falkordb` in `serverExternalPackages`, damit der Bundler sie in Ruhe
lässt.

### Lasttest

```bash
npm run lasttest -- --url https://staging.example.org \
  --identities-file /private/tmp/lasttest-identities.json \
  --stages 100,250,500,1000 --dry-run
```

Die private Fixture braucht pro gleichzeitigem Stream ein anderes Testkonto mit gültiger
Sitzung und passenden Sammlungen. Ohne `--run` wird nur die Fixture geprüft. Mit `--run`
erstellt der Test Chats und hält die eingestellte Zahl offener Anfragen; `--burst` startet
genau eine Frage je Konto gleichzeitig. Fehlerereignisse, fehlendes `done`, leere Antworten
und `done.status` werden geprüft. Modellantworten werden getrennt von statischen
Antworten und Replays ausgewiesen.

Jede Frage kostet echtes Geld und verbraucht das Tageskontingent des Kontos. Klein
anfangen.

Anleitung für Dauerlast, gleichzeitigen Start von 1.000 Anfragen, Referenzfragen und
Messgrößen: [Lastabnahme](docs/scaling-and-chat.md#messung-und-abnahme). Lokale Tests
belegen die Schutzmechanismen, nicht die Produktivkapazität.

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
- **MP3 wird transkribiert** (AI Gateway, `openai/whisper-1`, sonst ein hinterlegter
  OpenAI-Key). Die Transkriptions-API nimmt höchstens 25 MB je Aufruf; größere Dateien
  teilt die App intern an MPEG-Rahmen. Die Upload-Grenze bleibt die der Größenklasse.
  Fundstellen zitieren Zeitspannen (`3:12–4:45`). Stille oder Musik ohne Sprache
  scheitert mit einer klaren Meldung, analog zu einem Scan-PDF.
- **Alte Binärformate `.doc` und `.xls`** werden nicht unterstützt. Einmal als `.docx`
  bzw. `.xlsx` speichern genügt.
- **Seitenzahlen bei DOCX, XLSX und MP3 sind Schätzungen.** DOCX kennt keine Seiten — der
  Umbruch entsteht erst beim Druck. Für die Kontingentprüfung wird gerechnet: 3.000
  Zeichen bzw. 50 Tabellenzeilen je Seite. Beim Transkript gilt dieselbe Zeichenzahl.
- **Sammlungen sind nicht teilbar.** Jede gehört genau einem Nutzer. Team-Freigaben wären
  über Clerk-Organisationen möglich, brauchen aber das B2B-Add-on.
- **Das Verarbeitungspreset lässt sich nachträglich nicht ändern.** Es müssten alle
  Dokumente der Sammlung neu zerlegt werden; einfacher ist eine neue Sammlung. Dasselbe
  gilt für den Typ einer Sammlung und für die Werte aus dem Expertenmodus.
- **Graph-Import nur über Cypher-Skripte.** Kein CSV-zu-Graph, kein GraphML, kein
  Neo4j-Dump. FalkorDB versteht eine Teilmenge von openCypher — Prozeduren wie `apoc.*`
  gibt es nicht, und ein Skript, das darauf baut, scheitert beim Import mit der
  Statement-Nummer.
- **SQL im SQLite-Dialekt.** Kein `ILIKE`, keine `::`-Casts, `strftime` statt
  `date_trunc`. Zellen kommen aus CSV als `INTEGER`, `REAL` oder `TEXT`; Datumswerte
  bleiben Text.
- **Höchstens 200 Zeilen je Abfrage**, bei SQL wie bei Cypher. Wer eine ganze Tabelle
  will, bekommt einen Ausschnitt — das Modell soll in SQL bzw. Cypher aggregieren und
  filtern, nicht Zeilen lesen.
- **Ohne Redis keine Tabellen- und Graph-Uploads.** Die Schreibsperre je Sammlung liegt in
  Redis, und es gibt bewusst keinen Weg daran vorbei: Eine Sperre, die nicht sperrt, wäre
  schlimmer als ein Abbruch.
- **Der Werkzeugmodus kostet mehr als die Direktsuche.** Mindestens zwei
  Modelldurchläufe statt einem, dazu die Modellhebung für Flash-Lite-Pläne; siehe
  [Bedienung](#bedienung).
- **Contextual Retrieval ist nicht eingebaut.** Eine LLM-generierte Kontextzeile pro
  Abschnitt verbessert die Trefferqualität deutlich, kostet bei diesem Mengenzuschnitt
  aber einen Modellaufruf pro Abschnitt.
