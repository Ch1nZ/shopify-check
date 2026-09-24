import type { EvidenceState } from "@mclab/contracts";

import type { NormalizedField, ProductRecord } from "./types";

export type ProductProfileFacts = {
  requested_url: string;
  final_url: string;
  canonical_url: string | null;
  title: string | null;
  brand: string | null;
  category: string | null;
  description: string | null;
  currency: string | null;
  price_minor: number | null;
  availability: boolean | null;
  sku: string | null;
  barcode: string | null;
  image: string | null;
  shipping_details: string | null;
  merchant_return_policy: string | null;
  warranty: string | null;
  taxonomy_hints: string | null;
  variant_options: string[][];
  field_states: Record<string, EvidenceState>;
};

export type ProductPreviewFields = {
  title: { state: EvidenceState; value: string | number | boolean | null };
  category: { state: EvidenceState; value: string | number | boolean | null };
  price: { state: EvidenceState; value: string | number | boolean | null };
  currency: { state: EvidenceState; value: string | number | boolean | null };
  availability: { state: EvidenceState; value: string | number | boolean | null };
};

export type ProductProfile = {
  facts: ProductProfileFacts;
  previewFields: ProductPreviewFields;
};

export function productProfile(record: ProductRecord): ProductProfile {
  const preview = (field: NormalizedField) => ({ state: field.state, value: field.value });
  return {
    facts: {
      requested_url: record.requested_url,
      final_url: record.final_url,
      canonical_url: scalarText(record.fields.canonical_url.value),
      title: scalarText(record.fields.title.value),
      brand: scalarText(record.fields.vendor_brand.value),
      category: scalarText(record.fields.product_type_category.value),
      description: scalarText(record.fields.description.value)?.slice(0, 8_000) ?? null,
      currency: scalarText(record.fields.currency.value),
      price_minor: typeof record.fields.price.value === "number" ? record.fields.price.value : null,
      availability: typeof record.fields.availability.value === "boolean" ? record.fields.availability.value : null,
      sku: scalarText(record.fields.sku.value),
      barcode: scalarText(record.fields.barcode.value),
      image: scalarText(record.fields.image.value),
      shipping_details: scalarText(record.fields.shipping_details.value),
      merchant_return_policy: scalarText(record.fields.merchant_return_policy.value),
      warranty: scalarText(record.fields.warranty.value),
      taxonomy_hints: scalarText(record.fields.taxonomy_hints.value),
      variant_options: record.variants.slice(0, 12).map((variant) => variant.options),
      field_states: Object.fromEntries(
        Object.entries(record.fields).map(([key, field]) => [key, field.state]),
      ),
    },
    previewFields: {
      title: preview(record.fields.title),
      category: preview(record.fields.product_type_category),
      price: preview(record.fields.price),
      currency: preview(record.fields.currency),
      availability: preview(record.fields.availability),
    },
  };
}

function scalarText(value: string | number | boolean | null): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
