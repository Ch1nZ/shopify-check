import { AdaptiveAssessmentSchema } from "@mclab/contracts";
import type { ProductRecord, TechnicalCheck } from "@mclab/shopify-online-store";

type ReportTurn = {
  ordinal: unknown;
  stage: unknown;
  sources: Array<Record<string, unknown>>;
  candidates: Array<Record<string, unknown>>;
  target_observation: Record<string, unknown> | null;
  adaptive_decision?: { action?: unknown; reason?: unknown; assessment?: unknown } | null;
  shopping_answer?: unknown;
};

export type ReportDiagnosis = ReturnType<typeof buildReportDiagnosis>;

export function buildReportDiagnosis(input: {
  turns: ReportTurn[];
  completedTurns: number;
  interruption?: { stage: string; explanation: string };
  productRecord: ProductRecord | null;
  technicalCheck: TechnicalCheck | null;
}) {
  if (!input.interruption && input.turns.some(turn => turn.target_observation?.candidate_set === "not_observed")) {
    input = { ...input, interruption: { stage: "Target assessment unresolved", explanation: "The recorded shopping answer was preserved, but its target assessment could not be established after local repair." } };
  }
  const firstRetrievedTurn = firstTurn(input.turns, "retrievability", ["retrieved"]);
  const firstCandidateTurn = firstTurn(input.turns, "candidate_set", ["included"]);
  const firstRecommendedTurn = firstTurn(input.turns, "recommendation", ["recommended", "final_choice"]);
  const firstFinalChoiceTurn = firstTurn(input.turns, "recommendation", ["final_choice"]);
  const outcome = firstFinalChoiceTurn !== null
    ? "final_choice"
    : firstRecommendedTurn !== null
      ? "recommended"
      : firstCandidateTurn !== null
        ? "candidate"
        : firstRetrievedTurn !== null
          ? "retrieved"
          : "absent";
  const title = fieldString(input.productRecord, "title") ?? "The submitted product";
  const description = fieldString(input.productRecord, "description");
  const descriptionWordCount = description ? description.trim().split(/\s+/).filter(Boolean).length : 0;
  const technical = technicalSummary(input.technicalCheck);
  const evidence = evidenceSummary(input.turns, input.completedTurns);
  const outcomeCopy = outcomeSummary(outcome, title, firstCandidateTurn, firstRecommendedTurn);
  const adaptive = input.turns.some((turn) => turn.adaptive_decision);
  if (adaptive && outcome === "absent") {
    outcomeCopy.observedResult = "The product was absent from the recorded shopping answers under this buyer situation. Exploration and verification could admit new options; comparison turns are not independent discovery attempts.";
    outcomeCopy.failurePoint.explanation = "The product did not enter the recorded candidate set under the fixed buyer needs. Exploration and verification allowed new or replacement options, including after comparison; this does not establish why the product was absent.";
  }
  const identity = identitySummary(input.turns, input.productRecord, firstCandidateTurn);
  const action = nextAction(outcome, technical.status, descriptionWordCount);
  const alternatives = [...new Set(input.turns.flatMap(t => t.candidates.map(c => stringValue(c.displayed_name)).filter(isString)))].slice(0, 3);
  if (outcome === "absent" && identity.brand_suggestions.length) {
    const names = identity.brand_suggestions.slice(0, 3).map(c => c.name).join("; ");
    outcomeCopy.label = "Brand appeared; submitted product not identified";
    outcomeCopy.observedResult = `The brand appeared in candidate suggestions from turn ${identity.first_brand_candidate_turn}: ${names}. The submitted product was not explicitly identified in the candidate set. A brand or series suggestion is not proof of a specific SKU; this does not establish a brand-wide discovery failure.`;
    outcomeCopy.failurePoint = { label: "Specific product inclusion", explanation: "Brand-related suggestions entered the conversation, while the submitted product was not identified. The recorded answers do not establish why another suggestion represented the brand." };
    if (technical.status === "readable") {
      action.title = "Compare the submitted product with the brand-related suggestions that appeared.";
      action.rationale = `The recorded answers surfaced ${names}. Check their exact product identities first, then compare the source-backed buyer-fit facts, placement and purchase information with ${title}. Do not assume that a shared merchant domain means the same brand or that a series mention selects every SKU.`;
      action.hypothesis = "The brand already has a path into this conversation. A product-specific evidence difference may merit investigation; this run does not establish its cause or justify rewriting the whole brand’s pages.";
    }
  } else if ((outcome === "absent" || outcome === "candidate" || outcome === "retrieved") && alternatives.length && technical.status === "readable") {
    action.rationale += ` In this run, start with the recorded suggestions: ${alternatives.join("; ")}. Check the exact source claims used to support their fit against the original buyer needs before proposing a change.`;
  }
  const decisionEvidence = capturedDecisionEvidence(input.turns);
  if (outcome !== "recommended" && outcome !== "final_choice" && technical.status === "readable" && decisionEvidence.length) {
    const fact = decisionEvidence[0]!;
    action.rationale += ` At turn ${fact.turn}, the shopping answer associated ${fact.candidate} with “${fact.quote}”. Verify that source claim and check whether the submitted product has comparable evidence for the same original need before drafting a change.`;
  }
  const candidatePath = input.turns.map((turn) => {
    const stage = stringValue(turn.stage) ?? "unknown";
    const openAction = turn.adaptive_decision?.action === "explore" || turn.adaptive_decision?.action === "verify";
    const closedAfterAbsence = outcome === "absent" && !openAction && isClosedCandidateStage(stage);
    return {
      turn: numberValue(turn.ordinal),
      stage,
      action: stringValue(turn.adaptive_decision?.action),
      reason: stringValue(turn.adaptive_decision?.reason),
      target_state: closedAfterAbsence ? "closed after earlier absence" : targetState(turn.target_observation),
      entry_status: closedAfterAbsence ? "closed_candidate_set" : "entry_observation",
      leading_candidates: turn.candidates.slice(0, 3).map((candidate) => stringValue(candidate.displayed_name)).filter(isString),
      source_domains: uniqueSourceLabels(turn.sources),
    };
  });

  const diagnosis = {
    outcome,
    identity_context: identity,
    decision_evidence: decisionEvidence,
    outcome_label: outcomeCopy.label,
    headline: outcomeCopy.headline,
    observed_result: outcomeCopy.observedResult,
    failure_point: outcomeCopy.failurePoint,
    confidence: {
      observation: evidence.completed_turns === input.turns.length && input.turns.length > 0 ? "high" : "limited",
      cause: "limited",
      explanation: "The recorded target outcome is directly observed. The cause remains a diagnostic hypothesis because this automated run does not include a branded direct-retrievability control or independent claim-by-claim source verification.",
    },
    technical_eligibility: technical,
    product_source: {
      title,
      url: input.productRecord?.final_url ?? null,
      description_word_count: descriptionWordCount,
      description_state: descriptionWordCount === 0 ? "missing" : descriptionWordCount < 40 ? "brief" : "substantive",
      evidence_label: "Captured Shopify product data",
    },
    next_action: action,
    evidence_quality: evidence,
    candidate_path_interpretation: adaptive
      ? "The next step follows evidence against the same buyer needs. Exploration and verification permit new or replacement options; comparison evaluates established candidates. These are turns in one conversation, not independent discovery samples."
      : outcome === "absent"
      ? "Discovery, refinement, and shortlisting show whether the target entered under progressively bounded, unbranded demand. Once comparison begins, the candidate set is closed and later turns analyze only the alternatives that already surfaced; they are not additional independent retrieval attempts."
      : "The path records when the target first entered and how it progressed through the same continuing conversation.",
    candidate_path: candidatePath,
    limitations: [
      "This is a controlled API observation, not a consumer ChatGPT or Gemini ranking.",
      "No branded direct-retrievability control was run, so natural absence does not by itself prove why the product was missing.",
      "Competitor specifications and purchase claims are AI-generated observations; provider-returned links do not verify every sentence or number.",
      "A captured answer can change with model, search index, market, time, and session conditions.",
    ],
  };
  if (input.interruption) {
    const observed = input.turns.filter(turn => turn.target_observation && turn.target_observation.candidate_set !== "not_observed");
    const capturedResult = observed.length ? outcomeCopy.observedResult : "No assessed shopping answer was captured, so recommendation and candidate-set inclusion cannot be determined.";
    return {
      ...diagnosis,
      outcome: "inconclusive",
      outcome_label: "Recorded evidence · outcome unresolved",
      headline: "Your evidence report is available; the shopping test did not finish.",
      observed_result: capturedResult + " This describes only the captured portion of the test, not a completed negative or positive conclusion.",
      failure_point: { label: input.interruption.stage, explanation: input.interruption.explanation },
      confidence: { observation: observed.length ? "limited to captured answers" : "not assessed", cause: "not assessed", explanation: "An execution interruption is not evidence that the product was rejected or unavailable. Only recorded answers and completed assessments appear below." },
      product_source: input.productRecord ? diagnosis.product_source : { ...diagnosis.product_source, description_state: "not_captured", evidence_label: "Product source was not captured" },
      next_action: { title: "Repeat the same shopping test once service is available", rationale: "Keep the product URL, market and buyer needs unchanged so the next completed test can be interpreted against these recorded observations.", evidence_type: "Execution limit, not a product diagnosis", hypothesis: "No product or source change is justified by the interruption itself.", retest: "Run the same product and buyer situation again; retain this report as the record of the earlier attempt." },
      candidate_path_interpretation: "This path contains only captured answers. Unfinished planning steps are not shopping observations, and unassessed answers do not establish a target outcome.",
      limitations: [input.interruption.explanation, ...diagnosis.limitations],
    };
  }
  return diagnosis;
}

