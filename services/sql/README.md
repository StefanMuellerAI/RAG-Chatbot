# Isolierter SQL-Dienst

Dieser Node-24-Dienst laeuft als eigener, privater Service im selben Vercel-Projekt
wie der Next.js-Chat. Er behaelt die
bestehenden privaten SQLite-Dateien in Vercel Blob bei. Die Haupt-App uebergibt
nur eine bereits autorisierte Sammlung und die Abfrage. SQL laeuft in einem
eigenen Worker-Thread je Auftrag, der bei Abbruch oder Zeitlimit beendet wird.

## Deployment auf Vercel

Die `services`-Konfiguration in der `vercel.json` im Repository-Hauptverzeichnis
baut den Next.js-Service `web` und den SQL-Service `sql` gemeinsam. Fuer SQL wird
`Dockerfile.vercel` verwendet. Nur `web` hat eine oeffentliche Rewrite-Regel;
`sql` ist ausschliesslich ueber das von `web` deklarierte Service-Binding erreichbar.
Vercel erzeugt daraus `SQL_EXECUTOR_URL` zur Laufzeit passend zum jeweiligen
Deployment. Diese URL nicht manuell in den Projekteinstellungen setzen.

Vor dem Deployment folgende Umgebungsvariablen in den Vercel-Projekteinstellungen
fuer die jeweilige Umgebung hinterlegen:

- `BLOB_READ_WRITE_TOKEN`: Zugriff auf den privaten Blob-Store der App.
- `SQL_EXECUTOR_TOKEN`: zufaelliger geheimer Token mit mindestens 32 Zeichen,
  der beiden Services zur Verfuegung steht. Die Bearer-Pruefung bleibt auch bei
  privaten Service-Aufrufen aktiv.
- `PORT=8080`: Vercel muss den HTTP-Port des Containers kennen. `EXPOSE` allein
  konfiguriert den Vercel-Zielport nicht; ohne `PORT` verwendet Vercel Port 80.

Das Deployment erfolgt aus dem Repository-Hauptverzeichnis. Fuer lokale
Vercel-Befehle CLI 59.11.7 verwenden, zum Beispiel `npx vercel@59.11.7`.
CLI 53.4.0 kennt die benoetigten privaten
Bindings und die Container-Konfiguration noch nicht. Die bisherige
`experimentalServices`-Konfiguration ist fuer dieses Setup nicht vorgesehen.

Preview-Deployments brauchen ihre eigenen passenden Umgebungsvariablen. Ein
Preview-Binding verweist auf den SQL-Service desselben Previews, nicht auf
Produktion. Bindings stehen Functions zur Laufzeit zur Verfuegung, nicht beim
Build oder in Middleware. Die SQL-Function ist auf 30 Sekunden begrenzt; die
engeren Zeitlimits fuer Warteschlange, Blob-Zugriff und Worker bleiben aktiv.

Siehe [Vercel Services](https://vercel.com/docs/services),
[private Service-Bindings](https://vercel.com/docs/services/bindings) und
[Container Images](https://vercel.com/docs/functions/container-images).

## Lokal starten

In diesem Verzeichnis `npm ci` und `npm start` ausfuehren, oder `docker compose up --build`.
Beide Wege brauchen `BLOB_READ_WRITE_TOKEN` und einen zufaelligen
`SQL_EXECUTOR_TOKEN` mit mindestens 32 Zeichen. In der Haupt-App denselben Token
und lokal `SQL_EXECUTOR_URL=http://127.0.0.1:8080` setzen. Die App haengt `/query`
an. Tokens ausschliesslich ueber Umgebungsvariablen bzw. den Secret-Store setzen.

Bei einem eigenstaendig betriebenen SQL-Dienst ausserhalb der Vercel-Services
braucht die App dessen HTTPS-Adresse als `SQL_EXECUTOR_URL`. Der Dienst gehoert
in dieselbe Region und hinter einen privaten Zugang bzw. eine Firewall, die
nur die App zulaesst.

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
Die lokale Compose-Konfiguration setzt deshalb 1 GiB, 2 CPUs und 64
Prozesse/Threads pro Replikat. Vercel wendet diese Compose-Einstellungen nicht an:
Unter Fluid Compute gilt standardmaessig die Function-Grenze von 2 GB mit 1 vCPU.
Bei Pro/Enterprise laesst sich die Groesse im Dashboard anpassen; ein
`memory`-Wert in `vercel.json` setzt unter Fluid keine eigene Speichergrenze.
Siehe [Memory und CPU auf Vercel](https://vercel.com/docs/functions/configuring-functions/memory).

Die 2-Worker-Vorgabe erst nach Speicher- und CPU-Messungen erhoehen. Vercel skaliert
Service-Instanzen mit der Last und faehrt ungenutzte Instanzen herunter; der
In-Memory-Cache ist daher nur eine Optimierung. Warteschlange und Grenzwerte gelten
je Instanz und muessen mit der globalen Zulassung der Haupt-App abgestimmt werden.
Ein einzelnes Replikat ist kein Nachweis fuer 1.000 laufende Antworten.

`GET /healthz` meldet nur die Erreichbarkeit und bleibt auf Vercel ebenfalls privat.
Fuer die Abnahme eine echte Abfrage ueber die Chat-App pruefen; Worker-Zeitlimits,
429/5xx, CPU/RAM, OOM-Neustarts und Queuezeit in Vercel Observability beobachten.
