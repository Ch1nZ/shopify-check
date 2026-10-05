import { CollectionError, validatePublicHttpsUrl, validatePublicProductUrl } from "./security";
import type { RawSnapshot } from "./types";

const MAX_REDIRECTS = 5;
const HTML_LIMIT = 2 * 1024 * 1024;
const JSON_LIMIT = 1024 * 1024;
const ROBOTS_LIMIT = 256 * 1024;
const TIMEOUT_MS = 12_000;

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function fetchSnapshot(
  requestedUrl: URL,
  kind: RawSnapshot["kind"],
  fetcher: FetchLike = fetch,
  capturedAt = new Date().toISOString(),
): Promise<RawSnapshot> {
  const validate = kind === "robots" ? validatePublicHttpsUrl : validatePublicProductUrl;
  let current = validate(requestedUrl.toString());
  const initial = current.toString();
  const deadline = Date.now() + TIMEOUT_MS;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const controller = new AbortController();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new CollectionError("FETCH_TIMEOUT", "The product source timed out.", 504);
    }
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    let response: Response;
    try {
      response = await fetcher(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept:
            kind === "html"
              ? "text/html,application/xhtml+xml"
              : kind === "robots"
                ? "text/plain,text/html;q=0.5"
                : "application/json",
          "User-Agent": "shopify-check/0.1 (+https://github.com/Ch1nZ/shopify-check)",
        },
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof CollectionError) throw error;
      if (isAbortError(error)) {
        throw new CollectionError("FETCH_TIMEOUT", "The product source timed out.", 504);
      }
      throw new CollectionError(
        "FETCH_FAILED",
        error instanceof Error ? `Product fetch failed: ${error.message}` : "Product fetch failed.",
        502,
      );
    }

    if (isRedirect(response.status)) {
      clearTimeout(timeout);
      const location = response.headers.get("location");
      if (!location) throw new CollectionError("INVALID_REDIRECT", "Redirect has no destination.", 502);
      if (redirects === MAX_REDIRECTS) {
        throw new CollectionError("TOO_MANY_REDIRECTS", "The product page redirects too many times.", 502);
      }
      const redirectUrl = validatePublicHttpsUrl(new URL(location, current).toString());
      if (kind !== "robots") {
        try {
          // Preserve a submitted selection when a same-store product redirect omits it.
          if (kind === "html" && redirectUrl.origin === current.origin && !redirectUrl.searchParams.has("variant")) {
            const variant = current.searchParams.get("variant");
            if (variant) redirectUrl.searchParams.set("variant", variant);
          }
          current = validatePublicProductUrl(redirectUrl.toString());
        } catch (error) {
          if (error instanceof CollectionError && error.code === "UNSUPPORTED_PRODUCT_PATH") {
            throw new CollectionError(
              "PRODUCT_REDIRECTED_AWAY",
              "This Shopify link redirects to a collection or another non-product page. The URL format is valid; paste the store's current product-page URL.",
              422,
            );
          }
          throw error;
        }
      } else {
        current = redirectUrl;
      }
      continue;
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const allowed =
      kind === "html"
        ? contentType.includes("text/html") || contentType.includes("application/xhtml+xml")
        : kind === "robots"
          ? contentType.includes("text/plain") || contentType.includes("text/html")
          : contentType.includes("application/json") || contentType.includes("text/javascript");
    if (!allowed) {
      clearTimeout(timeout);
      throw new CollectionError("UNSUPPORTED_RESPONSE", `Unexpected ${kind} content type.`, 502);
    }

    let body: string;
    try {
      body = await readBoundedText(
        response,
        kind === "html" ? HTML_LIMIT : kind === "robots" ? ROBOTS_LIMIT : JSON_LIMIT,
      );
    } catch (error) {
      if (error instanceof CollectionError) throw error;
      if (isAbortError(error)) {
        throw new CollectionError("FETCH_TIMEOUT", "The product source timed out.", 504);
      }
      throw new CollectionError(
        "FETCH_FAILED",
        error instanceof Error ? `Product response failed: ${error.message}` : "Product response failed.",
        502,
      );
    } finally {
      clearTimeout(timeout);
    }
    return {
      kind,
      requested_url: initial,
      final_url: current.toString(),
      status: response.status,
      content_type: contentType,
      captured_at: capturedAt,
      headers: selectedHeaders(response.headers),
      body,
    };
  }

  throw new CollectionError("FETCH_FAILED", "Product fetch failed.", 502);
}

function selectedHeaders(headers: Headers): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of ["x-robots-tag"]) {
    const value = headers.get(name);
    if (value) selected[name] = value;
  }
  return selected;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    throw new CollectionError("RESPONSE_TOO_LARGE", "The product response is too large.", 502);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel("bounded response limit exceeded");
        throw new CollectionError("RESPONSE_TOO_LARGE", "The product response is too large.", 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
