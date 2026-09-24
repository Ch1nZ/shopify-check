import {
  acquisitionLede,
  acquisitionMetaDescription,
  previewBoundaryCopy,
  PUBLIC_OFFER_SCRIPT_ID,
  serializePublicOffer,
} from "@mclab/domain";

import { freeCheckEnabled } from "./free-check";
import { applyMediaByteRange } from "./media-byte-range";

export function applyPublicOfferHtml(response: Response, enabled: boolean): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("text/html")) return response;

  const json = serializePublicOffer(enabled);
  const lede = acquisitionLede(enabled);
  const boundary = previewBoundaryCopy(enabled);
  const meta = acquisitionMetaDescription(enabled);

  return new HTMLRewriter()
    .on("html", {
      element(element) {
        element.setAttribute("data-free-check-enabled", enabled ? "true" : "false");
      },
    })
    .on(`script#${PUBLIC_OFFER_SCRIPT_ID}`, {
      text(text) {
        if (text.lastInTextNode) text.replace(json);
        else text.remove();
      },
    })
    .on("[data-offer-copy='lede']", {
      element(element) {
        element.setInnerContent(lede);
      },
    })
    .on("[data-offer-copy='preview-boundary']", {
      element(element) {
        element.setInnerContent(boundary);
      },
    })
    .on("meta[data-offer-copy='meta']", {
      element(element) {
        element.setAttribute("content", meta);
      },
    })
    .transform(response);
}

export async function servePublicAssets(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const asset = await env.ASSETS.fetch(request);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return applyPublicOfferHtml(asset, freeCheckEnabled(env));
  }
  return applyMediaByteRange(request, asset);
}