export function groupReportSources(sources: Array<Record<string, unknown>>) {
  const groups = new Map<string, { label: string; url: string; urls: string[]; count: number }>();
  for (const source of sources) {
    const url = stringValue(source.url);
    if (!url) continue;
    const label = sourceLabel(source);
    const key = label.toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (!existing.urls.includes(url)) existing.urls.push(url);
    } else groups.set(key, { label, url, urls: [url], count: 1 });
  }
  return [...groups.values()];
}

function outcomeSummary(
  outcome: string,
  title: string,
  firstCandidateTurn: number | null,
  firstRecommendedTurn: number | null,
) {
  if (outcome === "absent") {
    return {
      label: "Not found in the candidate set",
      headline: `${title} did not enter this recorded shopping conversation.`,
      observedResult: "The target was absent from the unbranded discovery set and did not enter before the conversation moved into closed comparison. The later turns evaluated the alternatives that had surfaced; they were not new retrieval tests.",
      failurePoint: {
        label: "Candidate-set entry",
        explanation: "The observed failure occurred before comparison: the product was not retrieved or shortlisted while entry was still open. Later narrowing shows which competing products survived the same buyer requirements.",
      },
    };
  }
  if (outcome === "retrieved") {
    return {
      label: "Retrieved, but not shortlisted",
      headline: `${title} was found but did not enter the candidate set.`,
      observedResult: "The target was retrieved in the recorded conversation but was not included among the products considered.",
      failurePoint: { label: "Candidate-set inclusion", explanation: "The product was visible to the tested path but did not progress into the shortlist." },
    };
  }
  if (outcome === "candidate") {
    return {
      label: "Shortlisted, but not recommended",
      headline: `${title} entered the candidate set but did not win the comparison.`,
      observedResult: `The target first entered the candidate set at turn ${firstCandidateTurn ?? "unknown"} and was not recommended.`,
      failurePoint: { label: "Comparison outcome", explanation: "The product progressed into consideration but did not become a recommendation in the captured conversation." },
    };
  }
  return {
    label: outcome === "final_choice" ? "Selected as the final choice" : "Recommended",
    headline: `${title} was ${outcome === "final_choice" ? "selected" : "recommended"} in this recorded shopping conversation.`,
    observedResult: `The target first entered the candidate set at turn ${firstCandidateTurn ?? "unknown"} and was first recommended at turn ${firstRecommendedTurn ?? "unknown"}.`,
    failurePoint: { label: "No observed candidate-set failure", explanation: "The product progressed through the tested shopping decision under these recorded conditions." },
  };
}

