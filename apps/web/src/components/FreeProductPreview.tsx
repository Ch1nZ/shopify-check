import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  FREE_PREVIEW_FIELD_ORDER,
  FREE_PREVIEW_SCAN_STAGES,
  FREE_PREVIEW_URL_EXAMPLES,
  previewFixesEmptyState,
  previewFixesHeading,
  previewFixesOptionalNextStep,
  previewHonestyLine,
  previewPresenceHeading,
  previewRecheckDefinitionChanged,
  previewPrintLabel,
  previewRecheckButtonLabel,
  previewRecheckEmptyState,
  previewRecheckFirstRunHint,
  previewRecheckHeading,
  previewRecheckImprovedLabel,
  previewRecheckRegressedLabel,
  previewRecheckStillOpenLabel,
  previewResultBadge,
  previewResultHeadline,
  previewScoreDisclaimer,
  previewShareLinkLabel,
  previewSharePath,
  previewSuccessNextStep,
} from "@mclab/domain";
import {
  formatFindingEvidence,
  previewReadiness,
  previewRecheckDiff,
  type PreviewSnapshot,
  type PublicProductPreview,
} from "@mclab/shopify-online-store";

import { evidenceStateLabel, priceScopeLabel } from "../preview-evidence";

import { trackConversion } from "../analytics";

export type FreeProductPreview = PublicProductPreview;

export function FreePreviewScanning() {
  const reducedMotion = usePrefersReducedMotion();
  const stage = usePreviewScanStage(!reducedMotion);
  const status = reducedMotion ? "Reading product page" : FREE_PREVIEW_SCAN_STAGES[stage];

  return (
    <section className="free-preview-result is-scanning macos-window" aria-busy="true">
      <div className="macos-window-titlebar" aria-hidden="true">
        <div className="macos-traffic-lights">
          <span className="dot dot-close" />
          <span className="dot dot-minimize" />
          <span className="dot dot-zoom" />
        </div>
        <span className="macos-window-title">Product Data Preview</span>
      </div>
      <div className="free-preview-heading">
        <div>
          <span>FREE PRODUCT-DATA PREVIEW</span>
          <strong>Reading product page</strong>
        </div>
        <div className="scanner-radar-mini" aria-hidden="true">
          <span className="radar-sweep-beam" />
          <span className="radar-blip" />
        </div>
      </div>
      <ol className="preview-scan-stages">
        {FREE_PREVIEW_SCAN_STAGES.map((label, index) => {
          const state = reducedMotion
            ? ""
            : index < stage
              ? "is-complete"
              : index === stage
                ? "is-current"
                : "";
          return (
            <li key={label} className={state || undefined}>
              <span>{index + 1}</span>
              {label}
            </li>
          );
        })}
      </ol>
      <div
        className="preview-scan-meter"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={FREE_PREVIEW_SCAN_STAGES.length}
        aria-valuenow={reducedMotion ? FREE_PREVIEW_SCAN_STAGES.length : stage + 1}
        aria-valuetext={status}
      >
        <span style={{ width: `${((reducedMotion ? FREE_PREVIEW_SCAN_STAGES.length : stage + 1) / FREE_PREVIEW_SCAN_STAGES.length) * 100}%` }} />
      </div>
      <div className="preview-field-grid" aria-hidden="true">
        {FREE_PREVIEW_FIELD_ORDER.map((name) => (
          <article key={name} className="is-skeleton">
            <span>{name}</span>
            <strong className="preview-skel preview-skel-value" />
            <small className="preview-skel preview-skel-state" />
          </article>
        ))}
      </div>
      <p className="preview-scan-status" aria-live="polite">
        <span className="scan-status-dot" aria-hidden="true" />
        {status}
      </p>
      <p>This is not the recorded Self-Check.</p>
    </section>
  );
}

