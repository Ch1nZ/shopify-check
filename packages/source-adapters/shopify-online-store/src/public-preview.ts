import { productProfile, type ProductPreviewFields } from "./product-profile";
import {
  PREVIEW_RULE_CATALOG_VERSION,
  evaluatePreviewCapture,
  evaluatePresence,
  formatFindingEvidence,
  type EvaluatedPreviewFinding,
  type EvaluatedPresence,
  type FindingStatus,
  type PreviewEvidence,
} from "./preview-rules";
import type { ShopifyCollection } from "./types";

export type PublicPreviewField = ProductPreviewFields[keyof ProductPreviewFields];
export type PublicPreviewFindingStatus = FindingStatus;
export type PublicPreviewEvidence = PreviewEvidence;

export type PublicPreviewPresence = {
  key: string;
  label: string;
  state: FindingStatus;
  field: string;
  sources: string[];
  relevant: boolean;
};

export type PublicPreviewFinding = {
  code: string;
  definition_id: string;
  definition_version: string;
  severity: "info" | "warning" | "error";
  status: FindingStatus;
  message: string;
  evidence: PreviewEvidence[];
  guidance: string;
  relevant: boolean;
};

export type PublicProductPreview = {
  status: "complete" | "partial";
  product_url: string;
  captured_at: string;
  rule_catalog_version: string;
  fields: ProductPreviewFields;
  presence: PublicPreviewPresence[];
  crawler_access: ShopifyCollection["technicalCheck"]["crawler_access"];
  findings: PublicPreviewFinding[];
  finding_counts: { error: number; warning: number; info: number };
  variant_summary?: { total: number; with_sku: number; available: number; unknown_availability: number };
  note: string;
};

export function publicProductPreview(collection: ShopifyCollection): PublicProductPreview {
  const profile = productProfile(collection.record);
  const evaluated = evaluatePreviewCapture(collection);
  const findings = evaluated.findings.map(toPublicFinding);
  return {
    status: collection.technicalCheck.status,
    product_url: collection.record.final_url,
    captured_at: collection.record.captured_at,
    rule_catalog_version: PREVIEW_RULE_CATALOG_VERSION,
    fields: profile.previewFields,
    variant_summary: {
      total: collection.record.variants.length,
      with_sku: collection.record.variants.filter((variant) => variant.sku).length,
      available: collection.record.variants.filter((variant) => variant.available === true).length,
      unknown_availability: collection.record.variants.filter((variant) => variant.available === null).length,
    },
    presence: evaluated.presence.map(toPublicPresence),
    crawler_access: collection.technicalCheck.crawler_access,
    findings,
    finding_counts: countFindings(findings),
    note: "This free preview checks observable product data only. It does not run the controlled AI shopping test.",
  };
}

export function publicPreviewPresence(record: ShopifyCollection["record"]): PublicPreviewPresence[] {
  return evaluatePresence(record).map(toPublicPresence);
}

export function publicPreviewFindings(collection: ShopifyCollection): PublicPreviewFinding[] {
  return evaluatePreviewCapture(collection).findings.map(toPublicFinding);
}

export { formatFindingEvidence };

function toPublicFinding(finding: EvaluatedPreviewFinding): PublicPreviewFinding {
  return {
    code: finding.code,
    definition_id: finding.definition_id,
    definition_version: finding.definition_version,
    severity: finding.severity,
    status: finding.status,
    message: finding.message,
    evidence: finding.evidence,
    guidance: finding.guidance,
    relevant: finding.relevant,
  };
}

function toPublicPresence(item: EvaluatedPresence): PublicPreviewPresence {
  return {
    key: item.key,
    label: item.label,
    state: item.state,
    field: item.field,
    sources: item.sources,
    relevant: item.relevant,
  };
}

function countFindings(findings: PublicPreviewFinding[]): PublicProductPreview["finding_counts"] {
  return findings.reduce(
    (counts, finding) => ({ ...counts, [finding.severity]: counts[finding.severity] + 1 }),
    { error: 0, warning: 0, info: 0 },
  );
}
