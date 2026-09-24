import { useState } from "react";
import {
  ACQUISITION_EYEBROW,
  ACQUISITION_HERO_ACCENT,
  ACQUISITION_HERO_LEAD,
  acquisitionLede,
} from "@mclab/domain";

import { trackConversion } from "../analytics";
import { SelfCheckFilm } from "./SelfCheckFilm";
import { PaddleCheckout } from "./PaddleCheckout";

export function HeroCopy({ freeCheckEnabled, hasResult = false }: { freeCheckEnabled: boolean; hasResult?: boolean }) {
  return (
    <div className="hero-copy">
      <p className="eyebrow">{ACQUISITION_EYEBROW}</p>
      <h1>{ACQUISITION_HERO_LEAD}<br /><span>{ACQUISITION_HERO_ACCENT}</span></h1>
      <p className="lede">{acquisitionLede(freeCheckEnabled)}</p>
      <ul className="free-check-promises" aria-label="Included in the free check">
        <li>See what’s readable</li><li>Find what needs fixing</li><li>Recheck your changes</li>
      </ul>
      <div className="hero-journey" aria-label="Your Self-Check journey"><a href="#start"><span>01 · FREE</span><strong>Check readability</strong></a><span aria-hidden="true">→</span><a href="#recorded-test"><span>02 · OPTIONAL</span><strong>Test recommendations</strong></a></div>
      <p className="hero-links"><a href={hasResult ? "#start" : "#free-example"}>{hasResult ? "Back to your product check ↓" : "See how the free check works ↓"}</a> <a href="https://geo.mclab.party/guides/check-shopify-product-ai-visibility/">New to AI product discovery? Read the guide ↗</a></p>
    </div>
  );
}

export function FreeCheckExample() {
  const [step, setStep] = useState(0);
  const steps = ["Paste a URL", "See the finding", "Fix & recheck"];
  return (
    <aside className="free-example" id="free-example" aria-labelledby="free-example-title">
      <div className="example-topline"><span>INSIDE YOUR FREE CHECK</span><span className="example-label">Illustrative example</span></div>
      <div className="example-product"><div className="example-product-art" aria-hidden="true"><span /></div><div><p>YOUR PRODUCT, MADE READABLE</p><h2 id="free-example-title">Everyday carry bag</h2><span>Fictional product · not a live test</span></div></div>
      <div className="example-steps" role="group" aria-label="Explore the free-check example">
        {steps.map((label, index) => <button key={label} type="button" aria-pressed={step === index} aria-controls="example-stage" onClick={() => setStep(index)}><span aria-hidden="true">0{index + 1}</span>{label}</button>)}
      </div>
      <div id="example-stage" className="example-stage" aria-live="polite" aria-atomic="true">
      {step === 0 && <div className="example-url-step"><span className="example-step-label">01 / START WITH ONE PRODUCT</span><h3>Paste your Shopify product URL.</h3><p className="example-url">example.com/products/everyday-bag</p><p>No installation. No account. Your check reads the public information on that product page.</p></div>}
      {step === 1 && <><h3>See where your product data disagrees.</h3><ul className="example-checks">
        <li><span>Product title</span><strong className="example-good">✓ Readable</strong></li>
        <li><span>Price &amp; availability</span><strong className="example-good">✓ Readable</strong></li>
        <li><span>Product images</span><strong className="example-warning">Review disagreement</strong></li>
      </ul><p>The page’s featured image and structured product data point to different images. Your result shows the sources to compare.</p></>}
      {step === 2 && <div className="example-action"><span>ONE CLEAR NEXT STEP</span><h3>Make your product images agree.</h3><p>Compare your Shopify featured image with the images in your theme’s product data. Update an outdated reference if they describe different products.</p><p>After updating Shopify, recheck the same URL to see whether the disagreement is resolved.</p></div>}
      </div>
      <div className="example-next"><button type="button" onClick={() => setStep((step + 1) % steps.length)}>{step === 0 ? "See the example finding →" : step === 1 ? "See what to do next →" : "Replay example ↺"}</button>{step === 2 && <a href="#start">Check my product for free →</a>}</div>
      <p className="example-footnote">Your own result includes observed fields, source details, and relevant next steps. This example does not measure AI visibility.</p>
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
  return <section className="free-questions" aria-labelledby="free-questions-title">
    <div><p className="eyebrow">A useful first step</p><h2 id="free-questions-title">Questions before<br />you check?</h2><p>One product URL. A clearer view of your public product data.</p></div>
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
      <p className="eyebrow">STEP 2 · AI RECOMMENDATION TEST</p>
      <h2 id="how-it-works-title">Will AI recommend your product?</h2>
      <p className="agent-intro">Test your product against natural buyer questions. See whether it appears, makes the shortlist, or gets recommended—and read the conversation behind the result.</p>
      </div><SelfCheckFilm /></div>
      <ol className="campaign-agent-grid">
        <li><span className="agent-index" aria-hidden="true">01</span><span className="agent-role">BUYER CONTROLLER</span><h3>Asks. Follows up.</h3><p>Uses the buyer’s needs and the last answer’s evidence to choose the next move.</p></li>
        <li><span className="agent-index" aria-hidden="true">02</span><span className="agent-role">SHOPPING AI</span><h3>Searches. Suggests.</h3><p>Searches the web and returns product suggestions and sources without private brand hints.</p></li>
        <li><span className="agent-index" aria-hidden="true">03</span><span className="agent-role">INDEPENDENT REVIEW</span><h3>Keeps questions honest.</h3><p>Checks for leaked target identity or a question that drifts from the buyer’s original needs.</p></li>
        <li><span className="agent-index" aria-hidden="true">04</span><span className="agent-role">PRODUCT DIAGNOSIS</span><h3>Shows where you stand.</h3><p>Records where your product appears, is shortlisted or recommended, with the conversation and next step.</p></li>
      </ol>
      <div className="adaptive-explainer"><strong>The next move follows the evidence.</strong><p><span>Explore</span><span>Verify</span><span>Compare</span><span>Stop</span></p><small>Unknowns can trigger another question. Suitable options can be compared. Enough evidence—or no progress—can end the test.</small></div>
      <a className="campaign-start" href="#start">{freeCheckEnabled ? "Check my product for free →" : "Start with your product →"}</a>
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
      <p className="eyebrow">Paid credit packs · separate from the free Self-Check</p>
      <h2 id="pricing-title">More recorded tests</h2>
      <p className="path-lede">{freeCheckEnabled
        ? "After the complimentary Self-Check, buy a one-time pack."
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
