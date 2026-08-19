# Wissensassistent — RAG-Chatbot mit Dokumentenverwaltung

Ein schlanker Retrieval-Augmented-Generation-Chatbot: Dokumente im Admin-Bereich
einpflegen, im Chat Fragen dazu stellen. Jede Antwort stützt sich ausschließlich auf
die eingepflegten Dokumente und nennt ihre Fundstellen.

- **Antworten**: Claude Opus über die Anthropic-API
- **Vektor-Datenbank**: Upstash Vector mit eingebautem, mehrsprachigem Embedding-Modell
- **Dateiablage**: Vercel Blob (privat)
- **Formate**: PDF, DOCX, XLSX
- **Design**: in Anlehnung an stadt-koeln.de

---

## Einrichtung

### 1. Upstash-Vector-Index anlegen

**Dieser Schritt entscheidet, ob die App funktioniert.** Der Index muss mit einem
*eingebauten Embedding-Modell* erzeugt werden — sonst nimmt er keinen Rohtext entgegen.

1. In der [Upstash-Konsole](https://console.upstash.com/vector) → **Create Index**
2. Als **Embedding Model** `bge-m3` wählen (mehrsprachig, 1024 Dimensionen, Dot Product).
   Ein rein englisches Modell liefert bei deutschen Dokumenten spürbar schlechtere Treffer.
3. `UPSTASH_VECTOR_REST_URL` und `UPSTASH_VECTOR_REST_TOKEN` kopieren

Alternativ lässt sich Upstash über den Vercel-Marketplace verbinden; die beiden
Variablen landen dann automatisch im Projekt. Auch dann gilt: beim Anlegen des Index
das Embedding-Modell setzen.

### 2. Blob-Store anlegen

Im Vercel-Projekt unter **Storage → Create Database → Blob**. `BLOB_READ_WRITE_TOKEN`
wird dabei automatisch gesetzt.

### 3. Environment-Variablen

| Variable | Bedeutung |
|---|---|
| `ANTHROPIC_API_KEY` | Schlüssel von console.anthropic.com |
| `UPSTASH_VECTOR_REST_URL` | aus Schritt 1 |
| `UPSTASH_VECTOR_REST_TOKEN` | aus Schritt 1 |
| `BLOB_READ_WRITE_TOKEN` | aus Schritt 2 |
| `ADMIN_PASSWORD` | frei wählbar, schützt den Admin-Bereich |
| `AUTH_SECRET` | Zufallswert: `openssl rand -base64 32` |

Nach dem Eintragen ein neues Deployment auslösen — Environment-Variablen greifen
erst beim nächsten Build.

### 4. Lokal starten

```bash
cp .env.example .env.local   # und ausfüllen
npm install
npm run dev
```

---

## Bedienung

**Chat** (`/`) — ohne Anmeldung erreichbar. Die Frage wird in der Vektor-Datenbank
gesucht, die besten Abschnitte gehen zusammen mit der Frage an Claude. Unter jeder
Antwort stehen die verwendeten Fundstellen mit Datei- und Seitenangabe — zugeklappt,
damit sie den Verlauf nicht zuschieben. Die Kopfzeile nennt bereits Trefferanzahl und
Herkunftsdokumente; aufgeklappt wird nur, wenn man den Wortlaut nachlesen will.

Findet die Suche nichts Passendes, wird das Modell gar nicht erst befragt — die App
sagt dann, dass sie dazu nichts hat. Das ist Absicht: eine erfundene Antwort wäre
schlimmer als keine.

**Chat-Historie** — links neben dem Chatfenster stehen die bisherigen Gespräche. Die
erste Frage legt automatisch einen Chat an und benennt ihn nach dieser Frage; umbenennen
und löschen geht jederzeit. Während eine Antwort läuft, ist die Liste gesperrt, damit die
Antwort im richtigen Chat landet.

Der Verlauf liegt **ausschließlich im Browser** (`localStorage`, bis zu 50 Chats) — nichts
davon geht an den Server. Das heißt umgekehrt: auf einem geteilten Rechner sieht die
nächste Person die gespeicherten Fragen samt Dokumentauszügen. Dafür gibt es unten in der
Liste „Alle Chats löschen". Auf einem anderen Gerät oder in einem anderen Browser ist der
Verlauf entsprechend nicht vorhanden.

**Admin** (`/admin`) — passwortgeschützt.

- Dateien per Drag-and-drop oder Dateiauswahl einpflegen (mehrere gleichzeitig möglich)
- Übersicht aller Dokumente mit Größe, Abschnittszahl und Datum; Originaldatei herunterladbar
- Einzelne Dokumente entfernen
- **Collection löschen** leert die gesamte Wissensbasis. Zur Bestätigung muss `LÖSCHEN`
  eingetippt werden.

---

## Aufbau

```
app/
  page.tsx                      Chat
  admin/page.tsx                Dokumentenverwaltung (lädt die Liste serverseitig)
  login/page.tsx                Anmeldung
  api/chat/                     Retrieval + Antwort-Streaming (NDJSON)
  api/upload/                   Token für den Direkt-Upload zu Vercel Blob
  api/documents/                Liste · Verarbeitung · Löschen · Download
  api/collection/               Wissensbasis leeren
  api/auth/                     An- und Abmeldung
proxy.ts                        Zugriffsschutz für /admin und alle schreibenden Routen
lib/
  vector.ts                     Upstash: schreiben, suchen, löschen, zurücksetzen
  extract.ts                    PDF · DOCX · XLSX → Text
  chunk.ts                      Text → überlappende Abschnitte
  documents.ts                  Dateien und Metadaten in Vercel Blob
  anthropic.ts                  Claude-Client und System-Prompt
  auth.ts                       HMAC-signiertes Sitzungs-Cookie
  env.ts                        später, geprüfter Zugriff auf die Konfiguration
```

### Entwurfsentscheidungen

**Uploads laufen am Server vorbei.** Der Browser lädt die Datei mit einem kurzlebigen
Token direkt in den Blob-Store und meldet danach nur den Pfad. Ein Upload über eine
Serverless-Funktion wäre bei 4,5 MB Request-Body am Ende — für PDFs zu wenig.

**Chunk-IDs sind deterministisch** (`<docId>#<n>`). Ein Dokument lässt sich dadurch mit
einem einzigen Präfix-Delete restlos entfernen, ohne die IDs mitzuführen.

**Die Konfiguration wird erst im Request gelesen.** Dadurch läuft der allererste Build
auf Vercel durch, obwohl noch kein einziger Schlüssel hinterlegt ist. Fehlende
Variablen führen zu einer benannten Meldung in der Oberfläche statt zu einem
abgebrochenen Build.

**Ohne `AUTH_SECRET` bleibt der Admin gesperrt** statt offen zu stehen. Eine fehlende
Konfiguration darf nie in einen ungeschützten Zustand führen.

**Kurze Abschnitte werden nicht verworfen.** Ein Tabellenblatt mit drei Zeilen
Öffnungszeiten ist genau die Art Information, nach der gefragt wird.

### Zum Design

Orientiert an stadt-koeln.de: das Rot `#E1141C` stammt aus dem offiziellen Logo-SVG,
dazu weißer Kopfbereich mit roter Trennlinie, rechtwinklige Flächen, viel Weißraum und
eine ruhige serifenlose Schrift.

Bewusst **nicht** übernommen sind Wappen, Logo und Wortmarke der Stadt Köln — die sind
geschützt und gehören nicht in eine fremde Anwendung. Rot wird nur für Flächen, Linien
und Akzente eingesetzt, Fließtext bleibt bei `#1A1A1A`; damit hält die Oberfläche den
WCAG-AA-Kontrast.

---

## Grenzen

- **Gescannte PDFs ohne Texterkennung** liefern keinen Text. Der Upload meldet das
  ausdrücklich, statt ein leeres Dokument anzulegen. Abhilfe: die Datei vorher durch OCR schicken.
- **Alte Binärformate `.doc` und `.xls`** werden nicht unterstützt. Einmal als `.docx`
  bzw. `.xlsx` speichern genügt.
- **Sehr große Dateien** können die Zeitgrenze der Verarbeitungsfunktion (60 s) reißen.
  Erfahrungsgemäß unkritisch bis in den Bereich einiger hundert Seiten.
- **Der Chat ist öffentlich.** Wer die URL kennt, kann Fragen stellen und damit indirekt
  Inhalte aus den Dokumenten erfahren. Bei vertraulichen Unterlagen sollte auch der
  Chat hinter die Anmeldung — dazu in `proxy.ts` `/` und `/api/chat` in den `matcher`
  aufnehmen.
