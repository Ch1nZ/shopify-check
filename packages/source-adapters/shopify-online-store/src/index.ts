export {
  CollectionError,
  shopifyAjaxUrl,
  validatePublicHttpsUrl,
  validatePublicProductUrl,
} from "./security";
export { fetchSnapshot, type FetchLike } from "./fetch";
export { normalizeProduct } from "./normalize";
export { parseProductHtml, parseShopifyAjax, jsonLdOffers, jsonLdImageUrls, jsonLdCompactText, breadcrumbNames } from "./parse";
export { productProfile } from "./product-profile";
export type { ProductProfile, ProductProfileFacts, ProductPreviewFields } from "./product-profile";
export { publicProductPreview, publicPreviewFindings, publicPreviewPresence, formatFindingEvidence } from "./public-preview";
export type {
  PublicPreviewEvidence,
  PublicPreviewField,
  PublicPreviewFinding,
  PublicPreviewFindingStatus,
  PublicPreviewPresence,
  PublicProductPreview,
} from "./public-preview";
export {
  PREVIEW_RULE_CATALOG_VERSION,
  evaluatePreviewCapture,
  productRelevance,
} from "./preview-rules";
export type {
  EvaluatedPreviewFinding,
  FindingStatus,
  PreviewEvidence,
} from "./preview-rules";
export {
  previewReadiness,
  previewRecheckDiff,
  previewSnapshot,
} from "./preview-readiness";
export type {
  PreviewCheck,
  PreviewCheckOutcome,
  PreviewFix,
  PreviewReadiness,
  PreviewRecheckChange,
  PreviewRecheckDiff,
  PreviewSnapshot,
} from "./preview-readiness";
export { buildTechnicalCheck, evaluateAgent } from "./robots";
export type * from "./types";

import { fetchSnapshot, type FetchLike } from "./fetch";
import { normalizeProduct } from "./normalize";
import { parseProductHtml, parseShopifyAjax } from "./parse";
import { buildTechnicalCheck } from "./robots";
import { CollectionError, shopifyAjaxUrl, validatePublicProductUrl } from "./security";
import type { ShopifyCollection } from "./types";

export async function collectShopifyProduct(
  rawUrl: string,
  options: { fetcher?: FetchLike; capturedAt?: string } = {},
): Promise<ShopifyCollection> {
  const requestedUrl = validatePublicProductUrl(rawUrl);
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const htmlSnapshot = await fetchSnapshot(requestedUrl, "html", options.fetcher, capturedAt);

  if (htmlSnapshot.status < 200 || htmlSnapshot.status >= 300) {
    throw new CollectionError(
      "PRODUCT_PAGE_UNAVAILABLE",
      `The product page returned HTTP ${htmlSnapshot.status}.`,
      502,
    );
  }

  const parsedHtml = parseProductHtml(htmlSnapshot.body);
  let ajax = null;
  let ajaxError: string | undefined;
  const snapshots = [htmlSnapshot];
  const finalProductUrl = new URL(htmlSnapshot.final_url);
  const [ajaxResult, robotsResult] = await Promise.allSettled([
    fetchSnapshot(shopifyAjaxUrl(finalProductUrl), "shopify_ajax", options.fetcher, capturedAt),
    fetchSnapshot(new URL("/robots.txt", finalProductUrl), "robots", options.fetcher, capturedAt),
  ]);

  if (ajaxResult.status === "fulfilled") {
    const ajaxSnapshot = ajaxResult.value;
    snapshots.push(ajaxSnapshot);
    if (ajaxSnapshot.status < 200 || ajaxSnapshot.status >= 300) {
      ajaxError = `Shopify Ajax product JSON returned HTTP ${ajaxSnapshot.status}.`;
    } else {
      try {
        ajax = parseShopifyAjax(ajaxSnapshot.body);
      } catch (error) {
        ajaxError = error instanceof Error ? error.message : "Shopify Ajax product JSON was invalid.";
      }
    }
  } else {
    ajaxError =
      ajaxResult.reason instanceof Error
        ? ajaxResult.reason.message
        : "Shopify Ajax product JSON was unavailable.";
  }

  const robotsSnapshot = robotsResult.status === "fulfilled" ? robotsResult.value : null;
  if (robotsSnapshot) snapshots.push(robotsSnapshot);
  const robotsError =
    robotsResult.status === "rejected"
      ? robotsResult.reason instanceof Error
        ? robotsResult.reason.message
        : "robots.txt was unavailable."
      : undefined;

  const record = normalizeProduct({
    requestedUrl: requestedUrl.toString(),
    finalUrl: htmlSnapshot.final_url,
    capturedAt,
    html: parsedHtml,
    ajax,
    ...(ajaxError ? { ajaxError } : {}),
  });

  return {
    record,
    technicalCheck: buildTechnicalCheck({
      productUrl: record.final_url,
      capturedAt,
      html: parsedHtml,
      htmlSnapshot,
      robotsSnapshot,
      ...(robotsError ? { robotsError } : {}),
    }),
    snapshots,
  };
}
