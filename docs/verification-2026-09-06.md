# Prüfung der Geschwindigkeitsarbeiten vom 6. September 2026

Ausgangslage: Produktion lief vom Branch `claude/rag-chatbot-document-admin-pv6ut8`, `main`
wurde per Fast-Forward auf diesen Stand gehoben; alle weiteren Änderungen liegen auf
`main`. Die Datenbank ist bereits auf Migration `0004`; es kam keine neue Migration hinzu.

## Vorher: gemessen in Produktion (Vercel-Laufzeitlogs, `chat_run`)

Modell `anthropic/claude-opus-5`, Functions in `iad1`, Nutzer in Deutschland.

| Fall | erstes Zeichen | Gesamtdauer | Vorlauf bis Modellstart | Modellaufrufe | Cache-Treffer |
|---|---|---|---|---|---|
| Dokumente | 10,5 s | 11,2 s | 2,7 s | 2 | 0 |
| Dokumente | 11,1 s | 11,8 s | 2,3 s | 2 | 0 |
| Graph | 15,6 s | 16,3 s | 2,6 s | 2 | 0 |
| Graph | 19,7 s | 20,6 s | 2,3 s | 2 | 0 |
| Graph | 20,6 s | 21,3 s | 2,5 s | 3 | 0 |

Der Vorlauf bestand aus rund sechzehn Aufrufen nacheinander gegen Redis und Postgres zu
je etwa 150 ms; Seiten und Admin-Speichern trugen dieselbe Latenz je Aufruf.

## Was sich geändert hat

1. Messpunkte: `page_render`, `action`; `chat_run` mit `preflightMs`, je Modellaufruf
   Wartezeit, erstes Token, Dauer, Dauer je Werkzeug.
2. Chat-Route: Antwort sofort, Vorlauf in einem Batch parallel zur Sperre; Schreiben,
   Kontingent, Zulassung und Katalog parallel; Kontingente in einer Redis-Pipeline.
   Ablehnungen nach dem Start als `error`-Ereignis mit `reason`.
3. Reine Dokumentensammlungen (bis zu sechs) parallel und ohne Werkzeugschritt durchsucht;
   Suche startet parallel zum Vorlauf.
4. Prompt-Cache für Claude wiederhergestellt; Systemanweisung über alle Schritte
   identisch; Zwischenstände im Hintergrund statt in der Stream-Schleife.
5. Zwischenspeicher je Instanz (15 s) für Kontext, Modellkatalog, Einladungen.
6. Chat-Seite liefert Chatliste und aktiven Chat im Seitenaufbau; Kopfzeile streamt;
   Ladeansichten je Bereich.
7. Admin: nur die speichernde Karte gesperrt; Sammlung anlegen mit einem Batch.
8. FalkorDB-Client und sql.js werden erst bei Gebrauch geladen.

## Geprüft

- 426 Tests in 38 Dateien bestanden, davon Kontingent- und Zulassungsskripte gegen
  einen wegwerfbaren lokalen Redis (`REDIS_TEST_SOCKET`) und Chat-Generierung,
  Verlaufsseiten und Chat-Seiten-Batch gegen PGlite mit den echten Migrationen.
- `npm run typecheck`, `npm run lint` und `npm run build` (Next 16.3.1, Turbopack)
  erfolgreich.

Nicht durchgeführt: Deployment und Messung in Produktion. Die Nachher-Zahlen sind nach
dem ersten Deployment von `main` aus denselben `chat_run`-Zeilen zu lesen und hier
einzutragen; Zielwerte: `preflightMs` unter 800 ms ohne Regionswechsel, erstes Zeichen
bei Dokumentfragen 3 bis 4 s mit Opus und unter 2 s mit Sonnet, bei Graphfragen 6 bis 9 s.

## Schritte außerhalb des Codes

In dieser Reihenfolge, alle im jeweiligen Dashboard:

1. **Vercel → Settings → Git → Production Branch** auf `main` stellen. Bis dahin
   erzeugen Pushes auf `main` nur Preview-Deployments; die Preview-Umgebung braucht
   dieselben Variablen wie Produktion.
2. **Clerk**: Produktion läuft mit Development-Schlüsseln (die Laufzeitlogs melden
   „connected to development instances“). Eine Production-Instanz für `kb.stefanai.de`
   anlegen, Schlüssel und Webhook-Geheimnis in Vercel ersetzen.
3. **Admin → Pläne**: Sonnet 5 oder Haiku 4.5 als Planmodell wählen; Opus höchstens
   für den Modus „ausführlich“. Der größte einzelne Anteil an der Wartezeit ist das
   Modell selbst.
4. **Neon**: Scale-to-zero ausschalten oder die Ruhezeit hochsetzen, sonst wacht die
   Datenbank nach fünf Minuten Ruhe mit Verzögerung auf.
5. **Regionen** (bewusst ausgeklammert): Functions, Neon, Upstash, Pinecone und
   FalkorDB in dieselbe Region legen; ohne das bleibt jeder Aufruf eine
   Transatlantik-Runde.

Offen gelassen: ein Index auf `usage_events(day)` für die Verbrauchsübersicht. Die
Tabelle ist noch klein; die Migration würde vor dem Deployment einen zusätzlichen
`db:migrate`-Schritt verlangen und ist als Folgeschritt vorgesehen.
