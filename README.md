# Wissensassistent — RAG-Chatbot mit Nutzern und Sammlungen

Ein schlanker Retrieval-Augmented-Generation-Chatbot für mehrere Nutzer: Der Admin lädt
Personen ein, jede legt eigene **Sammlungen** an, pflegt darin Dokumente ein und stellt im
Chat Fragen dazu. Jede Antwort stützt sich ausschließlich auf die Dokumente der gewählten
Sammlung und nennt ihre Fundstellen.

- **Antworten**: Anthropic oder OpenAI — Anbieter, Modell und API-Key legt der Admin fest
- **Vektor-Datenbank**: Upstash Vector mit eingebautem, mehrsprachigem Embedding-Modell;
  ein Namespace je Sammlung
- **Nutzer, Sammlungen, Einstellungen, Limits**: Upstash Redis
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

### 2. Upstash Redis anlegen

In der [Upstash-Konsole](https://console.upstash.com/redis) → **Create Database**
(Free-Tier genügt) und `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` kopieren.
Über den Vercel-Marketplace („Upstash for Redis") heißen die Variablen
`KV_REST_API_URL` / `KV_REST_API_TOKEN` — beide Namenspaare werden akzeptiert.

Redis trägt Nutzerkonten, Einladungen, Sammlungen, den Dokumenten-Index, die
Admin-Einstellungen (Modell, verschlüsselte API-Keys) sowie die Zähler für Rate-Limits
und Tagesbudget.

### 3. Blob-Store anlegen

Im Vercel-Projekt unter **Storage → Create Database → Blob**. `BLOB_READ_WRITE_TOKEN`
wird dabei automatisch gesetzt.

### 4. Environment-Variablen

| Variable | Bedeutung |
|---|---|
| `UPSTASH_VECTOR_REST_URL` | aus Schritt 1 |
| `UPSTASH_VECTOR_REST_TOKEN` | aus Schritt 1 |
| `UPSTASH_REDIS_REST_URL` | aus Schritt 2 (oder `KV_REST_API_URL`) |
| `UPSTASH_REDIS_REST_TOKEN` | aus Schritt 2 (oder `KV_REST_API_TOKEN`) |
| `BLOB_READ_WRITE_TOKEN` | aus Schritt 3 |
| `ADMIN_PASSWORD` | frei wählbar; Anmeldung des Administrators |
| `AUTH_SECRET` | Zufallswert: `openssl rand -base64 32` — signiert Sitzungen und verschlüsselt API-Keys |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | *optional*; Rückfallwert, falls im Admin kein Key hinterlegt ist |

Nach dem Eintragen ein neues Deployment auslösen — Environment-Variablen greifen
erst beim nächsten Build.

**`AUTH_SECRET` nicht leichtfertig ändern:** Daraus wird der Schlüssel abgeleitet, mit dem
die im Admin hinterlegten API-Keys verschlüsselt sind, und damit werden Sitzungen signiert.
Nach einem Wechsel müssen sich alle neu anmelden und die Keys im Admin neu eingegeben werden.

### 5. Lokal starten

```bash
cp .env.example .env.local   # und ausfüllen
npm install
npm run dev
```

Prüfungen: `npm run typecheck`, `npm run lint`, `npm test`.

---

## Übergabe an den Kunden

1. Deployment mit allen Variablen aus Schritt 4 einrichten.
2. Kunde erhält URL und Admin-Passwort.
3. Kunde meldet sich unter `/admin` als **Administrator** an, trägt unter **Modell und
   API-Key** seinen Anbieter-Key ein, lädt die Modell-Liste, wählt ein Modell und prüft mit
   **Verbindung testen**.
4. **Antworten pro Tag** (Standard 200) begrenzt die täglichen Modellaufrufe insgesamt;
   **Antworten pro Nutzer und Tag** verhindert, dass ein Einzelner das Budget aufbraucht.
5. Unter **Nutzer** E-Mail-Adressen einladen; den angezeigten Link weitergeben (7 Tage
   gültig, wird nur einmal angezeigt). Die Eingeladenen setzen ihr Passwort selbst.
6. Nutzer legen unter **Sammlungen** ihre Wissensbasen an und laden Dokumente hoch.

---

## Rollen

| Bereich | Nutzer | Admin |
|---|---|---|
| Chat (`/`) mit eigenen Sammlungen | ja | ja |
| Eigene Sammlungen anlegen, umbenennen, löschen (`/sammlungen`) | ja | ja |
| Dokumente in eigene Sammlungen laden, herunterladen, löschen | ja | ja |
| Fremde Sammlungen sehen oder befragen | nein | ja (alle) |
| Nutzer einladen, sperren, löschen | nein | ja |
| Modell, API-Key, Budgets (`/admin`) | nein | ja |
| Gesamte Wissensbasis löschen | nein | ja |

Der Admin meldet sich mit `ADMIN_PASSWORD` an (Reiter „Administrator" im Login) und
trägt die feste Nutzer-ID `admin`; er besitzt auch eigene Sammlungen. Nutzer melden sich
mit E-Mail und Passwort an. Jede Route prüft das Eigentum an der angesprochenen Sammlung,
nicht nur der Proxy die Rolle.

**Migration:** Dokumente aus der Zeit vor den Sammlungen wandern beim ersten Aufruf
automatisch in die Sammlung **Standard** des Admins.

---

## Bedienung

**Chat** (`/`) — nach Anmeldung. Oben die Sammlung wählen; die Frage wird im Namespace
dieser Sammlung gesucht, die besten Abschnitte gehen zusammen mit der Frage an das
gewählte Modell. Unter jeder Antwort stehen die verwendeten Fundstellen mit Datei- und
Seitenangabe.

Findet die Suche nichts Passendes, wird das Modell gar nicht erst befragt — die App
sagt dann, dass sie dazu nichts hat. Das ist Absicht: eine erfundene Antwort wäre
schlimmer als keine. Solche Anfragen zählen auch nicht gegen das Tagesbudget.

**Sammlungen** (`/sammlungen`) — eigene Sammlungen anlegen, umbenennen, löschen.
Die ausgewählte Sammlung zeigt darunter ihre Dokumente: Upload per Drag-and-drop oder
Dateiauswahl (mehrere gleichzeitig), Übersicht mit Größe, Abschnittszahl und Datum,
Download der Originaldatei, Löschen.

**Admin** (`/admin`) — nur Administrator.

- **Modell und API-Key**: Anbieter (Anthropic/OpenAI) wählen, Key hinterlegen (wird
  verschlüsselt gespeichert und nur maskiert angezeigt), Modelle vom Anbieter laden
  oder eine Modell-ID direkt eintragen, Verbindung testen, Tagesbudget global und pro Nutzer.
- **Nutzer**: einladen (Link kopieren), offene Einladungen widerrufen, Konten sperren
  oder samt Sammlungen löschen.
- **Alle Sammlungen**: Übersicht mit Eigentümer, Dokumenten und Abschnitten; Löschen.
- **Gesamte Wissensbasis löschen**: leert alle Sammlungen aller Nutzer. Nutzerkonten und
  Einstellungen bleiben. Zur Bestätigung muss `LÖSCHEN` eingetippt werden.

---

## Schutzmechanismen

- **Passwörter**: scrypt (N=2¹⁵) mit Salt; der Admin vergleicht zeitkonstant gegen
  `ADMIN_PASSWORD`. Unbekannte E-Mails kosten beim Login dieselbe Rechenzeit wie bekannte.
- **Einladungen**: 32 Zufallsbytes; Redis speichert nur den SHA-256 des Tokens. 7 Tage
  gültig, einmalig, widerrufbar.
- **Sitzungen**: HMAC-signiertes Cookie mit Rolle und Nutzer-ID, 12 h gültig.
- **Autorisierung**: Eigentum an Sammlungen wird in jeder Route geprüft (Chat, Upload,
  Verarbeitung, Download, Löschen). Der Upload-Token gilt nur für den Dateipfad der
  eigenen Sammlung.
- **Rate-Limits**: Chat 10/min und 60/h pro Nutzer, Anmeldung und Einladung annehmen
  5/min pro IP. Antwort 429 mit `Retry-After`.
- **Tagesbudget**: globale Obergrenze an Modellantworten pro Tag (deutsche Zeit) plus
  optionales Limit pro Nutzer, im Admin einstellbar.
- **Eingabegrenzen**: Frage max. 2.000 Zeichen, Verlauf die letzten 10 Nachrichten.
- **Abbruch**: Schließt der Nutzer den Tab, wird auch die Anfrage an den Anbieter beendet.
- **API-Keys**: AES-256-GCM verschlüsselt in Redis, Schlüssel per HKDF aus `AUTH_SECRET`.
  Der Browser sieht nie mehr als `sk-ant-…7f3a`.
- **Sicherheitsheader**: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy`.
- **Aufräumen**: Scheitert die Verarbeitung eines Uploads, werden Datei bzw. Abschnitte
  wieder entfernt — es bleiben keine unsichtbaren Reste im Store.

---

## Datenmodell (Redis)

| Schlüssel | Typ | Inhalt |
|---|---|---|
| `users` | Hash | `userId → { id, email, passwordHash, createdAt, disabled }` |
| `users:byEmail` | Hash | `email → userId` |
| `invites` | Hash | `sha256(token) → { id, email, createdAt, expiresAt }` |
| `collections` | Hash | `collectionId → { id, ownerId, name, namespace, createdAt }` |
| `documents:<collectionId>` | Hash | `docId → DocumentRecord` |
| `documents:byId` | Hash | `docId → collectionId` |
| `settings:v1` | String | Anbieter, Modell, verschlüsselte Keys, Budgets |
| `budget:<tag>`, `budget:<tag>:<userId>` | Zähler | Antworten heute |
| `rl:*` | | Sliding-Window-Zähler von `@upstash/ratelimit` |

Vektoren: Upstash-Namespace = `collectionId`; die migrierte Sammlung „Standard" nutzt den
Default-Namespace (`""`). Dateien: `files/<collectionId>/<uuid>/<name>` in Vercel Blob,
Metadaten-Sicherung `documents/<docId>.json`.

---

## Aufbau

```
app/
  page.tsx                      Chat mit Sammlungsauswahl
  sammlungen/page.tsx           Eigene Sammlungen + Dokumente (?sammlung=<id>)
  admin/page.tsx                Einstellungen · Nutzer · alle Sammlungen · Notausgang
  login/page.tsx                Anmeldung (Nutzer / Administrator)
  einladung/[token]/page.tsx    Einladung annehmen, Passwort setzen
  api/chat/                     Sitzung · Rate-Limit · Zugriff · Retrieval · Budget · Streaming
  api/collections/              Sammlungen anlegen, umbenennen, löschen
  api/documents/                Liste · Verarbeitung · Löschen · Download (je Sammlung)
  api/upload/                   Token für den Direkt-Upload zu Vercel Blob (mit Zugriffsprüfung)
  api/invites/                  Einladungen erzeugen, widerrufen, annehmen
  api/users/                    Nutzer auflisten, sperren, löschen
  api/settings/                 Einstellungen lesen/speichern · Modelle laden · Verbindung testen
  api/collection/               Admin-Notausgang: gesamte Wissensbasis leeren
  api/auth/                     An- und Abmeldung
proxy.ts                        Zugriffsschutz nach Rolle
lib/
  auth.ts                       HMAC-signiertes Sitzungs-Cookie mit Rolle und Nutzer-ID
  password.ts / password-rules  scrypt-Hashing und Passwortregeln
  users.ts · invites.ts         Nutzerkonten und Einladungen
  collections.ts                Sammlungen, Zugriffsprüfung, Migration
  documents.ts                  Dateien in Vercel Blob, Metadaten-Index je Sammlung
  vector.ts                     Upstash Vector je Namespace
  llm.ts · settings.ts · providers.ts · models.ts
  ratelimit.ts                  Rate-Limits und Tagesbudgets
  redis.ts · crypto.ts · session.ts · api.ts · errors.ts · env.ts
  extract.ts · chunk.ts         PDF · DOCX · XLSX → Text → Abschnitte
tests/                          Vitest: chunk · auth · password · crypto · settings · invites · collections
```

### Entwurfsentscheidungen

**Sammlungen sind Namespaces.** Jede Sammlung ist ein eigener Upstash-Namespace und ein
eigener Redis-Hash. Löschen einer Sammlung ist damit ein `reset` des Namespace plus ein
Hash-Delete — nichts kann in eine fremde Sammlung „durchsuchen".

**Modell und Key gehören dem Kunden.** Anbieter, Modell und API-Key werden im Admin
gepflegt statt in Umgebungsvariablen. Die Anbindung läuft über das Vercel AI SDK, damit
Anthropic und OpenAI denselben Code-Pfad nutzen.

**Einladungen ohne Mailversand.** Der Admin kopiert den Link. Das spart einen weiteren
Dienst und passt zu einer Erprobung mit überschaubarem Nutzerkreis.

**Uploads laufen am Server vorbei.** Der Browser lädt die Datei mit einem kurzlebigen
Token direkt in den Blob-Store und meldet danach nur den Pfad. Der Token wird erst nach
Zugriffsprüfung auf die Sammlung ausgestellt.

**Chunk-IDs sind deterministisch** (`<docId>#<n>`). Ein Dokument lässt sich dadurch mit
einem einzigen Präfix-Delete restlos entfernen, ohne die IDs mitzuführen.

**Abschnitte enden an Zeilen-, Satz- oder Absatzgrenzen.** Tabellenzeilen aus XLSX
werden nie mitten in der Zeile getrennt; die Suche nach der Schnittkante ist auf ein
Fenster begrenzt, damit große Tabellen nicht quadratisch teuer werden.

**Die Konfiguration wird erst im Request gelesen.** Dadurch läuft der allererste Build
auf Vercel durch, obwohl noch kein einziger Schlüssel hinterlegt ist.

**Ohne `AUTH_SECRET` bleibt alles gesperrt** statt offen zu stehen.

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
- **Kein Passwort-Zurücksetzen.** Der Admin löscht das Konto und lädt neu ein.
- **Kein Teilen von Sammlungen** zwischen Nutzern; Sammlungen gehören genau einer Person.
- **Sperren wirkt beim nächsten Login.** Eine laufende Sitzung bleibt bis zu 12 h gültig,
  weil der Proxy nur die Signatur prüft.
- **Rate-Limits beim Login zählen pro IP.** Hinter einem Firmen-Proxy teilen sich alle
  eine Adresse; bei Bedarf die Werte in `lib/ratelimit.ts` anheben.