function nextAction(outcome: string, technicalStatus: string, descriptionWordCount: number) {
  if (technicalStatus === "issues_found") {
    return {
      title: "Resolve the captured technical eligibility issue first.",
      rationale: "A crawl or page-directive issue was captured, so content changes would be difficult to interpret before access is repaired.",
      evidence_type: "Verified technical check",
      hypothesis: "Restoring observable access makes a like-for-like discovery retest valid; it does not guarantee inclusion.",
      retest: "After the repair is live, rerun the same first buyer question under the same model, market, and search conditions.",
    };
  }
  if (outcome === "absent") {
    return {
      title: "Investigate category association and external product evidence before rewriting the page.",
      rationale: "The product remained absent. The captured technical status must be interpreted separately; this automated result cannot distinguish product-source clarity from search coverage or authority. Description length alone does not establish an evidence gap.",
      evidence_type: "Recorded observation + diagnostic hypothesis",
      hypothesis: "A focused evidence review can identify the smallest merchant-controlled change worth testing.",
      retest: "Define one evidence-led change, then repeat the original first buyer question under the same conditions.",
    };
  }
  if (outcome === "candidate" || outcome === "retrieved") {
    return {
      title: "Clarify the comparison fact that matters at the observed exit point.",
      rationale: "The product was visible but did not progress to recommendation. Compare only the decision facts used for the remaining candidates and verify which relevant target fact is missing or unclear.",
      evidence_type: "Recorded comparison outcome + diagnostic hypothesis",
      hypothesis: "A truthful, decision-relevant clarification may improve comparison support without changing unrelated page elements.",
      retest: "Change one comparison fact family and repeat the corresponding baseline question under the same conditions.",
    };
  }
  return {
    title: "Preserve the baseline; do not manufacture a fix.",
    rationale: "The product progressed to recommendation in this captured conversation, so the automated evidence does not justify a page change by itself.",
    evidence_type: "Recorded observation",
    hypothesis: "Like-for-like monitoring can show whether the observed result persists without claiming a stable ranking.",
    retest: "Repeat the same question later only when monitoring or a specific change requires it.",
  };
}

