import { parsePublicOffer, PUBLIC_OFFER_SCRIPT_ID, type PublicOfferState } from "@mclab/domain";

export function readBootstrappedPublicOffer(): PublicOfferState {
  const attr = document.documentElement.getAttribute("data-free-check-enabled");
  if (attr === "true" || attr === "false") {
    return { free_check_enabled: attr === "true" };
  }
  return parsePublicOffer(document.getElementById(PUBLIC_OFFER_SCRIPT_ID)?.textContent);
}
