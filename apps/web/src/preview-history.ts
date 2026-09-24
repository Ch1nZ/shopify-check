import type { PreviewSnapshot } from "@mclab/shopify-online-store";

const STORAGE_KEY = "mclab.free-preview.lastByUrl.v1";
const MAX_ENTRIES = 20;

export function readPreviewSnapshot(productUrl: string): PreviewSnapshot | null {
  const stored = readStore();
  return stored[normalizePreviewUrl(productUrl)] ?? null;
}

export function rememberPreviewSnapshot(snapshot: PreviewSnapshot, aliases: string[] = []): void {
  if (typeof window === "undefined") return;
  const stored = readStore();
  const keys = [...new Set([snapshot.product_url, ...aliases].map(normalizePreviewUrl).filter(Boolean))];
  for (const key of keys) stored[key] = snapshot;

  const overflow = Object.keys(stored).length - MAX_ENTRIES;
  if (overflow > 0) {
    const oldest = Object.entries(stored)
      .sort((left, right) => Date.parse(left[1].captured_at ?? "") - Date.parse(right[1].captured_at ?? ""))
      .slice(0, overflow);
    for (const [key] of oldest) delete stored[key];
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Private mode or quota: the result card still works without a recheck baseline.
  }
}

export function normalizePreviewUrl(productUrl: string): string {
  try {
    const url = new URL(productUrl);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
    return url.toString();
  } catch {
    return productUrl.trim();
  }
}

function readStore(): Record<string, PreviewSnapshot> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, PreviewSnapshot>;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}