function technicalSummary(check: TechnicalCheck | null) {
  if (!check) return { status: "unknown", label: "Not available", explanation: "No technical-check artifact was available for this report." };
  const blocked = check.crawler_access.some((entry) => entry.purpose !== "openai_training" && entry.result === "blocked");
  const errors = check.findings.filter((finding) => finding.severity === "error");
  if (blocked || errors.length > 0) {
    return { status: "issues_found", label: "Eligibility issue captured", explanation: "At least one search-relevant crawler or page-access issue was captured. Review the technical evidence before interpreting product absence." };
  }
  if (check.status === "complete") {
    return { status: "readable", label: "Technically readable", explanation: "The product page and structured product data were captured, and no blocking search-relevant crawler rule was observed." };
  }
  return { status: "partial", label: "Partially verified", explanation: "The technical check was incomplete, so access should be reviewed before drawing a causal conclusion." };
}

function evidenceSummary(turns: ReportTurn[], completedTurns: number) {
  const labels = uniqueSourceLabels(turns.flatMap((turn) => turn.sources));
  return {
    completed_turns: completedTurns,
    turns_with_sources: turns.filter((turn) => turn.sources.length > 0).length,
    source_records: turns.reduce((total, turn) => total + turn.sources.length, 0),
    unique_source_domains: labels.length,
    source_domains: labels,
    note: "Sources are grouped by displayed publisher. Repeated provider links may point to different pages on the same domain.",
  };
}

function targetState(target: Record<string, unknown> | null) {
  if (!target) return "not observed";
  if (target.recommendation === "final_choice") return "final choice";
  if (target.recommendation === "recommended") return "recommended";
  if (target.candidate_set === "included") return "in candidate set";
  if (target.retrievability === "retrieved") return "retrieved only";
  return "absent";
}

