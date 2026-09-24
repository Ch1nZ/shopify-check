const MEDIA_TYPE_PREFIXES = ["video/", "audio/"];

export function parseBytesRange(
  header: string,
  size: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || size <= 0) return null;

  const startRaw = match[1];
  const endRaw = match[2];
  if (startRaw === "" && endRaw === "") return null;

  if (startRaw === "") {
    const suffix = Number(endRaw);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startRaw);
  const end = endRaw === "" ? size - 1 : Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

export async function applyMediaByteRange(request: Request, response: Response): Promise<Response> {
  if (response.status !== 200 && response.status !== 206) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!MEDIA_TYPE_PREFIXES.some((prefix) => contentType.startsWith(prefix))) return response;

  if (response.status === 206) {
    const headers = new Headers(response.headers);
    if (!headers.has("Accept-Ranges")) headers.set("Accept-Ranges", "bytes");
    return new Response(response.body, {
      status: 206,
      statusText: "Partial Content",
      headers,
    });
  }

  const headers = new Headers(response.headers);
  headers.set("Accept-Ranges", "bytes");
  const rangeHeader = request.headers.get("Range");
  if (!rangeHeader) {
    return new Response(response.body, { status: 200, statusText: response.statusText, headers });
  }

  const body = await response.arrayBuffer();
  const size = body.byteLength;
  const parsed = parseBytesRange(rangeHeader, size);
  if (!parsed) {
    headers.set("Content-Range", `bytes */${size}`);
    headers.delete("Content-Length");
    return new Response(null, { status: 416, statusText: "Range Not Satisfiable", headers });
  }

  const { start, end } = parsed;
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(body.slice(start, end + 1), {
    status: 206,
    statusText: "Partial Content",
    headers,
  });
}
