# Isolierter SQL-Dienst

Dieser Node-24-Dienst wird getrennt vom Next.js-Chat betrieben. Er behaelt die
bestehenden privaten SQLite-Dateien in Vercel Blob bei. Die Haupt-App uebergibt
nur eine bereits autorisierte Sammlung und die Abfrage. SQL laeuft in einem
eigenen Worker-Thread je Auftrag, der bei Abbruch oder Zeitlimit beendet wird.

## Start

In diesem Verzeichnis `npm ci` und `npm start` ausfuehren, oder `docker compose up --build`.
Beide Wege brauchen `BLOB_READ_WRITE_TOKEN` und einen zufaelligen
`SQL_EXECUTOR_TOKEN` mit mindestens 32 Zeichen. In der Haupt-App denselben Token
und `SQL_EXECUTOR_URL` setzen, lokal etwa `http://127.0.0.1:8080`. Die App haengt
`/query` an. In Produktion einen HTTPS-Endpunkt in derselben Region verwenden;
der Dienst gehoert hinter einen privaten Zugang bzw. eine Firewall, die nur die
App zulaesst. Tokens ausschliesslich ueber den Secret-Store setzen.

`POST /query` erwartet Bearer-Authentifizierung und JSON:

```json
{"collection":{"userId":"user_1","id":"collection_1","sqlBlobPath":"files/user_1/collection_1/_db/sammlung.sqlite"},"query":"SELECT COUNT(*) FROM umsatz"}
```

Der Pfad muss exakt zur Sammlung gehoeren; URLs und andere Pfade werden
abgewiesen. Der Dienst ist kein oeffentlicher Benutzer-Endpunkt: Die App muss
die Sammlung vorher gegen die aktuelle Berechtigung des Nutzers pruefen.
Die Antwort behaelt `columns`, `rows`, `rowCount`, `truncated` bei.

## Grenzen je Replikat

| Einstellung | Standard |
|---|---:|
| `PORT` | 8080 |
| `SQL_WORKER_CONCURRENCY` | 2 aktive Auftraege |
| `SQL_WORKER_QUEUE` | 16 wartende Auftraege |
| `SQL_WORKER_QUEUE_TIMEOUT_MS` | 5.000 ms |
| `SQL_WORKER_TIMEOUT_MS` | 8.000 ms einschliesslich Worker-Start |
| `SQL_WORKER_CACHE_MIB` | 128 MiB |

Blob-Laden hat zusaetzlich 10 Sekunden Zeit. Dateien werden beim Stream-Lesen
auf 50 MiB begrenzt; Anfragekoerper auf 24 KiB, SQL auf 4.000 Zeichen, Ergebnisse
auf 200 Zeilen, 100 Spalten und 256 KiB. Eine volle/zu langsame Warteschlange
antwortet mit 429 und `Retry-After: 2`. Keine automatischen Wiederholungen.

Jeder Cache-Zugriff revalidiert die konkrete ETag am Blob-Ursprung mit
`useCache: false` und `If-None-Match`. Nur ein passendes 304 verwendet die Bytes
erneut. Ueberschreiben und Loeschen werden damit beim naechsten Zugriff erkannt;
bei Fehlern werden keine alten Daten geliefert. Der LRU-Cache ist nach Bytes
begrenzt und durch den geprueften Mandantenpfad getrennt.

**Speicher muss auch auf Betriebssystemebene begrenzt werden.** Node
`resourceLimits` begrenzt den JS-Heap, nicht den WASM-Speicher. Der Worker setzt
zusaetzlich SQLite `hard_heap_limit` auf 128 MiB; das ersetzt keine Containergrenze.
Die Compose-Konfiguration setzt deshalb 1 GiB, 2 CPUs und 64 Prozesse/Threads
pro Replikat. Diese Limits beim produktiven Containeranbieter ebenfalls setzen.
Die 2-Worker-Vorgabe erst nach Speicher- und CPU-Messungen erhoehen. Fuer mehr Last
Replikate hinter dem internen Load-Balancer ergaenzen; Warteschlange und Grenzwerte
gelten je Replikat und muessen mit der globalen Zulassung der Haupt-App abgestimmt
werden. Ein einzelnes Replikat ist kein Nachweis fuer 1.000 laufende Antworten.

`GET /healthz` meldet nur die Erreichbarkeit. Fuer die Abnahme Worker-Zeitlimits,
429/5xx, CPU/RAM, OOM-Neustarts und Queuezeit beim Containeranbieter beobachten.
