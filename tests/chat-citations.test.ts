import { describe, expect, it } from "vitest";
import type { Root } from "mdast";
import { remarkFundstellen } from "@/lib/chat-citations";

describe("inline evidence references", () => {
  it("makes known references navigable while leaving unknown references and code literal", () => {
    const tree: Root = { type: "root", children: [
      { type: "paragraph", children: [
        { type: "text", value: "Belegt [1], unbekannt [99]." },
        { type: "inlineCode", value: "array[1]" },
        { type: "link", url: "https://example.org", children: [{ type: "text", value: "[1]" }] },
      ] },
      { type: "code", lang: "js", value: "array[1]" },
    ] };
    remarkFundstellen({ numbers: [1] })(tree);
    const paragraph = tree.children[0];
    expect(paragraph.type).toBe("paragraph");
    if (paragraph.type !== "paragraph") throw new Error();
    expect(paragraph.children).toContainEqual({ type: "link", url: "#fundstelle-1", children: [{ type: "text", value: "[1]" }] });
    expect(paragraph.children).toContainEqual({ type: "text", value: ", unbekannt [99]." });
    expect(paragraph.children).toContainEqual({ type: "inlineCode", value: "array[1]" });
    expect(tree.children[1]).toEqual({ type: "code", lang: "js", value: "array[1]" });
  });
});
