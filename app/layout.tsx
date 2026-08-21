import { ClerkProvider } from "@clerk/nextjs";
import { deDE } from "@clerk/localizations";
import type { Metadata } from "next";
import Kopfzeile from "@/components/Kopfzeile";
import "./globals.css";

export const metadata: Metadata = {
  title: "Knowledge Base",
  description:
    "Fragen an die eigenen Dokumente — jede Antwort nennt ihre Fundstellen.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Die Oberflaeche ist durchgaengig deutsch; Clerks Anmeldedialoge waeren
    // ohne `localization` die einzige englische Insel darin.
    <ClerkProvider localization={deDE}>
      <html lang="de">
        <body>
          <Kopfzeile />

          <main className="inhalt">{children}</main>

          <footer className="fuss">
            <div className="fuss-inner">
              Antworten werden automatisiert aus den hinterlegten Dokumenten erzeugt und
              koennen Fehler enthalten. Im Zweifel gilt das Originaldokument.
            </div>
          </footer>
        </body>
      </html>
    </ClerkProvider>
  );
}
