import type { ProductRecord, TechnicalCheck, TechnicalFinding } from "@mclab/shopify-online-store";

import { priceScopeLabel } from "../preview-evidence";

import { FieldTable } from "./FieldTable";

export type ArtifactLinks = Partial<Record<
  "product_record" | "technical_check" | "evidence_pack" | "html" | "shopify_ajax" | "robots",
  string
>>;

export function TechnicalReport({
  collectionId,
  record,
  technicalCheck,
  artifactLinks,
}: {
  collectionId: string;
  record: ProductRecord;
  technicalCheck: TechnicalCheck;
  artifactLinks: ArtifactLinks;
}) {
  const findings = [...technicalCheck.findings, ...record.technical_findings];
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;

  return (
    <section className="report macos-window" aria-labelledby="report-title">
      <div className="macos-window-titlebar" aria-hidden="true">
        <div className="macos-traffic-lights">
          <span className="dot dot-close" />
          <span className="dot dot-minimize" />
          <span className="dot dot-zoom" />
        </div>
        <span className="macos-window-title">Console · Technical Capture & Evidence</span>
      </div>
      <div className="report-heading">
        <div>
          <p className="eyebrow">TECHNICAL SELF-CHECK</p>
          <h2 id="report-title">Captured evidence, field by field.</h2>
        </div>
        <div className={`report-status ${errors ? "has-errors" : ""}`}>
          <strong>{errors ? `${errors} access issue${errors === 1 ? "" : "s"}` : "Public page collected"}</strong>
          <span>{warnings} item{warnings === 1 ? "" : "s"} to review</span>
        </div>
      </div>

      <dl className="capture-meta">
        <div><dt>Captured</dt><dd>{new Date(record.captured_at).toLocaleString()}</dd></div>
        <div><dt>Collection</dt><dd>{record.collection_status}</dd></div>
        <div><dt>Product URL</dt><dd><a href={record.final_url} target="_blank" rel="noreferrer">{record.final_url}</a></dd></div>
        <div><dt>Evidence ID</dt><dd><code>{collectionId}</code></dd></div>
      </dl>

      <div className="report-section" aria-labelledby="crawler-title">
        <div className="section-intro">
          <p className="eyebrow">CRAWLER ELIGIBILITY</p>
          <h3 id="crawler-title">Can the captured path be crawled?</h3>
          <p>These are technical access signals, not a promise of indexing, retrieval, or recommendation.</p>
        </div>
        <div className="crawler-grid">
          {technicalCheck.crawler_access.map((crawler) => (
            <article key={crawler.agent}>
              <span className={`state state-${crawler.result}`}>{crawler.result}</span>
              <h4>{crawler.agent === "*" ? "General crawlers" : crawler.agent}</h4>
              <p>{purposeText(crawler.purpose)}</p>
              <small>{crawler.matched_rule ?? "No blocking rule matched this product path."}</small>
            </article>
          ))}
        </div>
        <p className="directive-note">
          Page directives: {[
            ...technicalCheck.page_directives.meta_robots,
            ...technicalCheck.page_directives.x_robots_tag,
          ].join(", ") || "none observed"}
        </p>
      </div>

      <div className="report-section" aria-labelledby="facts-title">
        <div className="section-intro">
          <p className="eyebrow">OBSERVABLE PRODUCT FACTS</p>
          <h3 id="facts-title">What the storefront says.</h3>
          <p>Sources agree means captured source types agreed within the compared scope. It does not independently verify product truth. Conflicts remain visible.</p>
        </div>
        {record.price_context ? <p>{priceScopeLabel(record.price_context)}</p> : null}
        <FieldTable record={record} />
      </div>

      <div className="report-section findings" aria-labelledby="findings-title">
        <div className="section-intro">
          <p className="eyebrow">PRIORITIZED REVIEW</p>
          <h3 id="findings-title">What deserves attention.</h3>
        </div>
        {findings.length ? (
          <ol>
            {sortFindings(findings).map((finding, index) => (
              <li key={`${finding.code}-${index}`}>
                <span className={`severity severity-${finding.severity}`}>{finding.severity}</span>
                <div><strong>{findingTitle(finding.code)}</strong><p>{finding.message}</p></div>
              </li>
            ))}
          </ol>
        ) : <p className="empty-state">No deterministic technical issue was found in this capture.</p>}
      </div>

      {record.variants.length ? (
        <details className="report-section variants">
          <summary>{record.variants.length} captured variant{record.variants.length === 1 ? "" : "s"}</summary>
          <ul>{record.variants.map((variant) => <li key={variant.id}><strong>{variant.title}</strong> · {variant.available ? "In stock" : "Out of stock"} · SKU {variant.sku ?? "not observed"}</li>)}</ul>
        </details>
      ) : null}

      <div className="report-section evidence" aria-labelledby="evidence-title">
        <div className="section-intro">
          <p className="eyebrow">EVIDENCE DOWNLOAD</p>
          <h3 id="evidence-title">Keep the captured sources.</h3>
        </div>
        <div className="download-grid">
          {Object.entries(artifactLinks).map(([name, href]) => (
            <a key={name} href={href}>{artifactLabel(name)} <span aria-hidden="true">↓</span></a>
          ))}
        </div>
      </div>
    </section>
  );
}

function purposeText(purpose: TechnicalCheck["crawler_access"][number]["purpose"]): string {
  if (purpose === "openai_search") return "Controls OpenAI's automatic search crawler for this path.";
  if (purpose === "openai_training") return "Training crawl control; this is not a ChatGPT Search eligibility signal.";
  return "The baseline robots.txt rule applied to unspecified crawlers.";
}

function sortFindings(findings: TechnicalFinding[]): TechnicalFinding[] {
  const rank = { error: 0, warning: 1, info: 2 };
  return [...findings].sort((left, right) => rank[left.severity] - rank[right.severity]);
}

function findingTitle(code: string): string {
  return code.toLowerCase().split("_").map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ");
}

function artifactLabel(name: string): string {
  const labels: Record<string, string> = {
    product_record: "Normalized product record",
    technical_check: "Technical eligibility record",
    evidence_pack: "AI evidence pack",
    html: "Original product HTML",
    shopify_ajax: "Shopify Ajax product JSON",
    robots: "Original robots.txt",
  };
  return labels[name] ?? name;
}
