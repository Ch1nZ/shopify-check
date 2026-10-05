import type { PublicProductPreview } from "@mclab/shopify-online-store";

export function evidenceStateLabel(state: PublicProductPreview["fields"]["price"]["state"]): string {
  return state === "verified" ? "Sources agree" : state === "single_source" ? "Extracted from one source" : state === "incomplete" ? "Evidence unavailable" : state.replaceAll("_", " ");
}

export function priceScopeLabel(context: NonNullable<PublicProductPreview["price_context"]>): string {
  if (context.scope === "variant") return `Selected variant: ${context.variant_title ?? context.variant_id}. Price and availability refer to this variant.`;
  if (context.scope === "unresolved_variant") return `Selected variant ${context.variant_id} could not be resolved. Its price and availability are unavailable; recheck the variant URL.`;
  if (context.minimum_minor === null) return "Product-level check: no minimum price could be extracted.";
  const range = context.minimum_minor !== null && context.maximum_minor !== null && context.minimum_minor !== context.maximum_minor
    ? ` Captured variant range: ${(context.minimum_minor / 100).toFixed(2)}–${(context.maximum_minor / 100).toFixed(2)} ${context.currency ?? "(currency unresolved)"}.` : "";
  return `Product-level check: price is the captured minimum, not a selected variant price.${range}`;
}
