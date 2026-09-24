import type { CSSProperties } from "react";
import Markdown from "react-markdown";

import type { DiagnosticReportData, DiagnosticTurn } from "../types";

export function DiagnosticReport({ report }: { report: DiagnosticReportData }) {
  const diagnosis = report.diagnosis;
  if (!diagnosis) {
    return <LegacyConversation turns={report.turns} />;
  }
  return (
    <div className="diagnostic-report is-revealing">
      {report.buyer_situation ? <section className="report-section"><p className="eyebrow">BUYER SITUATION TESTED</p><h3>{report.buyer_situation.job}</h3><p>{report.buyer_situation.category} · {report.buyer_situation.market}</p><p>Requirements: {report.buyer_situation.constraints.join("; ") || "Category and target-market purchase availability"}</p><p>Preferences: {report.buyer_situation.preferences.join("; ") || "None added"}</p></section> : null}
      {report.direct_retrieval ? <details className="report-section"><summary>Separate product lookup: {report.direct_retrieval.status === "passed" ? "identity established" : "unresolved"}</summary><p>{report.direct_retrieval.explanation}</p><p>This lookup was kept outside the shopping conversation and is not a shortlist result.</p><p>{report.direct_retrieval.question}</p><Markdown>{report.direct_retrieval.answer}</Markdown></details> : null}
      <section className="diagnostic-hero macos-window" aria-labelledby="diagnostic-outcome-title">
        <div className="macos-window-titlebar" aria-hidden="true">
          <div className="macos-traffic-lights">
            <span className="dot dot-close" />
            <span className="dot dot-minimize" />
            <span className="dot dot-zoom" />
          </div>
          <span className="macos-window-title">Diagnostic Decision · Candidate Set Evaluation</span>
        </div>
        <div className="diagnostic-hero-body">
          <span className={`diagnostic-outcome outcome-${diagnosis.outcome}`}>
            <span className="outcome-pulse-dot" aria-hidden="true" />
            {diagnosis.outcome_label}
          </span>
          <h3 id="diagnostic-outcome-title">{diagnosis.headline}</h3>
          <p>{diagnosis.observed_result}</p>
          <div className="diagnostic-confidence">
            <span>Observation confidence: <strong>{diagnosis.confidence.observation}</strong></span>
            <span>Cause confidence: <strong>{diagnosis.confidence.cause}</strong></span>
          </div>
        </div>
      </section>

      <section className="diagnostic-grid" aria-label="Diagnostic decision">
        <article className="diagnostic-card">
          <small>OBSERVED FAILURE POINT</small>
          <h3>{diagnosis.failure_point.label}</h3>
          <p>{diagnosis.failure_point.explanation}</p>
          <span className="evidence-kind">Recorded observation</span>
        </article>
        <article className="diagnostic-card">
          <small>TECHNICAL ELIGIBILITY</small>
          <h3>{diagnosis.technical_eligibility.label}</h3>
          <p>{diagnosis.technical_eligibility.explanation}</p>
          <span className="evidence-kind">{diagnosis.technical_eligibility.status === "unknown" ? "Not assessed" : "Captured technical check"}</span>
        </article>
        <article className="diagnostic-card">
          <small>PRODUCT-SOURCE SIGNAL</small>
          <h3>
            {diagnosis.product_source.description_state === "not_captured"
              ? "Product source not captured"
              : diagnosis.product_source.description_state === "missing"
              ? "Product description missing"
              : diagnosis.product_source.description_state === "brief"
                ? "Brief product description"
                : "Product description captured"}
          </h3>
          <p>{diagnosis.product_source.description_state === "not_captured" ? "No product-page evidence is available for this attempt." : `The captured Shopify description contains ${diagnosis.product_source.description_word_count} words.`}</p>
          <span className="evidence-kind">{diagnosis.product_source.evidence_label}</span>
        </article>
      </section>

      <section className="report-section next-action" aria-labelledby="next-action-title">
        <p className="eyebrow">SMALLEST USEFUL NEXT ACTION</p>
        <h3 id="next-action-title">{diagnosis.next_action.title}</h3>
        <p>{diagnosis.next_action.rationale}</p>
        <div className="action-boundary">
          <div><small>EVIDENCE STATUS</small><p>{diagnosis.next_action.evidence_type}</p></div>
          <div><small>WORKING HYPOTHESIS</small><p>{diagnosis.next_action.hypothesis}</p></div>
          <div><small>CONTROLLED RETEST</small><p>{diagnosis.next_action.retest}</p></div>
        </div>
      </section>

      <section className="report-section" aria-labelledby="candidate-path-title">
        <p className="eyebrow">CANDIDATE-SET PATH</p>
        <h3 id="candidate-path-title">{report.turns.length ? "Where entry was tested—and which alternatives survived." : "No shopping conversation was captured."}</h3>
        <p className="confidence-note">{diagnosis.candidate_path_interpretation}</p>
        <div className="candidate-path" role="list">
          {diagnosis.candidate_path.map((step, idx) => (
            <article key={step.turn} role="listitem" className="candidate-card" style={{ "--card-idx": idx } as CSSProperties}>
              <div className="candidate-card-header">
                <div className="macos-traffic-lights" aria-hidden="true">
                  <span className="dot dot-close" />
                  <span className="dot dot-minimize" />
                  <span className="dot dot-zoom" />
                </div>
                <span>Turn {step.turn}</span>
                <strong className={`target-state state-${step.target_state.replaceAll(" ", "-")}`}>{step.target_state}</strong>
              </div>
              <small className="candidate-step-action">{step.action ?? step.stage.replaceAll("_", " ")}</small>
              {step.reason ? <p className="candidate-step-reason">{step.reason}</p> : null}
              <small className="candidate-entry-status">{step.entry_status === "closed_candidate_set" ? "Closed comparison—not a new retrieval attempt" : "Candidate-set entry still observable"}</small>
              <div className="candidate-leading-group">
                <span className="leading-label">Considered in turn:</span>
                <p className="leading-names">{step.leading_candidates.length ? step.leading_candidates.join(" · ") : "No candidates extracted"}</p>
              </div>
              <small className="candidate-domains">{step.source_domains.length} source {step.source_domains.length === 1 ? "domain" : "domains"} captured</small>
            </article>
          ))}
        </div>
      </section>

      <section className="report-section evidence-quality" aria-labelledby="evidence-quality-title">
        <p className="eyebrow">EVIDENCE QUALITY</p>
        <h3 id="evidence-quality-title">What is observed, and what remains uncertain.</h3>
        <div className="evidence-metrics-bar">
          <div className="evidence-metric-item">
            <div className="evidence-metric-top">
              <span>Completed turns</span>
              <strong>{diagnosis.evidence_quality.completed_turns} / 6</strong>
            </div>
            <div className="metric-ratio-bar">
              <span className="metric-ratio-fill" style={{ width: `${Math.min(100, (diagnosis.evidence_quality.completed_turns / 6) * 100)}%` }} />
            </div>
          </div>
          <div className="evidence-metric-item">
            <div className="evidence-metric-top">
              <span>Turns with sources</span>
              <strong>{diagnosis.evidence_quality.turns_with_sources} / {Math.max(1, diagnosis.evidence_quality.completed_turns)}</strong>
            </div>
            <div className="metric-ratio-bar">
              <span className="metric-ratio-fill" style={{ width: `${Math.min(100, (diagnosis.evidence_quality.turns_with_sources / Math.max(1, diagnosis.evidence_quality.completed_turns)) * 100)}%` }} />
            </div>
          </div>
          <div className="evidence-metric-item">
            <div className="evidence-metric-top">
              <span>Sourced domains</span>
              <strong>{diagnosis.evidence_quality.unique_source_domains} unique</strong>
            </div>
            <div className="metric-ratio-bar">
              <span className="metric-ratio-fill" style={{ width: `${Math.min(100, Math.max(20, diagnosis.evidence_quality.unique_source_domains * 20))}%` }} />
            </div>
          </div>
        </div>
        <p className="confidence-note">{diagnosis.confidence.explanation}</p>
        <ul>{diagnosis.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
      </section>

      <details className="report-section transcript-evidence">
        <summary>Open the recorded conversation and sources</summary>
        <p>These are the exact buyer questions and AI answers retained for audit. Product specifications inside an AI answer are not treated as verified unless the linked first-party source directly supports them.</p>
        {!report.turns.length ? <p>No shopping answer was captured in this attempt.</p> : null}
        {report.turns.map((turn) => <ConversationTurn key={turn.ordinal} turn={turn} />)}
      </details>
    </div>
  );
}

function LegacyConversation({ turns }: { turns: DiagnosticReportData["turns"] }) {
  return <div>{turns.map((turn) => <ConversationTurn key={turn.ordinal} turn={turn} />)}</div>;
}

function ConversationTurn({ turn }: { turn: DiagnosticTurn }) {
  const sourceGroups = turn.source_groups ?? turn.sources.map((source) => ({
    label: source.title ?? "Provider source",
    url: source.url,
    urls: [source.url],
    count: 1,
  }));
  return (
    <details className="conversation-turn">
      <summary><span>Turn {turn.ordinal} · {turn.stage.replaceAll("_", " ")}</span>{turn.shopper_message ?? "Buyer question unavailable"}</summary>
      <div className="conversation-body">
        {turn.adaptive_decision ? <p><strong>Why this step:</strong> {turn.adaptive_decision.reason}</p> : null}
        <span className="evidence-kind">AI-generated shopping answer</span>
        {turn.shopping_answer ? <div className="report-markdown"><Markdown>{turn.shopping_answer}</Markdown></div> : null}
        {turn.target_observation ? <p className="target-observation"><strong>Target outcome:</strong> {targetObservationLabel(turn.target_observation)}</p> : null}
        {sourceGroups.length ? (
          <div className="source-groups">
            <strong>Provider-returned source domains</strong>
            <ul>{sourceGroups.map((source) => {
              const urls = source.urls ?? [source.url];
              return <li key={`${source.label}-${source.url}`}>{urls.length > 1 ? (
                <details><summary>{source.label} · {urls.length} pages</summary><ol>{urls.map((url, index) => <li key={url}><a href={url} target="_blank" rel="noreferrer">Page {index + 1}</a></li>)}</ol></details>
              ) : <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a>}</li>;
            })}</ul>
          </div>
        ) : <p className="source-warning">No new provider sources were captured for this turn; treat detailed product claims as unverified conversation context.</p>}
      </div>
    </details>
  );
}

function targetObservationLabel(observation: Record<string, string>) {
  if (observation.recommendation === "final_choice") return "final choice";
  if (observation.recommendation === "recommended") return "recommended";
  if (observation.candidate_set === "included") return "entered the candidate set";
  if (observation.retrievability === "retrieved") return "retrieved, but not shortlisted";
  return "not retrieved and absent from the candidate set";
}
