import {
  ACQUISITION_EYEBROW,
  ACQUISITION_HERO_ACCENT,
  ACQUISITION_HERO_LEAD,
  acquisitionLede,
} from "@mclab/domain";

import { trackConversion } from "../analytics";
import { SelfCheckFilm } from "./SelfCheckFilm";
import { PaddleCheckout } from "./PaddleCheckout";

export function HeroCopy() {
  return (
    <div className="hero-copy">
      <p className="eyebrow">{ACQUISITION_EYEBROW}</p>
      <h1>{ACQUISITION_HERO_LEAD}<br /><span>{ACQUISITION_HERO_ACCENT}</span></h1>
      <p className="lede">{acquisitionLede(false)}</p>
    </div>
  );
}

export function FreeCheckExample() {
  return (
    <aside className="free-example" id="free-example" aria-labelledby="free-example-title">
      <div className="example-topline"><span>EXAMPLE REPORT</span><span className="example-label">Fictional product</span></div>
      <div className="example-product"><div className="example-product-art" aria-hidden="true"><span /></div><div><h2 id="free-example-title">Everyday carry bag</h2><span>Product-data check · not a live test</span></div></div>
      <ul className="example-checks">
        <li><span>Product title</span><strong className="example-good">✓ Readable</strong></li>
        <li><span>Price &amp; availability</span><strong className="example-good">✓ Readable</strong></li>
        <li><span>Product images</span><strong className="example-warning">Review disagreement</strong></li>
      </ul>
      <div className="example-action"><span>SUGGESTED FIX</span><h3>Check the image references.</h3><p>The featured image and structured data point to different images. Compare them, then update any outdated reference in your Shopify theme.</p></div>
      <p className="example-loop">Fix in Shopify → Recheck the same URL</p>
      <p className="example-footnote">Your report includes captured fields, sources and suggested fixes. Product data does not establish AI recommendations.</p>
    </aside>
  );
}

export function OutcomeStrip() {
  return (
    <section className="outcome-strip" id="how-it-works" aria-label="How the free product check works">
      <div><span>01 / CHECK</span><strong>See what’s readable.</strong><p>Paste a Shopify product URL to check its public product facts and crawler access.</p></div>
      <div><span>02 / UNDERSTAND</span><strong>Find what needs fixing.</strong><p>Get clear next steps for missing details or conflicting information, with the sources behind each finding.</p></div>
      <div><span>03 / IMPROVE</span><strong>Recheck your changes.</strong><p>Update your product in Shopify, then check the same URL again. Compare changes in this browser and save or share the result.</p></div>
    </section>
  );
}

export function FreeCheckQuestions() {
  return <section className="free-questions" id="faq" aria-labelledby="free-questions-title">
    <div><p className="eyebrow">A useful first step</p><h2 id="free-questions-title">Questions, answered.</h2><p>One product URL. A clearer view of your public product data.</p></div>
    <div className="free-question-list">
      <details><summary>How can I check whether AI can read my Shopify product?</summary><p>Start by checking the public facts and access rules on the product URL. This free check reads those sources and flags missing or conflicting information. It cannot prove that a particular AI has fetched or recommended your product.</p></details>
      <details><summary>What can I fix with the free check?</summary><p>Depending on the captured evidence, you may find missing product fields, conflicting prices or images, unreadable structured data, or crawler restrictions. Each suggested action points to the relevant Shopify setting or page source. A field not found here may exist elsewhere on your store.</p></details>
      <details><summary>Do I need an account or a credit card?</summary><p>No. Check public product data, read the suggested fixes and recheck without signing up. A recorded AI shopping test is a separate, optional next step.</p></details>
      <details><summary>Why isn’t ChatGPT recommending my product?</summary><p>Readable data alone does not establish recommendation. Buyer fit, competing products and the sources available in a particular conversation also matter. <a href="https://geo.mclab.party/guides/check-shopify-product-ai-visibility/#interpret">Learn how to separate readability from recommendation.</a></p></details>
    </div>
  </section>;
}

