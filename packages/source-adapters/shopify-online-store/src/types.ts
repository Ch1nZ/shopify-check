import type { EvidenceState } from "@mclab/contracts";

export type SourceKind = "shopify_ajax" | "json_ld" | "html_meta" | "visible_html";

export type EvidenceObservation = {
  source: SourceKind;
  path: string;
  value: string | number | boolean;
  captured_url: string;
  captured_at: string;
};

export type NormalizedField = {
  state: EvidenceState;
  value: string | number | boolean | null;
  observations: EvidenceObservation[];
};

export type ProductVariant = {
  id: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  price_minor: number | null;
  compare_at_price_minor: number | null;
  available: boolean | null;
  options: string[];
};

export type TechnicalFinding = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  evidence_paths: string[];
};

export type RobotsAgentResult = {
  agent: "*" | "OAI-SearchBot" | "GPTBot";
  purpose: "general_crawl" | "openai_search" | "openai_training";
  result: "allowed" | "blocked" | "unknown";
  matched_user_agent: string | null;
  matched_rule: string | null;
};

export type TechnicalCheck = {
  schema_version: "technical-check/1.0";
  product_url: string;
  captured_at: string;
  status: "complete" | "partial";
  page_directives: {
    meta_robots: string[];
    x_robots_tag: string[];
  };
  robots_url: string;
  robots_http_status: number | null;
  crawler_access: RobotsAgentResult[];
  findings: TechnicalFinding[];
};

export type ProductRecord = {
  schema_version: "product-record/1.0";
  requested_url: string;
  final_url: string;
  captured_at: string;
  collection_status: "complete" | "partial" | "blocked";
  fields: {
    product_id: NormalizedField;
    handle: NormalizedField;
    canonical_url: NormalizedField;
    title: NormalizedField;
    description: NormalizedField;
    vendor_brand: NormalizedField;
    product_type_category: NormalizedField;
    currency: NormalizedField;
    price: NormalizedField;
    availability: NormalizedField;
    sku: NormalizedField;
    barcode: NormalizedField;
    image: NormalizedField;
    shipping_details: NormalizedField;
    merchant_return_policy: NormalizedField;
    warranty: NormalizedField;
    taxonomy_hints: NormalizedField;
  };
  variants: ProductVariant[];
  json_ld_product_count: number;
  technical_findings: TechnicalFinding[];
};

export type RawSnapshot = {
  kind: "html" | "shopify_ajax" | "robots";
  requested_url: string;
  final_url: string;
  status: number;
  content_type: string;
  captured_at: string;
  headers: Record<string, string>;
  body: string;
};

export type ParsedHtml = {
  canonicalUrl: string | null;
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  og: Record<string, string>;
  visibleText: string;
  jsonLdProducts: Array<Record<string, unknown>>;
  jsonLdBreadcrumbLists: Array<Record<string, unknown>>;
  jsonLdParseErrors: number;
  passwordPage: boolean;
  challengePage: boolean;
  metaRobots: string[];
};

export type ShopifyAjaxProduct = {
  id: string;
  handle: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  description: string | null;
  available: boolean | null;
  priceMinor: number | null;
  compareAtPriceMinor: number | null;
  featuredImage: string | null;
  images: string[];
  tags: string[];
  variants: ProductVariant[];
};

export type ShopifyCollection = {
  record: ProductRecord;
  technicalCheck: TechnicalCheck;
  snapshots: RawSnapshot[];
};
