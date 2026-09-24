import { load } from "cheerio";
import { z } from "zod";

import type { ParsedHtml, ProductVariant, ShopifyAjaxProduct } from "./types";

const AjaxVariantSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string().default(""),
  sku: z.union([z.string(), z.null()]).optional(),
  barcode: z.union([z.string(), z.null()]).optional(),
  price: z.union([z.string(), z.number()]).optional(),
  compare_at_price: z.union([z.string(), z.number(), z.null()]).optional(),
  available: z.boolean().optional(),
  options: z.array(z.string()).optional(),
});

const AjaxProductSchema = z.object({
  id: z.union([z.string(), z.number()]),
  handle: z.string().min(1),
  title: z.string().min(1),
  vendor: z.union([z.string(), z.null()]).optional(),
  type: z.union([z.string(), z.null()]).optional(),
  description: z.union([z.string(), z.null()]).optional(),
  available: z.boolean().optional(),
  price: z.union([z.string(), z.number()]).optional(),
  compare_at_price: z.union([z.string(), z.number(), z.null()]).optional(),
  featured_image: z.union([z.string(), z.null()]).optional(),
  images: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  variants: z.array(AjaxVariantSchema).default([]),
});

export function parseProductHtml(html: string): ParsedHtml {
  const $ = load(html);
  const og: Record<string, string> = {};
  $("meta[property^='og:'], meta[property^='product:']").each((_, element) => {
    const property = $(element).attr("property")?.trim().toLowerCase();
    const content = $(element).attr("content")?.trim();
    if (property && content && !(property in og)) og[property] = content;
  });

  const jsonLdProducts: Array<Record<string, unknown>> = [];
  const jsonLdBreadcrumbLists: Array<Record<string, unknown>> = [];
  let jsonLdParseErrors = 0;
  $("script[type='application/ld+json']").each((_, element) => {
    const raw = $(element).text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      collectTypedNodes(parsed, "Product", jsonLdProducts);
      collectTypedNodes(parsed, "BreadcrumbList", jsonLdBreadcrumbLists);
    } catch {
      jsonLdParseErrors += 1;
    }
  });

  const passwordMarkup =
    $(".shopify-section-password, [id*='shopify-section-password'], form[action*='/password']")
      .length > 0;
  const challengeMarkup =
    $("#shopify-challenge, .shopify-challenge__container, form[action*='/challenge'], iframe[src*='captcha']")
      .length > 0;
  const metaRobots = $("meta[name]")
    .toArray()
    .filter((element) => {
      const name = $(element).attr("name")?.trim().toLowerCase();
      return name === "robots";
    })
    .flatMap((element) => splitDirectives($(element).attr("content")));

  $("script, style, noscript, template, svg").remove();
  const visibleText = normalizeWhitespace($("body").text());
  const lowerText = visibleText.toLowerCase();

  return {
    canonicalUrl: firstAttribute($, "link[rel~='canonical']", "href"),
    title: firstText($, "title"),
    metaDescription: firstAttribute($, "meta[name='description']", "content"),
    h1: firstText($, "h1"),
    og,
    visibleText,
    jsonLdProducts,
    jsonLdBreadcrumbLists,
    jsonLdParseErrors,
    passwordPage: passwordMarkup || lowerText.includes("enter store using password"),
    challengePage: challengeMarkup || lowerText.includes("verify you are human"),
    metaRobots: [...new Set(metaRobots)],
  };
}

function splitDirectives(value: string | undefined): string[] {
  return value
    ? value.split(",").map((directive) => directive.trim().toLowerCase()).filter(Boolean)
    : [];
}

