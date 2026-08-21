import { Pinecone } from "@pinecone-database/pinecone";
import { EMBEDDING_MODELL, TEXT_FELD } from "../lib/vector";

/**
 * Legt den Pinecone-Index an.
 *
 * Der Index MUSS mit eingebautem Embedding-Modell entstehen, sonst nimmt er
 * keinen Rohtext an und die Anwendung kann nichts schreiben. Weil sich das
 * nachtraeglich nicht aendern laesst, gibt es dieses Skript: ein von Hand in
 * der Konsole angelegter Index ist der haeufigste Grund, warum am Ende nichts
 * funktioniert.
 *
 *   npm run pinecone:init
 */
async function main() {
  const apiKey = process.env.PINECONE_API_KEY;
  const name = process.env.PINECONE_INDEX || "wissensassistent";

  if (!apiKey) {
    throw new Error("PINECONE_API_KEY muss gesetzt sein (siehe .env.example).");
  }

  const pinecone = new Pinecone({ apiKey });

  const vorhanden = await pinecone.listIndexes();
  if (vorhanden.indexes?.some((index) => index.name === name)) {
    const beschreibung = await pinecone.describeIndex(name);
    const modell = beschreibung.embed?.model;

    if (!modell) {
      throw new Error(
        `Der Index "${name}" existiert, wurde aber OHNE eingebautes Embedding-Modell ` +
          `angelegt. Er kann keinen Rohtext annehmen und laesst sich nicht ` +
          `nachtraeglich umstellen. Bitte einen anderen Namen in PINECONE_INDEX ` +
          `eintragen oder den bestehenden Index loeschen.`,
      );
    }

    console.log(`Index "${name}" existiert bereits (Modell: ${modell}). Nichts zu tun.`);
    return;
  }

  console.log(`Lege Index "${name}" mit ${EMBEDDING_MODELL} an …`);

  await pinecone.createIndexForModel({
    name,
    cloud: (process.env.PINECONE_CLOUD ?? "aws") as "aws" | "gcp" | "azure",
    region: process.env.PINECONE_REGION ?? "us-east-1",
    embed: {
      model: EMBEDDING_MODELL,
      fieldMap: { text: TEXT_FELD },
    },
    waitUntilReady: true,
  });

  console.log(
    `Fertig. Der Index bettet das Feld "${TEXT_FELD}" serverseitig ein; ` +
      `je Sammlung entsteht ein eigener Namespace.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