export function HowItWorks({ freeCheckEnabled }: { freeCheckEnabled: boolean }) {
  return (
    <section className="agent-section campaign-agents" id="recorded-test" aria-labelledby="how-it-works-title">
      <div className="recorded-intro"><div>
      <p className="eyebrow">OPTIONAL · RECORDED AI SHOPPING TEST</p>
      <h2 id="how-it-works-title">Go beyond product data.</h2>
      <p className="agent-intro">Test your product against natural buyer questions. See whether it appears, makes the shortlist, or gets recommended in a controlled API test. Read the recorded conversation and sources; this is not a consumer ChatGPT ranking.</p>
      </div><SelfCheckFilm /></div>
      <p className="recorded-boundary">{freeCheckEnabled ? "Verify your email for 1 complimentary AI test. Further tests use credit packs." : "Recorded AI tests require credits."} A completed negative result is still a completed test.</p>
      <details className="test-method"><summary>How the recorded test works</summary>
        <ol><li>Understand the product and establish a buyer’s needs.</li><li>Run a natural shopping conversation without private brand hints.</li><li>Review the questions, answers and sources, then report the observed outcome and a next step.</li></ol>
        <p>Questions adapt to the captured evidence. Missing evidence is not proof of product absence, and no test guarantees recommendations, rankings or sales.</p>
      </details>
      <a className="campaign-start" href="#start">Start with a product-data check →</a>
    </section>
  );
}

export function SampleReport() {
  return (
    <section className="sample-report" aria-labelledby="sample-report-title">
      <div className="sample-report-copy">
        <p className="eyebrow">Recorded ChatGPT case · separate from Self-Check</p>
        <h2 id="sample-report-title">A fitting product can still miss the shortlist.</h2>
        <p>This separately conducted case found that the product was readable, then absent from the natural buyer shortlist until the category was named.</p>
        <a href="https://geo.mclab.party/case/hemp-pillow/">Read the full case on geo.mclab.party →</a>
      </div>
      <details className="sample-report-card macos-window" open>
        <summary>
          <div className="macos-traffic-lights" aria-hidden="true">
            <span className="dot dot-close" />
            <span className="dot dot-minimize" />
            <span className="dot dot-zoom" />
          </div>
          <span>Anonymous sleep product · sample result</span>
        </summary>
        <blockquote>“I sleep hot, want natural materials, no foam or latex, and prefer a heavy adjustable pillow. What should I consider?”</blockquote>
        <div className="sample-metrics">
          <p><span>Target retrievable</span><strong>Yes</strong></p>
          <p><span>Entered shortlist</span><strong>No</strong></p>
          <p><span>Recommended</span><strong>No</strong></p>
        </div>
        <div className="sample-diagnosis"><span>OBSERVED GAP</span><strong>Category association</strong><p>The product was readable, but it did not enter the natural buyer-led shortlist under the captured conditions.</p></div>
        <small>A captured result is evidence from one recorded test—not a permanent ranking or commercial guarantee.</small>
      </details>
    </section>
  );
}

export function CreditPacks({
  freeCheckEnabled,
  showCreditPrompt,
  freeCheckGranted,
  freeCheckRemainingZero,
  requiredCredits,
}: {
  freeCheckEnabled: boolean;
  showCreditPrompt: boolean;
  freeCheckGranted: boolean;
  freeCheckRemainingZero: boolean;
  requiredCredits: number;
}) {
  return (
    <section className="pricing commercial-path paid-path" id="pricing" aria-labelledby="pricing-title">
      <p className="eyebrow">ONE-TIME CREDIT PACKS</p>
      <h2 id="pricing-title">More recorded tests</h2>
      <p className="path-lede">{freeCheckEnabled
        ? "For more AI shopping tests, choose a one-time pack. The product-data check stays free."
        : "Buy a one-time pack to run the recorded AI shopping test."}</p>
      {showCreditPrompt ? <p className="pricing-prompt" role="status">{freeCheckGranted && freeCheckRemainingZero
        ? "0 remaining. Choose a one-time credit pack for more Self-Checks."
        : `You need ${requiredCredits} credits. Choose a one-time credit pack to continue.`}</p> : null}
      <PaddleCheckout onEvent={(name) => trackConversion(name, "pricing")} />
      <small>Credits do not expire. Linked to the Paddle email. See <a href="/pricing/">pack details</a>.</small>
    </section>
  );
}

export function ProfessionalReview() {
  return (
    <section className="professional-path commercial-path" id="professional-review" aria-labelledby="professional-title">
      <p className="eyebrow">Professional review · not Self-Check</p>
      <h2 id="professional-title">A professional diagnosis for one product</h2>
      <p>Professional review is a personalized, AI-powered $199 service: diagnosis, a source-ready brief, and a retest. It is separate from the free preview, the complimentary Self-Check, and credit packs.</p>
      <a href="https://geo.mclab.party/shopify-geo-audit/">Ask for professional review →</a>
    </section>
  );
}
