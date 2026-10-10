import { describe, expect, it } from "vitest";

import {
  ACQUISITION_DOCUMENT_TITLE,
  ACQUISITION_EYEBROW,
  ACQUISITION_HERO_ACCENT,
  ACQUISITION_HERO_LEAD,
  ACQUISITION_OG_TITLE,
  acquisitionLede,
  acquisitionMetaDescription,
  FREE_PREVIEW_SCAN_STAGES,
  FREE_PREVIEW_URL_EXAMPLES,
  parsePublicOffer,
  PREVIEW_FORM_WINDOW_TITLE,
  previewBoundaryCopy,
  previewCtaLabel,
  previewFailureMessage,
  previewHandoffSignupDescription,
  previewHonestyLine,
  previewResultBadge,
  previewResultHeadline,
  previewScoreDisclaimer,
  previewPresenceHeading,
  previewRecheckDefinitionChanged,
  previewShareLinkLabel,
  previewSharePath,
  previewShareQuery,
  previewSignalsSummary,
  previewStartNavLabel,
  previewSuccessCtaLabel,
  previewSuccessNextStep,
  diagnosticWaitExpectation,
  serializePublicOffer,
} from "../src/public-offer";

describe("public offer copy", () => {
  it("treats only an explicit true flag as enabled", () => {
    expect(parsePublicOffer(serializePublicOffer(true))).toEqual({ free_check_enabled: true });
    expect(parsePublicOffer(serializePublicOffer(false))).toEqual({ free_check_enabled: false });
    expect(parsePublicOffer(`{"free_check_enabled":"true"}`)).toEqual({ free_check_enabled: false });
    expect(parsePublicOffer("not-json")).toEqual({ free_check_enabled: false });
  });

  it("keeps the free product check independent of the recorded-test promotion", () => {
    for (const enabled of [true, false]) {
      expect(acquisitionLede(enabled)).toContain("recheck for free");
      expect(previewBoundaryCopy(enabled)).toContain("No email or payment required");
      expect(previewBoundaryCopy(enabled)).toContain("does not test AI recommendations");
      expect(acquisitionMetaDescription(enabled)).toContain("Free Shopify product check");
      expect(acquisitionLede(enabled)).not.toMatch(/verify|credit packs/i);
    }
    expect(previewStartNavLabel()).not.toMatch(/free Self-Check/i);
    expect(previewCtaLabel(false)).not.toMatch(/free Self-Check/i);
  });

  it("does not headline a partial preview as fully readable", () => {
    expect(previewResultHeadline("complete")).toBe("Product page readable");
    expect(previewResultHeadline("partial")).toBe("Product page partially readable");
    expect(previewResultBadge("complete")).toBe("Readable");
    expect(previewResultBadge("partial")).toBe("Partial");
    expect(previewResultHeadline("partial")).not.toMatch(/fully readable/i);
  });

  it("stages the free preview wait without calling it a shopping test", () => {
    expect(FREE_PREVIEW_SCAN_STAGES).toEqual([
      "Fetching page",
      "Reading product fields",
      "Checking sources",
    ]);
    expect(previewCtaLabel(true)).toBe("Reading product…");
    expect(previewHonestyLine()).toContain("page readability");
    expect(previewHonestyLine()).not.toMatch(/ranking|traffic|revenue/i);
    expect(previewHonestyLine()).not.toContain("shopping-test result");
  });

  it("points a successful preview at email verification when that is the next step", () => {
    expect(previewSuccessNextStep({
      freeCheckEnabled: true,
      needsEmailVerification: true,
      freeCheckRemaining: false,
    })).toEqual({
      kind: "verify_email",
      label: "Email verification link",
      href: "#free-check-signup",
      secondary: { label: "Buy a credit pack instead", href: "#pricing" },
    });
    expect(previewSuccessCtaLabel(false)).toBe("Email verification link");
    expect(previewSuccessCtaLabel(true)).toBe("Sending…");
    expect(previewHandoffSignupDescription()).toContain("1 complimentary AI shopping test");
    expect(previewHandoffSignupDescription()).not.toMatch(/ranking|traffic|revenue/i);
    const freeRun = previewSuccessNextStep({
      freeCheckEnabled: true,
      needsEmailVerification: false,
      freeCheckRemaining: true,
    });
    expect(freeRun.kind).toBe("run_free_check");
    expect(freeRun.label).toContain("complimentary AI test");
    expect(freeRun.secondary).toBeUndefined();
    const paidRun = previewSuccessNextStep({
      freeCheckEnabled: false,
      needsEmailVerification: false,
      freeCheckRemaining: false,
    });
    expect(paidRun.kind).toBe("run_paid_test");
    expect(paidRun.label).toContain("recorded AI shopping test");
    expect(paidRun.secondary).toBeUndefined();
    expect(previewSuccessNextStep({
      freeCheckEnabled: true,
      needsEmailVerification: false,
      freeCheckRemaining: false,
    })).toEqual({
      kind: "run_paid_test",
      label: "Continue below to run the recorded AI shopping test",
      href: "#run-self-check",
    });
  });

  it("explains redirect and 404 failures with a product-handle recovery path", () => {
    expect(previewFailureMessage({ code: "UNSUPPORTED_PRODUCT_PATH" })).toContain("/products/{handle}");
    expect(previewFailureMessage({ code: "PRODUCT_REDIRECTED_AWAY" })).toContain("redirects away");
    expect(previewFailureMessage({
      code: "PRODUCT_PAGE_UNAVAILABLE",
      message: "The product page returned HTTP 404.",
    })).toContain("HTTP 404");
    expect(FREE_PREVIEW_URL_EXAMPLES.every((url) => url.includes("/products/"))).toBe(true);
  });

  it("summarizes preview checks without a fake GEO rank and keeps Self-Check off the share path", () => {
    expect(previewSignalsSummary(12, 16)).toBe("12/16 checks looking good");
    expect(previewSignalsSummary(16, 16)).toBe("16/16 checks looking good");
    expect(previewScoreDisclaimer()).toContain("Not a ranking, traffic, or GEO score");
    expect(previewPresenceHeading()).toBe("Captured on this product URL");
    expect(previewRecheckDefinitionChanged()).toContain("rule update is not treated as a page change");
    expect(previewShareQuery("https://shop.example/products/example-pendant")).toContain("product=");
    expect(previewSharePath("https://shop.example/products/example-pendant")).toBe(
      "/?product=https%3A%2F%2Fshop.example%2Fproducts%2Fexample-pendant#start",
    );
    expect(previewShareLinkLabel()).toBe("Copy share link");
    for (const copy of [
      previewSignalsSummary(11, 16),
      previewScoreDisclaimer(),
      previewShareLinkLabel(),
    ]) {
      expect(copy).not.toMatch(/high-capacity|several minutes/i);
      expect(copy).not.toMatch(/free Self-Check/i);
    }
  });

  it("sets a high-capacity wait expectation without busy-server language", () => {
    expect(diagnosticWaitExpectation()).toBe(
      "This is a high-capacity Self-Check: a full shopping simulation and deep analysis. A thorough run usually takes several minutes.",
    );
    expect(diagnosticWaitExpectation().toLowerCase()).not.toMatch(/busy|overload|broken|forever/);
  });
});
