import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), document: vi.fn(), head: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/auth/user", () => ({
  requireKontext: mocks.auth,
  NotSignedInError: class NotSignedInError extends Error {},
  NotAdminError: class NotAdminError extends Error {},
}));
vi.mock("@/lib/documents", () => ({ ladeDokument: mocks.document }));
vi.mock("@vercel/blob", () => ({
  get: mocks.get, head: mocks.head, BlobNotFoundError: class BlobNotFoundError extends Error {},
}));

import { BlobNotFoundError } from "@vercel/blob";
import { GET, HEAD } from "@/app/api/documents/[id]/download/route";
import { NotSignedInError } from "@/lib/auth/user";
import { ifRangeMatches, inlineContentType, parseByteRange } from "@/lib/document-response";
import { NotFoundError } from "@/lib/errors";

const document = { filename: "Handbuch.pdf", contentType: "application/pdf", blobPath: "private/user-a/document-1", sizeBytes: 9 };
const metadata = { contentType: "application/pdf", size: 100, etag: '"version-1"', uploadedAt: new Date("2026-09-01T12:30:00.750Z") };
const context = { params: Promise.resolve({ id: "document-1" }) };
function request(headers: Record<string, string> = {}, inline = true, method = "GET") {
  return new Request(`https://app.invalid/api/documents/document-1/download${inline ? "?inline=1" : ""}`, { method, headers });
}
function blobResult(options: { type?: string; size?: number; range?: string; etag?: string; body?: string } = {}) {
  const bytes = new TextEncoder().encode(options.body ?? "a".repeat(options.size ?? 100));
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => { controller.enqueue(bytes); controller.close(); });
  const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  return {
    // The actual SDK normalizes successful upstream 206 to 200.
    statusCode: 200 as const, stream, cancel, pull,
    headers: new Headers({ "content-length": String(bytes.length), ...(options.range ? { "content-range": options.range } : {}) }),
    blob: { ...metadata, contentType: options.type ?? metadata.contentType, size: bytes.length, etag: options.etag ?? metadata.etag },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-only-token");
  mocks.auth.mockResolvedValue({ userId: "user-a" });
  mocks.document.mockResolvedValue(document);
  mocks.head.mockResolvedValue(metadata);
  mocks.get.mockResolvedValue(blobResult());
});
afterEach(() => vi.unstubAllEnvs());

