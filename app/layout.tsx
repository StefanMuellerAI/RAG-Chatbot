import type { Metadata } from "next";
import TabNav from "@/components/TabNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wissensassistent",
  description:
    "Interner Chatbot, der Fragen anhand der eingepflegten Dokumente beantwortet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>
        <header className="kopf">
          <div className="kopf-inner">
            <div className="wortmarke">
              Wissens<span>assistent</span>
            </div>
            <div className="kopf-zusatz">Auskunft aus den eigenen Dokumenten</div>
          </div>
        </header>

        <TabNav />

        <main className="inhalt">{children}</main>

        <footer className="fuss">
          <div className="fuss-inner">
            Antworten werden automatisiert aus den hinterlegten Dokumenten erzeugt und
            koennen Fehler enthalten. Im Zweifel gilt das Originaldokument.
          </div>
        </footer>
      </body>
    </html>
  );
}
