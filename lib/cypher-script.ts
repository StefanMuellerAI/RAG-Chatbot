import { ValidationError } from "./errors";

/**
 * Zerlegt ein Cypher-Skript (Neo4j-Stil, Statements durch `;` getrennt) in
 * einzelne Statements. Semikolons in String-Literalen und Kommentare werden
 * beruecksichtigt.
 */

export const CYPHER_MAX_BYTES = 5 * 1024 * 1024;
export const CYPHER_MAX_STATEMENTS = 5_000;

export function splitStatements(script: string): string[] {
  if (script.length > CYPHER_MAX_BYTES) {
    throw new ValidationError(`Das Cypher-Skript ist groesser als ${CYPHER_MAX_BYTES / 1024 / 1024} MB.`);
  }

  const statements: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let i = 0; i < script.length; i++) {
    const char = script[i];
    const next = script[i + 1];

    if (quote) {
      current += char;
      if (char === "\\" && next !== undefined) {
        current += next;
        i++;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    // Zeilenkommentar bis zum Zeilenende ueberspringen.
    if (char === "/" && next === "/") {
      const ende = script.indexOf("\n", i);
      i = ende === -1 ? script.length : ende;
      current += "\n";
      continue;
    }
    // Blockkommentar ueberspringen.
    if (char === "/" && next === "*") {
      const ende = script.indexOf("*/", i + 2);
      i = ende === -1 ? script.length : ende + 1;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }

    if (char === ";") {
      push(statements, current);
      current = "";
      continue;
    }

    current += char;
  }

  if (quote) throw new ValidationError("Das Cypher-Skript enthaelt ein nicht geschlossenes String-Literal.");
  push(statements, current);

  if (statements.length === 0) throw new ValidationError("Das Cypher-Skript enthaelt kein Statement.");
  if (statements.length > CYPHER_MAX_STATEMENTS) {
    throw new ValidationError(`Mehr als ${CYPHER_MAX_STATEMENTS.toLocaleString("de-DE")} Statements werden nicht unterstuetzt.`);
  }
  return statements;
}

function push(statements: string[], raw: string): void {
  const trimmed = raw.trim();
  if (trimmed.length > 0) statements.push(trimmed);
}
