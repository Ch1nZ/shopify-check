const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google",
  "instance-data",
]);

export function validatePublicProductUrl(rawUrl: string): URL {
  const url = validatePublicHttpsUrl(rawUrl);

  const segments = url.pathname.split("/").filter(Boolean);
  const productsIndex = segments.lastIndexOf("products");
  if (productsIndex < 0 || productsIndex !== segments.length - 2 || !segments[productsIndex + 1]) {
    throw new CollectionError(
      "UNSUPPORTED_PRODUCT_PATH",
      "Use a Shopify product URL ending in /products/{handle}.",
      400,
    );
  }
  return url;
}

export function validatePublicHttpsUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CollectionError("INVALID_URL", "The product URL is invalid.", 400);
  }

  if (url.protocol !== "https:") {
    throw new CollectionError("HTTPS_REQUIRED", "Only HTTPS product URLs are supported.", 400);
  }
  if (url.username || url.password) {
    throw new CollectionError("CREDENTIALS_NOT_ALLOWED", "Authenticated URLs are not supported.", 400);
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !hostname ||
    BLOCKED_HOSTS.has(hostname) ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".localhost") ||
    isIpLiteral(hostname)
  ) {
    throw new CollectionError("PRIVATE_TARGET", "Local, private, and IP-address targets are not supported.", 400);
  }

  url.hash = "";
  return url;
}

export function shopifyAjaxUrl(productUrl: URL): URL {
  const url = new URL(productUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}.js`;
  url.search = "";
  url.hash = "";
  return url;
}

function isIpLiteral(hostname: string): boolean {
  if (hostname.includes(":")) return true;
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return false;
  return parts.every((part) => Number(part) <= 255);
}

export class CollectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
