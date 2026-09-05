"use client";

import { isValidElement, memo, useMemo, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import type { Quelle } from "@/lib/chatVerlauf";
import { remarkFundstellen } from "@/lib/chat-citations";

// Raw HTML stays escaped; remote images stay disabled (including tracking pixels).
const VERBOTEN = ["img"];
function MarkdownText({ text, sources, onQuelle }: { text: string; sources?: Quelle[]; onQuelle?: (q: Quelle) => void }) {
  const plugins = useMemo<PluggableList>(() => [remarkGfm, remarkBreaks,
    [remarkFundstellen, { numbers: sources?.map((q) => q.n) ?? [] }],
  ], [sources]);
  return <div className="markdown"><Markdown remarkPlugins={plugins} disallowedElements={VERBOTEN}
    components={{
      a({ node, ...rest }) {
        void node;
        const match = rest.href?.match(/^#fundstelle-(\d+)$/);
        const quelle = match ? sources?.find((q) => q.n === Number(match[1])) : undefined;
        if (quelle && onQuelle) return <button className="inline-fundstelle" onClick={() => onQuelle(quelle)}
          aria-label={`Fundstelle ${quelle.n}: ${quelle.filename}`}>{rest.children}</button>;
        return <a {...rest} target="_blank" rel="noopener noreferrer" />;
      },
      table({ node, ...rest }) { void node; return <div className="tabelle-huelle"><table {...rest} /></div>; },
      pre({ node, children, ...rest }) { void node; return <CodeBlock><pre {...rest}>{children}</pre></CodeBlock>; },
    }}>
    {zaeuneSchliessen(text)}
  </Markdown></div>;
}
function CodeBlock({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState("");
  async function kopieren() {
    try { await navigator.clipboard.writeText(textVon(children)); setStatus("Kopiert"); }
    catch { setStatus("Bitte Text markieren"); }
  }
  return <div className="codeblock"><button className="knopf-schlicht" onClick={() => void kopieren()}>{status || "Code kopieren"}</button>{children}</div>;
}
function textVon(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textVon).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? textVon(node.props.children) : "";
}
function zaeuneSchliessen(text: string): string {
  const zaeune = text.match(/```/g)?.length ?? 0;
  return zaeune % 2 === 1 ? `${text}\n\`\`\`` : text;
}
export default memo(MarkdownText);
