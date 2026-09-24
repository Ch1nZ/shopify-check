import {
  CONTRACT_VERSIONS,
  EvidencePackSchema,
  type EvidenceItem,
  type EvidencePack,
} from "@mclab/contracts";
import type { ProductRecord } from "@mclab/shopify-online-store";

export async function buildEvidencePack(
  collectionId: string,
  record: ProductRecord,
): Promise<EvidencePack> {
  const drafts: Omit<EvidenceItem, "id" | "sha256">[] = [];

  for (const [fieldName, field] of Object.entries(record.fields)) {
    for (const observation of field.observations) {
      drafts.push({
        source: observation.source,
        path: `fields.${fieldName}.${observation.path}`,
        text: String(observation.value).trim(),
        captured_url: observation.captured_url,
        captured_at: observation.captured_at,
      });
    }
  }

  for (const [index, variant] of record.variants.slice(0, 50).entries()) {
    drafts.push({
      source: "shopify_ajax",
      path: `variants[${index}]`,
      text: JSON.stringify({
        title: variant.title,
        sku: variant.sku,
        barcode: variant.barcode,
        price_minor: variant.price_minor,
        available: variant.available,
        options: variant.options,
      }),
      captured_url: record.final_url,
      captured_at: record.captured_at,
    });
  }

  const unique = new Map<string, Omit<EvidenceItem, "id" | "sha256">>();
  for (const draft of drafts) {
    if (!draft.text) continue;
    unique.set(`${draft.source}\u0000${draft.path}\u0000${draft.text}`, draft);
  }

  const items: EvidenceItem[] = [];
  for (const draft of [...unique.values()].slice(0, 200)) {
    const sha256 = await sha256Hex(`${draft.source}\n${draft.path}\n${draft.text}`);
    items.push({ ...draft, sha256, id: `ev_${sha256.slice(0, 16)}` });
  }

  return EvidencePackSchema.parse({
    schema_version: CONTRACT_VERSIONS.evidenceObservation,
    collection_id: collectionId,
    product_url: record.final_url,
    captured_at: record.captured_at,
    items,
  });
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
