import type { CollectionSchema } from "@/lib/collection-kinds";

/** Struktur einer Tabellen- oder Graph-Sammlung — was die KI "sieht". */
export default function SchemaCard({ schema }: { schema: CollectionSchema }) {
  if (schema.kind === "sql") {
    return (
      <div className="karte">
        <h2 className="karte-titel">Tabellen</h2>
        <p className="hinweis-text">
          Diese Struktur bekommt die KI mit jeder Frage. Sie formuliert daraus SQL (SQLite-Dialekt).
        </p>
        {schema.tables.length === 0 ? (
          <p className="hinweis-text">Noch keine Tabelle.</p>
        ) : (
          schema.tables.map((table) => (
            <details key={table.name} className="schema-block" open={schema.tables.length === 1}>
              <summary>
                <code>{table.name}</code>
                <span className="schema-meta">
                  {table.rows.toLocaleString("de-DE")} Zeilen · {table.columns.length} Spalten
                </span>
              </summary>
              <div className="tabelle-huelle">
                <table>
                  <thead>
                    <tr>
                      <th>Spalte</th>
                      <th>Typ</th>
                      <th>Beispielwerte</th>
                    </tr>
                  </thead>
                  <tbody>
                    {table.columns.map((column) => (
                      <tr key={column.name}>
                        <td>
                          <code>{column.name}</code>
                        </td>
                        <td>{column.type}</td>
                        <td className="schema-beispiele">{(table.samples?.[column.name] ?? []).join(" · ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))
        )}
      </div>
    );
  }

  return (
    <div className="karte">
      <h2 className="karte-titel">Graph</h2>
      <p className="hinweis-text">
        Diese Struktur bekommt die KI mit jeder Frage. Sie formuliert daraus Cypher (openCypher, FalkorDB).
      </p>
      <div className="formular-raster">
        <div className="feld">
          <label>Umfang</label>
          <div>
            {schema.nodes.toLocaleString("de-DE")} Knoten · {schema.relationships.toLocaleString("de-DE")} Kanten
          </div>
        </div>
        <div className="feld">
          <label>Labels</label>
          <div className="marken">{schema.labels.length > 0 ? schema.labels.map((l) => <code key={l}>{l}</code>) : "—"}</div>
        </div>
        <div className="feld">
          <label>Beziehungstypen</label>
          <div className="marken">
            {schema.relationshipTypes.length > 0 ? schema.relationshipTypes.map((t) => <code key={t}>{t}</code>) : "—"}
          </div>
        </div>
        <div className="feld">
          <label>Eigenschaften</label>
          <div className="marken">
            {schema.propertyKeys.length > 0 ? schema.propertyKeys.map((p) => <code key={p}>{p}</code>) : "—"}
          </div>
        </div>
      </div>
    </div>
  );
}
