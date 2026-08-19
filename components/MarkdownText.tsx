"use client";

import { memo } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/**
 * Rendert eine Assistenten-Antwort als Markdown.
 *
 * `react-markdown` ist bewusst gewaehlt: es escaped rohes HTML, statt es
 * auszufuehren (dafuer braeuchte es ausdruecklich `rehype-raw`), und
 * `defaultUrlTransform` laesst nur unbedenkliche Protokolle durch. Das ist hier
 * nicht nebensaechlich — der Antworttext ist durch die hochgeladenen Dokumente
 * beeinflussbar, und eine Bibliothek mit `dangerouslySetInnerHTML` wuerde
 * genau daraus einen XSS-Pfad machen.
 */

// remark-breaks: einzelne Zeilenumbrueche bleiben Zeilenumbrueche. Ohne das
// Plugin faesst Markdown zwei aufeinanderfolgende Zeilen zu einem Absatz
// zusammen, was gegenueber der bisherigen Darstellung wie ein Rueckschritt aussaehe.
const PLUGINS = [remarkGfm, remarkBreaks];

// Ein Wissensassistent hat keinen Anlass, Bilder auszugeben. Ein aus einem
// Dokument eingeschleustes ![](https://…/pixel.gif) waere dagegen ein stiller
// Aufruf nach aussen.
const VERBOTEN = ["img"];

function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={PLUGINS}
        disallowedElements={VERBOTEN}
        components={{
          a({ node, ...rest }) {
            void node;
            return <a {...rest} target="_blank" rel="noopener noreferrer" />;
          },
          table({ node, ...rest }) {
            void node;
            // Dieselbe Huelle, die im Admin-Bereich die Dokumententabelle
            // scrollbar haelt — eine breite Tabelle soll die Blase nicht sprengen.
            return (
              <div className="tabelle-huelle">
                <table {...rest} />
              </div>
            );
          },
        }}
      >
        {zaeuneSchliessen(text)}
      </Markdown>
    </div>
  );
}

/**
 * Haengt einen fehlenden schliessenden Code-Zaun an.
 *
 * Mitten im Stream steht das oeffnende ``` schon da, das schliessende noch
 * nicht — der Rest der Antwort kippt so lange in einen Codeblock. Bei fertigem
 * Text ist die Anzahl gerade und der Handgriff wirkungslos.
 */
function zaeuneSchliessen(text: string): string {
  const zaeune = text.match(/```/g)?.length ?? 0;
  return zaeune % 2 === 1 ? `${text}\n\`\`\`` : text;
}

/**
 * Memoisiert, und das ist kein Feinschliff: waehrend des Streamens rendert der
 * Elternbaum bei jedem Textstueck neu. Ohne Memo wuerde jede laengst fertige
 * Antwort im Verlauf bei jedem Delta erneut geparst.
 */
export default memo(MarkdownText);