function isClosedCandidateStage(stage: string) {
  return stage === "comparison" || stage === "decision" || stage === "caveat_check";
}

function firstTurn(turns: ReportTurn[], dimension: string, values: string[]) {
  const turn = turns.find((item) => item.target_observation && values.includes(String(item.target_observation[dimension])));
  return turn ? numberValue(turn.ordinal) : null;
}

function fieldString(record: ProductRecord | null, field: keyof ProductRecord["fields"]) {
  const value = record?.fields[field]?.value;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uniqueSourceLabels(sources: Array<Record<string, unknown>>) {
  return [...new Set(sources.map(sourceLabel))].sort((a, b) => a.localeCompare(b));
}

function sourceLabel(source: Record<string, unknown>) {
  const title = stringValue(source.title);
  const domain = stringValue(source.source_domain);
  if (title && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title)) return title.replace(/^www\./, "");
  if (domain && domain !== "vertexaisearch.cloud.google.com") return domain.replace(/^www\./, "");
  return title ?? domain ?? "Source";
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

function isString(value: string | null): value is string {
  return value !== null;
}

// Candidate text, not source-domain presence, establishes a brand suggestion.
// A retailer may carry many brands. Missing series metadata remains unassessed.
function identitySummary(turns: ReportTurn[], record: ProductRecord | null, skuTurn: number | null) {
  const brand = fieldString(record, "vendor_brand");
  const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const brandKey = brand ? normalize(brand) : "";
  const merchant = host(record?.final_url);
  const brandSuggestions: Array<{ turn: number; name: string; recommended: boolean }> = [];
  let merchantTurn: number | null = null;
  for (const turn of turns) for (const candidate of turn.candidates) {
    const name = stringValue(candidate.displayed_name);
    if (!name) continue;
    if (merchant && (host(candidate.product_url) === merchant || host(candidate.merchant_domain) === merchant)) merchantTurn ??= numberValue(turn.ordinal);
    if (brandKey && (` ${normalize(name)} `).includes(` ${brandKey} `) && !brandSuggestions.some(c => normalize(c.name) === normalize(name))) {
      brandSuggestions.push({ turn: numberValue(turn.ordinal), name, recommended: candidate.recommended === true || candidate.recommended === 1 || candidate.final_choice === true || candidate.final_choice === 1 });
    }
  }
  return {
    brand, first_brand_candidate_turn: brandSuggestions[0]?.turn ?? null,
    first_merchant_candidate_turn: merchantTurn, first_exact_product_candidate_turn: skuTurn,
    series_status: "not independently assessed",
    brand_suggestions: brandSuggestions,
    note: "Brand suggestions and merchant matches are separate from exact product inclusion. Series membership is not inferred from a shared name or domain. Missing matches are unestablished, not proof of brand absence.",
  };
}
function host(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}

function capturedDecisionEvidence(turns: ReportTurn[]) {
  const evidence: Array<{ candidate: string; need_id: string; quote: string; turn: number; source_ids: string[] }> = [];
  for (const turn of [...turns].reverse()) {
    const parsed = AdaptiveAssessmentSchema.safeParse(turn.adaptive_decision?.assessment);
    if (!parsed.success) continue;
    for (const candidate of parsed.data.candidates) for (const need of candidate.needs) {
      if (need.status !== "supported" || need.evidence_level !== "cited_reference" || !["job"].includes(need.need_id) && !need.need_id.startsWith("required_")) continue;
      const captured = turns.find(t => numberValue(t.ordinal) === need.turn_ordinal);
      if (typeof captured?.shopping_answer !== "string" || !need.quote || !captured.shopping_answer.includes(need.quote) || !need.source_ids.length || !need.source_ids.every(id => captured.sources.some(source => source.source_id === id))) continue;
      if (evidence.some(e => e.quote === need.quote)) continue;
      evidence.push({ candidate: candidate.name, need_id: need.need_id, quote: need.quote, turn: need.turn_ordinal, source_ids: need.source_ids });
      if (evidence.length === 3) return evidence;
    }
  }
  return evidence;
}
