import type { ArtifactLinks } from "./components/TechnicalReport";

export function splitList(value: string): string[] {
  return value.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
}

export function taskArtifactLinks(taskId: string): ArtifactLinks {
  const base = `/api/v1/tasks/${taskId}/artifacts`;
  return {
    product_record: `${base}/product-record?download=1`,
    technical_check: `${base}/technical-check?download=1`,
    evidence_pack: `${base}/evidence-pack?download=1`,
    html: `${base}/html?download=1`,
    shopify_ajax: `${base}/shopify-ajax?download=1`,
    robots: `${base}/robots?download=1`,
  };
}