export function FreePreviewResult({
  preview,
  previousSnapshot,
  onRecheck,
  recheckPending = false,
  freeCheckEnabled,
  needsEmailVerification,
  freeCheckRemaining,
  children,
}: {
  preview: FreeProductPreview;
  previousSnapshot?: PreviewSnapshot | null;
  onRecheck?: () => void;
  recheckPending?: boolean;
  freeCheckEnabled: boolean;
  needsEmailVerification: boolean;
  freeCheckRemaining: boolean;
  children?: ReactNode;
}) {
  const nextStep = previewSuccessNextStep({
    freeCheckEnabled,
    needsEmailVerification,
    freeCheckRemaining,
  });
  const readiness = useMemo(() => previewReadiness(preview), [preview]);
  const diff = useMemo(
    () => previewRecheckDiff(previousSnapshot, readiness),
    [previousSnapshot, readiness],
  );
  const findings = preview.findings ?? [];
  const [shareStatus, setShareStatus] = useState<string | null>(null);

  async function copyShareLink() {
    const href = `${window.location.origin}${previewSharePath(preview.product_url)}`;
    try {
      await navigator.clipboard.writeText(href);
      trackConversion("preview_share_copied");
      setShareStatus("Link copied. Anyone opening it runs a live preview of this URL.");
    } catch {
      setShareStatus(href);
    }
  }

  return (
    <section id="free-preview-result" className="free-preview-result is-revealing macos-window preview-share-card" aria-live="polite">
      <div className="macos-window-titlebar preview-share-chrome" aria-hidden="true">
        <div className="macos-traffic-lights">
          <span className="dot dot-close" />
          <span className="dot dot-minimize" />
          <span className="dot dot-zoom" />
        </div>
        <span className="macos-window-title">Product Data Preview · Captured</span>
      </div>
      <p className="preview-share-brand">MC Lab · Product Data Preview</p>
      <p className="preview-share-url">
        <a href={preview.product_url} target="_blank" rel="noreferrer">{preview.product_url}</a>
      </p>
      {preview.requested_url && preview.requested_url !== preview.product_url ? <p>Submitted URL: <a href={preview.requested_url} target="_blank" rel="noreferrer">{preview.requested_url}</a> · Resolved URL shown above.</p> : null}
      {preview.price_context ? <p>{priceScopeLabel(preview.price_context)} {preview.price_context.currency_sources?.length ? `Currency evidence: ${preview.price_context.currency_sources.join(" · ")}.` : "Currency has no explicit source evidence."}</p> : null}
      <div className="free-preview-heading">
        <div>
          <span>FREE PRODUCT-DATA PREVIEW</span>
          <strong>{previewResultHeadline(preview.status)}</strong>
          <p className="preview-signals-summary">{preview.fields.title.value && preview.fields.price.value !== null ? "Core product data captured" : "Some core product data needs attention"}</p>
          <p className="preview-score-disclaimer">{previewScoreDisclaimer()}</p>
        </div>
        <b className={preview.status === "partial" ? "preview-badge-status is-partial" : "preview-badge-status"}>
          {previewResultBadge(preview.status)}
        </b>
      </div>
      {preview.variant_summary && preview.variant_summary.total > 1 ? (
        <p>{preview.variant_summary.total} variants found · {preview.variant_summary.with_sku} with SKUs · {preview.variant_summary.available} available{preview.variant_summary.unknown_availability ? ` · ${preview.variant_summary.unknown_availability} availability unverified` : ""}. Availability can differ by variant.</p>
      ) : null}
      <div className="preview-field-grid">
        {FREE_PREVIEW_FIELD_ORDER.map((name, index) => {
          const field = preview.fields[name];
          return (
            <article key={name} style={{ "--field-idx": index } as React.CSSProperties}>
              <span>{name}</span>
              <strong>{field.state === "conflicted" ? "Sources disagree" : formatPreviewValue(name, field.value, preview.fields.currency.value)}</strong>
              <small className={`preview-state state-${field.state}`}>{evidenceStateLabel(field.state)}</small>
            </article>
          );
        })}
      </div>
      <div className="preview-presence-strip">
        <span className="preview-crawler-title">{previewPresenceHeading()}</span>
        <div className="preview-presence-grid">
          {(preview.presence ?? []).map((item) => (
            <article key={item.key} className={!item.relevant && item.state === "missing" ? "is-not-required" : `is-${item.state}`}>
              <span>{item.label}</span>
              <strong>{!item.relevant && item.state === "missing" ? "Not required here" : item.state === "missing" && ["shipping", "returns"].includes(item.key) ? "Not found in structured data" : presenceStateLabel(item.state)}</strong>
              <small>{presenceSourceHint(item)}</small>
            </article>
          ))}
        </div>
      </div>
      <div className="preview-fixes">
        <span className="preview-crawler-title">{previewFixesHeading()}</span>
        {readiness.fixes.length > 0 ? (
          <>
            <ol>
              {readiness.fixes.map((fix, index) => (
                <li key={fix.id}>
                  <strong><span>{index + 1}</span>{fix.title}</strong>
                  <p>{fix.detail}</p>
                </li>
              ))}
            </ol>
            <p className="preview-fixes-next">{previewFixesOptionalNextStep()}</p>
          </>
        ) : (
          <p className="preview-fixes-empty">{previewFixesEmptyState()}</p>
        )}
      </div>
      <div className="preview-recheck">
        <span className="preview-crawler-title">{previewRecheckHeading()}</span>
        {diff ? (
          <>
            {diff.improved.length === 0 && diff.regressed.length === 0 && (diff.skipped_definition_changes?.length ?? 0) === 0 ? (
              <p>{previewRecheckEmptyState()}</p>
            ) : null}
            {(diff.skipped_definition_changes?.length ?? 0) > 0 ? (
              <p>{previewRecheckDefinitionChanged()}</p>
            ) : null}
            {hasRecheckChanges(diff) ? (
              <ul className="preview-recheck-list">
                {diff.improved.map((item) => (
                  <li key={`improved:${item.id}`} className="is-improved">{previewRecheckImprovedLabel(item.label)}</li>
                ))}
                {diff.regressed.map((item) => (
                  <li key={`regressed:${item.id}`} className="is-regressed">{previewRecheckRegressedLabel(item.label, item.to)}</li>
                ))}
                {diff.still_open.slice(0, 4).map((item) => (
                  <li key={`open:${item.id}`} className="is-open">
                    {previewRecheckStillOpenLabel(item.label, item.outcome === "fail" ? "fail" : "warn")}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p>{previewRecheckFirstRunHint()}</p>
        )}
      </div>
      <div className="preview-share-actions">
        {onRecheck ? (
          <button type="button" className="preview-share-button" onClick={onRecheck} disabled={recheckPending}>
            {previewRecheckButtonLabel(recheckPending)}
          </button>
        ) : null}
        <button type="button" className="preview-share-button is-secondary" onClick={() => void copyShareLink()}>
          {previewShareLinkLabel()}
        </button>
        <button type="button" className="preview-share-button is-secondary" onClick={() => window.print()}>
          {previewPrintLabel()}
        </button>
      </div>
      {shareStatus ? <p className="preview-share-status" role="status">{shareStatus}</p> : null}
      <div className="preview-check-strip">
        <span className="preview-crawler-title">Pass / warn / fail</span>
        <ul className="preview-check-chips">
          {readiness.checks.map((check) => (
            <li key={check.id} className={`is-${check.outcome}`} title={check.detail}>
              <span className="preview-check-outcome">{check.outcome}</span>
              {check.label}
            </li>
          ))}
        </ul>
      </div>
      {findings.length > 0 ? (
        <details className="preview-findings-details">
          <summary>
            Issue details
            {preview.finding_counts
              ? ` · ${preview.finding_counts.error} error${preview.finding_counts.error === 1 ? "" : "s"}, ${preview.finding_counts.warning} warning${preview.finding_counts.warning === 1 ? "" : "s"}`
              : ""}
            {preview.finding_counts?.info ? ` · ${preview.finding_counts.info} informational note${preview.finding_counts.info === 1 ? "" : "s"}` : ""}
          </summary>
          <ul>
            {findings.map((finding) => (
              <li key={finding.definition_id ?? `${finding.code}:${finding.message}`} className={`severity-${finding.severity} status-${finding.status}`}>
                <small>{finding.status === "missing" && !finding.relevant ? "not required" : finding.status === "missing" && ["SHIPPING_NOT_IN_CAPTURE", "RETURNS_NOT_IN_CAPTURE"].includes(finding.code) ? "not found in structured data" : `${finding.severity} · ${finding.status}`}</small>
                <div>
                  <span>{finding.message}</span>
                  {finding.evidence?.length ? (
                    <p className="preview-finding-evidence">{formatFindingEvidence(finding.evidence)}</p>
                  ) : null}
                  {finding.guidance ? (
                    <p className="preview-finding-guidance">{finding.guidance}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className={nextStep.kind === "verify_email" ? "preview-next-step is-handoff is-secondary-cta" : "preview-next-step is-secondary-cta"}>
        <p className="eyebrow">Optional next step</p>
        <h3>Want to observe an AI shopping conversation?</h3>
        <p>{previewHonestyLine()}</p>
        {nextStep.kind === "verify_email" ? children : (
          <a className="preview-next-cta" href={nextStep.href}>{nextStep.label}</a>
        )}
        {nextStep.secondary ? (
          <p className="preview-next-alts">
            <a href={nextStep.secondary.href}>{nextStep.secondary.label}</a>
            {nextStep.kind === "verify_email" ? <> · <a href="#account">Already have credits? Sign in</a></> : null}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function FreePreviewFailure({ message }: { message: string }) {
  return (
    <section className="free-preview-failure is-attention macos-window" role="alert">
      <div className="macos-window-titlebar" aria-hidden="true">
        <div className="macos-traffic-lights">
          <span className="dot dot-close" />
          <span className="dot dot-minimize" />
          <span className="dot dot-zoom" />
        </div>
        <span className="macos-window-title">Product Data Preview</span>
      </div>
      <span>FREE PRODUCT-DATA PREVIEW</span>
      <h2>We couldn’t read this product page</h2>
      <p>{message}</p>
      <details className="preview-recovery" open>
        <summary>Accepted Shopify product URLs</summary>
        <p>Use a live product page that ends in <code>/products/{"{handle}"}</code>. Collection pages, homepages, password pages, drafts, and admin URLs will not work. Product redirects are followed while preserving variant context; redirects to non-product pages and 404s need the current product URL.</p>
        <p>Accepted patterns:</p>
        <ul>
          {FREE_PREVIEW_URL_EXAMPLES.map((url) => (
            <li key={url}><code>{url}</code></li>
          ))}
        </ul>
        <p>Next: paste a canonical product URL and preview again. Email verification and Self-Check still need a readable product page.</p>
      </details>
    </section>
  );
}

function hasRecheckChanges(diff: NonNullable<ReturnType<typeof previewRecheckDiff>>): boolean {
  return diff.improved.length > 0 || diff.regressed.length > 0 || diff.still_open.length > 0;
}

function presenceStateLabel(state: PublicProductPreview["presence"][number]["state"]): string {
  if (state === "present") return "Present";
  if (state === "conflicting") return "Conflicting";
  if (state === "unavailable") return "Unavailable";
  return "Missing";
}

function presenceSourceHint(item: PublicProductPreview["presence"][number]): string {
  if (!item.relevant && item.state === "missing") return "Not counted as a missing requirement";
  const labels: Record<string, string> = { shopify_ajax: "Shopify product data", json_ld: "Structured data", html_meta: "Page metadata", visible_html: "Page content" };
  if (item.state === "missing" && ["shipping", "returns"].includes(item.key)) return "Visible text and policy pages not verified";
  if (item.sources.length) return item.sources.map((source) => labels[source] ?? source).join(" · ");
  return item.state === "unavailable" ? "Could not verify this source" : "Not found in captured product data";
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return reduced;
}

function usePreviewScanStage(animate: boolean): number {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    if (!animate) {
      setStage(0);
      return;
    }
    setStage(0);
    const timer = window.setInterval(() => {
      setStage((current) => Math.min(current + 1, FREE_PREVIEW_SCAN_STAGES.length - 1));
    }, 900);
    return () => window.clearInterval(timer);
  }, [animate]);

  return stage;
}

function formatPreviewValue(
  name: string,
  value: PublicProductPreview["fields"]["title"]["value"],
  currency: PublicProductPreview["fields"]["currency"]["value"],
): string {
  if (value === null) return "Not observed";
  if (name === "availability" && typeof value === "boolean") return value ? "In stock" : "Out of stock";
  if (name === "price" && typeof value === "number") {
    const amount = value / 100;
    if (typeof currency === "string" && /^[A-Z]{3}$/.test(currency)) {
      try {
        return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount);
      } catch {
        return `${currency} ${amount.toFixed(2)}`;
      }
    }
    return `${amount.toFixed(2)} (currency unresolved)`;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
