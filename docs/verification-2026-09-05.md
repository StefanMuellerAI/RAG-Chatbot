# Prüfung der Skalierungs- und Chat-Änderungen

Geprüft am 5. September 2026 mit Node 24.19.0.

- **368 Tests in 34 Dateien bestanden**, einschließlich echter SQLite-Worker,
  HTTP-Abbruch, Speicher-/Zeitgrenzen und lokaler Redis-Lua-Integration.
- PostgreSQL-Integration mit PGlite: alle Repository-Migrationen ausgeführt;
  Mandantentrennung, präzise Pagination, Retry/Fencing, Transaktionsrollback,
  Dokumentzähler und idempotente Verbrauchsbuchungen geprüft. PGlite ersetzt keinen
  Lasttest mit mehreren produktiven PostgreSQL-Verbindungen.
- `npm run build` inklusive TypeScript erfolgreich; `npm run lint` erfolgreich.
- Die tatsächlichen Chat-Komponenten mit tatsächlichem CSS wurden in Chromium über
  einen temporären, isolierten UI-Testserver und kontrollierte API-Antworten geprüft.
  Desktop 1366×900, Mobil 390×844 und verkleinerter Sichtbereich 390×480.
- Ladefehler mit „Erneut laden“, unmittelbarer Ladezustand bei Chat-Direktlink,
  Stop mit erhaltenem Entwurf/Teiltext, Retry mit derselben Anfragekennung und genau
  zwei Nachrichten je Anfrage, Scrollen zu älteren Nachrichten während des Streams,
  SQL-Tabelle, Quellen-Dialog und PDF-#page=12 geprüft. Kein horizontales Überlaufen.
- Der Audio-Player lädt eine synthetische 75-Sekunden-MP3 und steht nach dem Laden
  tatsächlich auf Sekunde 62 für die Fundstelle 1:02–1:10. Geschützter Originalzugriff,
  MIME-Begrenzung und Range-Weitergabe sind zusätzlich durch Route-Tests geprüft.
- Während der Sichtprüfung gefundene Fehler korrigiert: abgeschnittener Einstieg
  durch Scrollen eines leeren Chats und kurzes Anzeigen eines neuen Chats vor dem
  Laden eines Direktlinks.

Nicht durchgeführt: Deployment, produktive Migration, Provisionierung des SQL-Dienstes,
echte Anbieter-/Pinecone-/FalkorDB-Last mit 1.000 Konten, echte mobile Bildschirmtastatur
oder fachliche Bewertung eines kundenspezifischen Referenzfragenkatalogs.
Die Lasttreiber- und Betriebsschritte stehen in [scaling-and-chat.md](scaling-and-chat.md).