export function parseShopifyAjax(body: string): ShopifyAjaxProduct {
  const raw = JSON.parse(body) as unknown;
  const product = AjaxProductSchema.parse(raw);
  const variants: ProductVariant[] = product.variants.map((variant) => ({
    id: String(variant.id),
    title: variant.title,
    sku: nonEmpty(variant.sku),
    barcode: nonEmpty(variant.barcode),
    price_minor: minorUnits(variant.price),
    compare_at_price_minor: minorUnits(variant.compare_at_price),
    available: variant.available ?? null,
    options: variant.options ?? [],
  }));

  return {
    id: String(product.id),
    handle: product.handle,
    title: product.title,
    vendor: nonEmpty(product.vendor),
    productType: nonEmpty(product.type),
    description: nonEmpty(stripHtml(product.description)),
    available: product.available ?? aggregateAvailability(variants),
    priceMinor: minorUnits(product.price) ?? minimum(variants.map((variant) => variant.price_minor)),
    compareAtPriceMinor:
      minorUnits(product.compare_at_price) ??
      minimum(variants.map((variant) => variant.compare_at_price_minor)),
    featuredImage: nonEmpty(product.featured_image),
    images: product.images.map((image) => nonEmpty(image)).filter((image): image is string => image !== null),
    tags: product.tags.map((tag) => tag.trim()).filter(Boolean),
    variants,
  };
}

export function jsonLdImageUrls(value: unknown): string[] {
  const urls: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) urls.push(trimmed);
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (isRecord(item)) {
      const candidate = item.url ?? item.contentUrl;
      if (typeof candidate === "string" && candidate.trim()) urls.push(candidate.trim());
    }
  };
  visit(value);
  return [...new Set(urls)];
}

export function jsonLdCompactText(value: unknown, limit = 4_000): string | null {
  const compact = compactJsonLd(value);
  if (compact === null) return null;
  if (typeof compact === "string") return compact;
  if (typeof compact === "number" || typeof compact === "boolean") return String(compact);
  try {
    const text = JSON.stringify(compact);
    if (!text || text === "{}" || text === "[]") return null;
    return text.length > limit ? text.slice(0, limit) : text;
  } catch {
    return null;
  }
}

export function breadcrumbNames(list: Record<string, unknown>): string[] {
  const raw = list.itemListElement;
  const elements = Array.isArray(raw) ? raw : isRecord(raw) ? [raw] : [];
  return elements
    .filter(isRecord)
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
    .map((element) => listItemName(element))
    .filter((name): name is string => name !== null);
}

function compactJsonLd(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.map(compactJsonLd).filter((item) => item !== null);
    return items.length ? items : null;
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "@context") continue;
      const compact = compactJsonLd(child);
      if (compact !== null) output[key] = compact;
    }
    return Object.keys(output).length ? output : null;
  }
  return null;
}

function listItemName(element: Record<string, unknown>): string | null {
  if (typeof element.name === "string" && element.name.trim()) return element.name.trim();
  const item = element.item;
  if (isRecord(item) && typeof item.name === "string" && item.name.trim()) return item.name.trim();
  return null;
}

export function jsonLdOffers(product: Record<string, unknown>): Array<Record<string, unknown>> {
  const offers = product.offers;
  if (Array.isArray(offers)) return offers.filter(isRecord);
  if (isRecord(offers)) {
    if (Array.isArray(offers.offers)) return offers.offers.filter(isRecord);
    return [offers];
  }
  return [];
}

function collectTypedNodes(
  value: unknown,
  targetType: string,
  output: Array<Record<string, unknown>>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectTypedNodes(item, targetType, output);
    return;
  }
  if (!isRecord(value)) return;

  const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  if (types.some((type) => typeof type === "string" && type.toLowerCase() === targetType.toLowerCase())) {
    output.push(value);
  }
  for (const child of Object.values(value)) collectTypedNodes(child, targetType, output);
}

function firstAttribute(
  $: ReturnType<typeof load>,
  selector: string,
  attribute: string,
): string | null {
  return nonEmpty($(selector).first().attr(attribute));
}

function firstText($: ReturnType<typeof load>, selector: string): string | null {
  return nonEmpty(normalizeWhitespace($(selector).first().text()));
}

function stripHtml(value: string | null | undefined): string | null {
  if (!value) return null;
  return normalizeWhitespace(load(`<body>${value}</body>`)("body").text());
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function minorUnits(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function aggregateAvailability(variants: ProductVariant[]): boolean | null {
  const known = variants.map((variant) => variant.available).filter((value) => value !== null);
  return known.length ? known.some(Boolean) : null;
}

function minimum(values: Array<number | null>): number | null {
  const available = values.filter((value): value is number => value !== null);
  return available.length ? Math.min(...available) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
