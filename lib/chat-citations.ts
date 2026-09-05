import type { Root } from "mdast";

type Node = { type: string; value?: string; url?: string; children?: Node[] };
/** Link only actual source numbers in prose, never code, URLs or existing links. */
export function remarkFundstellen(options: { numbers: number[] }) {
  const numbers = new Set(options.numbers);
  return (tree: Root) => {
    function visit(node: Node) {
      if (!node.children || ["link", "linkReference", "code", "inlineCode", "html"].includes(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        const result: Node[] = [];
        let start = 0;
        for (const match of child.value.matchAll(/\[(\d+)\]/g)) {
          const n = Number(match[1]);
          if (!numbers.has(n)) continue;
          const index = match.index;
          if (index > start) result.push({ type: "text", value: child.value.slice(start, index) });
          result.push({ type: "link", url: `#fundstelle-${n}`, children: [{ type: "text", value: match[0] }] });
          start = index + match[0].length;
        }
        if (!result.length) return [child];
        if (start < child.value.length) result.push({ type: "text", value: child.value.slice(start) });
        return result;
      });
    }
    visit(tree);
  };
}
