import { BlobNotFoundError, get, head } from "@vercel/blob";
import { errorResponse } from "@/lib/api";
import { requireKontext } from "@/lib/auth/user";
import { ladeDokument } from "@/lib/documents";
import { ifRangeMatches, inlineContentType, parseByteRange } from "@/lib/document-response";
import { requireEnv } from "@/lib/env";
import { NotFoundError } from "@/lib/errors";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" };

/** Every full file, HEAD and byte-range request checks the same document ownership. */
export async function GET(request: Request, context: Context) { return deliver(request, context, false); }
export async function HEAD(request: Request, context: Context) { return deliver(request, context, true); }

async function deliver(request: Request, context: Context, metadataOnly: boolean): Promise<Response> {
  try {
    const kontext = await requireKontext();
    const { id } = await context.params;
    const document = await ladeDokument(kontext.userId, id);
    requireEnv("BLOB_READ_WRITE_TOKEN");
    const wantsInline = new URL(request.url).searchParams.get("inline") === "1";
    const rangeHeader = metadataOnly ? null : request.headers.get("range");
    // The DB contains the announced upload size, not necessarily the actual byte length.
    const metadata = metadataOnly || rangeHeader ? await head(document.blobPath, { abortSignal: request.signal }) : null;
    const range = rangeHeader && metadata && ifRangeMatches(request.headers.get("if-range"), metadata.etag, metadata.uploadedAt)
      ? parseByteRange(rangeHeader, metadata.size) : null;
    if (rangeHeader && metadata && !range && ifRangeMatches(request.headers.get("if-range"), metadata.etag, metadata.uploadedAt)) {
      return new Response(null, { status: 416, headers: { ...PRIVATE_HEADERS, "Accept-Ranges": "bytes", "Content-Range": `bytes */${metadata.size}` } });
    }

    if (metadataOnly && metadata) {
      return new Response(null, { headers: responseHeaders(document, metadata, wantsInline) });
    }

    // get() forwards these headers to private storage and returns a ReadableStream.
    // Do not use leseDateiFenster here: that ingestion helper materializes its result.
    const result = await get(document.blobPath, {
      access: "private", abortSignal: request.signal,
      headers: { "Accept-Encoding": "identity", ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) },
    });
    if (!result || result.statusCode === 304) throw new NotFoundError("Die Datei");
    const headers = responseHeaders(document, result.blob, wantsInline);
    if (range && metadata) {
      // SDK 2.x normalizes a successful upstream 206 to statusCode: 200. Its raw
      // Content-Range is therefore the source of truth, not result.statusCode.
      const expected = `bytes ${range.start}-${range.end}/${metadata.size}`;
      const length = range.end - range.start + 1;
      const sameVersion = !metadata.etag || !result.blob.etag || metadata.etag === result.blob.etag;
      if (result.headers.get("content-range") !== expected || !sameVersion
        || Number(result.headers.get("content-length")) !== length) {
        await result.stream.cancel();
        return Response.json({ error: "Der gewünschte Dateiausschnitt konnte nicht geladen werden. Bitte erneut versuchen.", code: "dateiausschnitt" }, { status: 502, headers: PRIVATE_HEADERS });
      }
      headers.set("Content-Range", expected);
      headers.set("Content-Length", String(length));
      return new Response(result.stream, { status: 206, headers });
    }
    return new Response(result.stream, { headers });
  } catch (error) {
    const response = errorResponse(error instanceof BlobNotFoundError ? new NotFoundError("Die Datei") : error);
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(name, value);
    return metadataOnly ? new Response(null, { status: response.status, headers: response.headers }) : response;
  }
}

function responseHeaders(
  document: { filename: string; contentType: string },
  blob: { contentType: string; size: number; etag: string; uploadedAt: Date },
  wantsInline: boolean,
): Headers {
  const inlineType = wantsInline ? inlineContentType(document.filename, document.contentType, blob.contentType) : null;
  const headers = new Headers({
    ...PRIVATE_HEADERS,
    "Accept-Ranges": "bytes",
    // Unknown/user-controlled types are always attachment + octet-stream.
    "Content-Type": inlineType ?? "application/octet-stream",
    "Content-Disposition": `${inlineType ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(document.filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    "Content-Length": String(blob.size),
  });
  if (blob.etag) headers.set("ETag", blob.etag);
  if (Number.isFinite(blob.uploadedAt.getTime())) headers.set("Last-Modified", blob.uploadedAt.toUTCString());
  return headers;
}
