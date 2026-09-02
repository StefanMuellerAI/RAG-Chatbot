import type { CollectionKind, CollectionSchema } from "@/lib/collection-kinds";
import type { SammlungMitKlasse } from "@/lib/collections";

/**
 * Baut eine vollstaendige Sammlung fuer Tests. Die Werkzeuge und der Katalog
 * nehmen `SammlungMitKlasse` entgegen; hier stehen nur die Felder, die im
 * jeweiligen Test eine Rolle spielen.
 */
export function beispielSammlung(
  teil: { id: string; name: string; kind: CollectionKind } & Partial<SammlungMitKlasse>,
): SammlungMitKlasse {
  const jetzt = new Date("2026-01-01T00:00:00Z");
  return {
    userId: "user_anna",
    description: "",
    descriptionSource: "user",
    preset: "fliesstext",
    schema: null,
    sizeClassId: "S",
    documentCount: 0,
    pageCount: 0,
    chunkCount: 0,
    createdAt: jetzt,
    updatedAt: jetzt,
    sizeClass: {
      id: "S",
      label: "Klein",
      rank: 1,
      maxDocuments: 10,
      maxPagesPerDocument: 50,
      maxTotalPages: 200,
      maxFileBytes: 10 * 1024 * 1024,
      updatedAt: jetzt,
    },
    ...teil,
  };
}

export const SQL_SCHEMA: CollectionSchema = {
  kind: "sql",
  tables: [
    {
      name: "umsatz",
      rows: 1200,
      columns: [
        { name: "kunde", type: "TEXT" },
        { name: "betrag", type: "REAL" },
      ],
      samples: { kunde: ["Alpha", "Beta"], betrag: ["10", "5.5"] },
    },
  ],
};

export const GRAPH_SCHEMA: CollectionSchema = {
  kind: "graph",
  nodes: 120,
  relationships: 340,
  labels: ["Person", "Firma"],
  relationshipTypes: ["KENNT", "ARBEITET_BEI"],
  propertyKeys: ["name", "seit"],
};
