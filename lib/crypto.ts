/**
 * Verschluesselung fuer Geheimnisse, die in Postgres liegen — derzeit die
 * API-Keys der Modellanbieter (Tabelle provider_keys).
 *
 * AES-256-GCM ueber die Web-Crypto-API; der Schluessel wird per HKDF aus
 * PROVIDER_KEY_SECRET abgeleitet. Konsequenz, die im README steht: Wird
 * PROVIDER_KEY_SECRET gewechselt, sind die gespeicherten Keys nicht mehr lesbar
 * und muessen im Admin neu eingegeben werden.
 *
 * Format eines Chiffrats: `v1.<iv>.<ciphertext>` (jeweils base64url).
 */

const VERSION = "v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  const padded = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(secret: string, purpose: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("rag-chatbot"),
      info: encoder.encode(purpose),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSecret(
  plaintext: string,
  secret: string,
  purpose = "provider-keys",
): Promise<string> {
  const key = await deriveKey(secret, purpose);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );
  return `${VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(
  token: string,
  secret: string,
  purpose = "provider-keys",
): Promise<string> {
  const [version, ivRaw, dataRaw] = token.split(".");
  if (version !== VERSION || !ivRaw || !dataRaw) {
    throw new Error("Unbekanntes Format des verschluesselten Werts.");
  }

  const key = await deriveKey(secret, purpose);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(ivRaw) },
      key,
      base64UrlDecode(dataRaw),
    );
    return decoder.decode(plaintext);
  } catch {
    throw new Error(
      "Der gespeicherte Wert laesst sich nicht entschluesseln. " +
        "Wurde PROVIDER_KEY_SECRET geaendert? Dann den API-Key im Admin neu eingeben.",
    );
  }
}