describe("authenticated inline document delivery", () => {
  it.each(["GET", "HEAD"])("authenticates %s before document or storage lookup", async (method) => {
    mocks.auth.mockRejectedValue(new NotSignedInError());
    const response = await (method === "HEAD" ? HEAD : GET)(request({ Range: "bytes=0-1" }, true, method), context);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.document).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.head).not.toHaveBeenCalled();
    if (method === "HEAD") expect(await response.text()).toBe("");
  });

  it.each(["GET", "HEAD"])("checks document ownership for %s, including byte requests", async (method) => {
    mocks.document.mockRejectedValue(new NotFoundError("Das Dokument"));
    const response = await (method === "HEAD" ? HEAD : GET)(request({ Range: "bytes=0-1" }, true, method), context);
    expect(response.status).toBe(404);
    expect(mocks.document).toHaveBeenCalledWith("user-a", "document-1");
    expect(mocks.head).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("streams a PDF without reading it into an application buffer", async () => {
    const blob = blobResult(); mocks.get.mockResolvedValue(blob);
    const req = request();
    const response = await GET(req, context);
    expect(response.status).toBe(200);
    expect(response.body).toBe(blob.stream);
    expect(blob.pull).not.toHaveBeenCalled();
    expect(mocks.head).not.toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledWith(document.blobPath, { access: "private", abortSignal: req.signal, headers: { "Accept-Encoding": "identity" } });
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(await response.text()).toHaveLength(100);
  });

  it("keeps the original-download URL an attachment and encodes its filename safely", async () => {
    mocks.document.mockResolvedValue({ ...document, filename: "O'Brien (Grüße).pdf" });
    const response = await GET(request({}, false), context);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''O%27Brien%20%28Gr%C3%BC%C3%9Fe%29.pdf");
  });

  it.each([
    ["evil.html", "text/html", "text/html"],
    ["image.svg", "image/svg+xml", "image/svg+xml"],
    ["fake.pdf", "application/pdf", "text/html"],
    ["fake.mp3", "text/html", "audio/mpeg"],
    ["notes.docx", "application/pdf", "application/pdf"],
  ])("serves %s as a download even when inline is requested", async (filename, declared, stored) => {
    mocks.document.mockResolvedValue({ ...document, filename, contentType: declared });
    mocks.get.mockResolvedValue(blobResult({ type: stored }));
    const response = await GET(request(), context);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("HEAD returns actual storage metadata and never reads the file body", async () => {
    const req = request({ Range: "bytes=0-1" }, true, "HEAD");
    const response = await HEAD(req, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("100");
    expect(response.headers.get("etag")).toBe(metadata.etag);
    expect(await response.text()).toBe("");
    expect(mocks.head).toHaveBeenCalledWith(document.blobPath, { abortSignal: req.signal });
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it.each(["head", "get"] as const)("maps a deleted storage object in %s to 404", async (operation) => {
    mocks[operation].mockRejectedValue(new BlobNotFoundError());
    const response = await GET(request(operation === "head" ? { Range: "bytes=0-9" } : {}), context);
    expect(response.status).toBe(404);
  });
});

describe("media byte ranges", () => {
  it.each([
    ["bytes=20-29", "bytes=20-29", "bytes 20-29/100", 10],
    ["bytes=90-", "bytes=90-99", "bytes 90-99/100", 10],
    ["bytes=-10", "bytes=90-99", "bytes 90-99/100", 10],
    ["bytes=90-999", "bytes=90-99", "bytes 90-99/100", 10],
  ])("streams %s as a verified partial response using the actual object size", async (range, normalized, contentRange, size) => {
    mocks.document.mockResolvedValue({ ...document, filename: "Interview.mp3", contentType: "audio/mp3" });
    const blob = blobResult({ range: contentRange, type: "audio/mpeg", size });
    mocks.get.mockResolvedValue(blob);
    const req = request({ Range: range });
    const response = await GET(req, context);
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect(response.headers.get("content-length")).toBe(String(size));
    expect(mocks.get).toHaveBeenCalledWith(document.blobPath, { access: "private", abortSignal: req.signal, headers: { "Accept-Encoding": "identity", Range: normalized } });
    expect(blob.pull).not.toHaveBeenCalled();
    expect(response.body).toBe(blob.stream);
    expect(await response.text()).toHaveLength(size);
  });

  it.each(["bytes=100-", "bytes=20-19", "bytes=-0", "bytes=0-1,3-4", "bytes=", "items=0-9"])("rejects invalid or unsupported %s before a body request", async (range) => {
    const response = await GET(request({ Range: range }), context);
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */100");
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it.each([
    { size: 100 },
    { size: 10, range: "bytes 0-9/999" },
    { size: 9, range: "bytes 0-9/100" },
    { size: 10, range: "bytes 0-9/100", etag: '"changed-version"' },
  ])("cancels an ignored, invalid or changed upstream range without buffering", async (options) => {
    const blob = blobResult(options); mocks.get.mockResolvedValue(blob);
    const response = await GET(request({ Range: "bytes=0-9" }), context);
    expect(response.status).toBe(502);
    expect(blob.cancel).toHaveBeenCalledOnce();
    expect(blob.pull).not.toHaveBeenCalled();
  });

  it("returns the full current object when If-Range no longer matches", async () => {
    const response = await GET(request({ Range: "bytes=0-9", "If-Range": '"previous-version"' }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
    expect(mocks.get.mock.calls[0][1].headers).toEqual({ "Accept-Encoding": "identity" });
  });
});

describe("range and inline-type validation", () => {
  it("bounds ranges including large suffixes and rejects unsafe numbers or empty files", () => {
    expect(parseByteRange("bytes=-200", 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=0-0", 1)).toEqual({ start: 0, end: 0 });
    for (const range of ["bytes=0-9007199254740992", "bytes=-9007199254740992", "bytes=--1", "bytes=-", "bytes=0-1\nX-Injected: yes"]) {
      expect(parseByteRange(range, 100)).toBeNull();
    }
    expect(parseByteRange("bytes=0-0", 0)).toBeNull();
  });
  it("permits only known extensions with agreeing PDF or MP3 MIME types", () => {
    expect(inlineContentType("MANUAL.PDF", "Application/PDF", "application/pdf; charset=binary")).toBe("application/pdf");
    expect(inlineContentType("Audio.mp3", "audio/mp3", "audio/mpeg")).toBe("audio/mpeg");
    expect(inlineContentType("Manual.pdf", "application/octet-stream", "application/pdf")).toBeNull();
    expect(inlineContentType("html.svg", "image/svg+xml", "image/svg+xml")).toBeNull();
  });
  it("requires strong matching validators or an unmodified HTTP date", () => {
    expect(ifRangeMatches(null, metadata.etag, metadata.uploadedAt)).toBe(true);
    expect(ifRangeMatches(metadata.etag, metadata.etag, metadata.uploadedAt)).toBe(true);
    expect(ifRangeMatches('W/"version-1"', metadata.etag, metadata.uploadedAt)).toBe(false);
    expect(ifRangeMatches(metadata.uploadedAt.toUTCString(), metadata.etag, metadata.uploadedAt)).toBe(true);
    expect(ifRangeMatches("Mon, 31 Aug 2026 12:30:00 GMT", metadata.etag, metadata.uploadedAt)).toBe(false);
    expect(ifRangeMatches("invalid", metadata.etag, metadata.uploadedAt)).toBe(false);
  });
});
