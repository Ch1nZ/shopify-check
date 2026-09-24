import type { FormEvent } from "react";
import type { PreviewSnapshot } from "@mclab/shopify-online-store";

import {
  PREVIEW_FORM_WINDOW_TITLE,
  previewBoundaryCopy,
  previewCtaLabel,
  previewHandoffSignupDescription,
  previewSuccessCtaLabel,
} from "@mclab/domain";

import {
  FreePreviewFailure,
  FreePreviewResult,
  FreePreviewScanning,
  type FreeProductPreview,
} from "./FreeProductPreview";
import { FreeCheckSignupForm } from "./FreeCheckSignupForm";

export function DiagnosticSetup({
  productUrl,
  onProductUrlChange,
  preview,
  previewPending,
  previewError,
  previousPreviewSnapshot,
  previewReadable,
  onRunPreview,
  onSubmit,
  pending,
  market,
  onMarketChange,
  category,
  onCategoryChange,
  buyerJob,
  onBuyerJobChange,
  useCases,
  onUseCasesChange,
  constraints,
  onConstraintsChange,
  preferences,
  onPreferencesChange,
  freeCheckEnabled,
  showHeroSignup,
  freeCheckRemaining,
  requiredCredits,
}: {
  productUrl: string;
  onProductUrlChange: (value: string) => void;
  preview: FreeProductPreview | null;
  previewPending: boolean;
  previewError: string | null;
  previousPreviewSnapshot: PreviewSnapshot | null;
  previewReadable: boolean;
  onRunPreview: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  pending: boolean;
  market: string;
  onMarketChange: (value: string) => void;
  category: string;
  onCategoryChange: (value: string) => void;
  buyerJob: string;
  onBuyerJobChange: (value: string) => void;
  useCases: string;
  onUseCasesChange: (value: string) => void;
  constraints: string;
  onConstraintsChange: (value: string) => void;
  preferences: string;
  onPreferencesChange: (value: string) => void;
  freeCheckEnabled: boolean;
  showHeroSignup: boolean;
  freeCheckRemaining: boolean;
  requiredCredits: number;
}) {
  return (
    <form onSubmit={onSubmit} className="preflight-form task-form macos-window" id="start">
      <div className="macos-window-titlebar" aria-hidden="true">
        <div className="macos-traffic-lights">
          <span className="dot dot-close" />
          <span className="dot dot-minimize" />
          <span className="dot dot-zoom" />
        </div>
        <span className="macos-window-title">{PREVIEW_FORM_WINDOW_TITLE}</span>
      </div>
      <p className="start-label">YOUR FREE PRODUCT CHECK</p>
      <label htmlFor="product-url">Shopify product URL</label>
      <div className={previewPending ? "input-row is-scanning" : "input-row"}>
        <input
          id="product-url"
          type="url"
          required
          placeholder="https://yourstore.com/products/your-product"
          value={productUrl}
          onChange={(event) => onProductUrlChange(event.target.value)}
        />
        <button type="button" onClick={onRunPreview} disabled={!productUrl || previewPending}>
          {previewCtaLabel(previewPending)}
        </button>
      </div>
      <p className="preview-boundary">{previewBoundaryCopy(freeCheckEnabled)}</p>
      {previewPending && !preview ? <FreePreviewScanning /> : null}
      {previewError ? <FreePreviewFailure message={previewError} /> : null}
      {preview ? previewReadable
        ? (
          <FreePreviewResult
            preview={preview}
            previousSnapshot={previousPreviewSnapshot}
            onRecheck={onRunPreview}
            recheckPending={previewPending}
            freeCheckEnabled={freeCheckEnabled}
            needsEmailVerification={showHeroSignup}
            freeCheckRemaining={freeCheckRemaining}
          >
            {showHeroSignup ? (
              <FreeCheckSignupForm
                id="free-check-signup"
                compact
                className="is-handoff"
                title="Verify email for 1 free Self-Check"
                description={previewHandoffSignupDescription()}
                submitLabel={previewSuccessCtaLabel}
              />
            ) : null}
          </FreePreviewResult>
        )
        : <FreePreviewFailure message="The page loaded, but title and price were not readable. Try the canonical /products/{handle} URL." />
      : null}
      {previewReadable ? (
        <div className="ai-test-step">
          <p className="eyebrow">Optional · Recorded AI shopping test</p>
          <label>Target market<input required minLength={2} maxLength={80} value={market} onChange={(event) => onMarketChange(event.target.value)} /></label>
          <details className="advanced-settings">
            <summary>Optional buyer context</summary>
            <p>Add these only when they materially affect the purchase decision.</p>
            <div className="task-grid">
              <label>Product category override<input minLength={2} maxLength={120} placeholder="Only if the product page category is unclear" value={category} onChange={(event) => onCategoryChange(event.target.value)} /></label>
              <label className="wide">Specific buyer context<textarea minLength={5} maxLength={500} placeholder="Optional: a particular audience or purchase situation to test" value={buyerJob} onChange={(event) => onBuyerJobChange(event.target.value)} /></label>
              <label>Use cases (one per line)<textarea placeholder="Daily desk work" value={useCases} onChange={(event) => onUseCasesChange(event.target.value)} /></label>
              <label>Constraints (one per line)<textarea placeholder="Limited floor space&#10;Budget under $500" value={constraints} onChange={(event) => onConstraintsChange(event.target.value)} /></label>
              <label>Preferences (one per line)<textarea placeholder="Adjustable lumbar support" value={preferences} onChange={(event) => onPreferencesChange(event.target.value)} /></label>
            </div>
          </details>
          {showHeroSignup ? (
            <p className="signup-next">Verify your email above, then run 1 free Self-Check. A completed result uses it, including when the product is not recommended.</p>
          ) : null}
          <div className={showHeroSignup ? "run-test-row is-secondary-path" : "run-test-row"} id="run-self-check">
            <button type="submit" disabled={pending}>{pending ? "Starting test…" : freeCheckRemaining ? "Run 1 free Self-Check" : "Run AI shopping test"}</button>
            <p>{showHeroSignup
              ? "Prefer to pay? Buy a credit pack below. The recorded test is not the free preview."
              : freeCheckRemaining
                ? "A completed result uses your 1 free Self-Check, including when the product is not recommended. A technical failure does not."
                : `Uses ${requiredCredits} credits only after the test finishes. Credits stay on the Paddle checkout email.`}</p>
          </div>
        </div>
      ) : null}
    </form>
  );
}
