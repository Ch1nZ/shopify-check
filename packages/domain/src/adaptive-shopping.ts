import { AdaptiveAssessmentSchema, AdaptiveDecisionSchema, type AdaptiveAssessment, type AdaptiveDecision, type BlindConversationContext, type BuyerBrief, type GeneratedShoppingQuery, type ShoppingProtocol } from "@mclab/contracts";

export type FrozenNeed = { id: string; text: string; priority: "required" | "preference" | "risk_check" };
export function frozenBuyerNeeds(brief: BuyerBrief): FrozenNeed[] {
  return [
    { id: "category", text: brief.category, priority: "required" as const },
    { id: "job", text: brief.buyer_job, priority: "required" as const },
    { id: "market", text: `Purchasable or deliverable to ${brief.target_market}`, priority: "required" as const },
    ...(brief.budget ? [{ id: "budget", text: `Maximum budget ${brief.budget.maximum_minor / 100} ${brief.budget.currency}`, priority: "required" as const }] : []),
    ...brief.constraints.map((text, i) => ({ id: `required_${i}`, text, priority: "required" as const })),
    ...brief.preferences.map((text, i) => ({ id: `preference_${i}`, text, priority: "preference" as const })),
    ...brief.market_requirements.map((text, i) => ({ id: `market_${i}`, text, priority: "required" as const })),
  ];
}

export function isAdaptiveProtocol(protocol: ShoppingProtocol): boolean {
  return protocol.protocol_id === "evidence-driven-shopping" && ["2026-09-adaptive-v1", "2026-09-langgraph-v1"].includes(protocol.protocol_revision);
}

// Explicit allow-list excludes target identity, target classifications, and even
// candidate names/answer-shapes supplied by the private result classifier.
export function adaptiveBlindInput(context: BlindConversationContext) {
  return {
    needs: frozenBuyerNeeds(context.buyer_brief),
    turns: context.completed_turns.map(t => ({ ordinal: t.ordinal, question: t.user_message, answer: t.assistant_message, sources: t.sources ?? [] })),
  };
}

export function initialAdaptiveDecision(): AdaptiveDecision {
  return { version: "adaptive-controller/1.0", action: "explore", reason: "initial_discovery", need_ids: [], candidate_names: [], evidence_signatures: [], no_progress_count: 0, repair_count: 0, assessment: null };
}

// Formatting is not a new product or new evidence. Preserve numbers and words;
// this deliberately does not merge different models, variants or translated names.
function evidenceIdentity(value: string): string {
  return value.normalize("NFKC").replace(/[*_`]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function evaluateAdaptiveAssessment(context: BlindConversationContext, raw: AdaptiveAssessment): AdaptiveDecision {
  const assessment = AdaptiveAssessmentSchema.parse(raw);
  const needs = frozenBuyerNeeds(context.buyer_brief);
  const ids = new Set(needs.map(n => n.id));
  const turnByOrdinal = new Map(context.completed_turns.map(t => [t.ordinal, t]));
  if (assessment.need_ids.some(id => !ids.has(id))) throw new Error("Adaptive plan references an unknown frozen need.");
  const identities = new Set<string>();
  for (const candidate of assessment.candidates) {
    const identityTurn = turnByOrdinal.get(candidate.turn_ordinal);
    if (!identityTurn?.assistant_message.includes(candidate.identity_quote) || !candidate.identity_quote.toLowerCase().includes(candidate.name.toLowerCase())) throw new Error("Candidate identity quote is not in the captured answer.");
    const name = candidate.name.toLowerCase().trim();
    if (identities.has(name)) throw new Error("Duplicate adaptive candidate identity.");
    identities.add(name);
    const candidateNeeds = new Set<string>();
    for (const need of candidate.needs) {
      if (!ids.has(need.need_id) || candidateNeeds.has(need.need_id)) throw new Error("Invalid or duplicate candidate need ID.");
      candidateNeeds.add(need.need_id);
      const sourceTurn = turnByOrdinal.get(need.turn_ordinal);
      if (need.status !== "unknown" && (!need.quote || !sourceTurn?.assistant_message.includes(need.quote))) throw new Error("Need evidence quote is absent from the captured answer.");
      if (need.source_ids.some(id => !sourceTurn?.sources?.some(s => s.source_id === id))) throw new Error("Need references an unknown captured source.");
      if (need.status === "supported" && (need.evidence_level === "conflict" || need.evidence_level === "unknown")) throw new Error("Unsupported evidence promotion.");
      if (need.evidence_level === "cited_reference" && !need.source_ids.length) throw new Error("Cited evidence has no source.");
    }
  }
  if (assessment.decision_quote && !turnByOrdinal.get(assessment.decision_turn_ordinal)?.assistant_message.includes(assessment.decision_quote)) throw new Error("Decision quote is absent from captured answers.");
  const previous = context.completed_turns.map(t => AdaptiveDecisionSchema.safeParse(t.adaptive_decision)).filter(p => p.success).map(p => p.data!).at(-1);
  const signatures = assessment.candidates.flatMap(c => [
    `candidate:${evidenceIdentity(c.name)}:${c.category_fit}`,
    ...c.needs.filter(n => n.status !== "unknown").map(n => `${evidenceIdentity(c.name)}:${n.need_id}:${n.status}:${n.evidence_level}`),
  ]);
  const priorSignatures = new Set(context.completed_turns.flatMap(t => {
    const parsed = AdaptiveDecisionSchema.safeParse(t.adaptive_decision);
    return parsed.success ? parsed.data.evidence_signatures.map(evidenceIdentity) : [];
  }));
  const progress = signatures.some(s => !priorSignatures.has(evidenceIdentity(s)));
  const noProgress = progress ? 0 : (previous?.no_progress_count ?? 0) + 1;
  const hard = needs.filter(n => n.priority === "required");
  const fullySupported = assessment.candidates.filter(c => c.category_fit === "supported" && hard.every(n => c.needs.some(e => e.need_id === n.id && e.status === "supported" && e.evidence_level === "cited_reference")));
  const plausible = assessment.candidates.filter(c => c.category_fit !== "contradicted" && !c.needs.some(n => hard.some(h => h.id === n.need_id) && n.status === "contradicted"));
  let action: AdaptiveDecision["action"];
  let reason: AdaptiveDecision["reason"];
  if (assessment.decision_quote && fullySupported.some(c => evidenceIdentity(assessment.decision_quote).includes(evidenceIdentity(c.name))) && !assessment.demand_drift && assessment.proposed_action === "finish") {
    action = "finish"; reason = "decision_supported";
  } else if (noProgress >= 2) {
    action = "stop"; reason = "no_progress";
  } else if (context.completed_turns.length >= context.protocol.maximum_turns) {
    action = "stop"; reason = "turn_limit";
  } else if (assessment.demand_drift || plausible.length === 0) {
    action = "explore"; reason = "unmet_needs";
  } else if (fullySupported.length >= 2) {
    action = "compare"; reason = "comparison_ready";
  } else {
    action = "verify"; reason = "unknown_evidence";
  }
  // A repair is an additional open search, not the initial discovery.
  const repairCount = (previous?.repair_count ?? 0) + (action === "explore" ? 1 : 0);
  if (repairCount > 2 && action === "explore") { action = "stop"; reason = "no_progress"; }
  const unresolved = hard.filter(n => !fullySupported.length && plausible.some(c => !c.needs.some(e => e.need_id === n.id && e.status === "supported" && e.evidence_level === "cited_reference")));
  const selected = unresolved.length ? unresolved.slice(0, 2).map(n => n.id) : assessment.need_ids.filter(id => hard.some(n => n.id === id)).slice(0, 2);
  // Never send an empty verification loop. One supported option needs a decision,
  // not further checking of unrelated candidates or soft preferences.
  if (action === "verify" && fullySupported.length) {
    action = "compare"; reason = "comparison_ready";
  }
  if (action === "verify" && !selected.length) { action = "stop"; reason = "no_progress"; }
  const recent = context.completed_turns.slice(-2).map(t => AdaptiveDecisionSchema.safeParse(t.adaptive_decision));
  if ((action === "verify" || action === "compare") && recent.length === 2 && recent.every(p => p.success && p.data.action === action && [...p.data.need_ids].sort().join() === [...selected].sort().join())) {
    action = "stop"; reason = "no_progress";
  }
  return AdaptiveDecisionSchema.parse({ version: "adaptive-controller/1.0", action, reason, need_ids: selected, candidate_names: (action === "compare" ? fullySupported : plausible).map(c => c.name), evidence_signatures: signatures, no_progress_count: noProgress, repair_count: repairCount, assessment });
}

export function adaptiveStage(decision: AdaptiveDecision): ShoppingProtocol["turns"][number]["stage"] {
  if (decision.reason === "initial_discovery") return "discovery";
  if (decision.action === "compare") return "comparison";
  if (decision.action === "verify") return "caveat_check";
  return "refinement";
}

export function renderAdaptiveQuestion(context: BlindConversationContext, decision: AdaptiveDecision): GeneratedShoppingQuery {
  const brief = context.buyer_brief;
  const needs = frozenBuyerNeeds(brief);
  const selected = needs.filter(n => decision.need_ids.includes(n.id));
  const sentence = (text: string) => text.trim().replace(/[.!?]+$/, "");
  const clauses = selected.map(n => `${n.priority === "preference" ? "Preference, not a requirement" : "Please establish this original requirement"}: ${sentence(n.text)}.`).join(" ") + (selected.length ? " " : "");
  const budget = brief.budget ? ` My maximum budget is ${brief.budget.maximum_minor / 100} ${brief.budget.currency}.` : "";
  let message: string;
  if (decision.reason === "initial_discovery") {
    message = `I'm shopping in ${sentence(brief.target_market)} for ${sentence(brief.category)}. ${sentence(brief.buyer_job)}. ${brief.constraints.length ? `My requirements are: ${brief.constraints.map(sentence).join("; ")}. ` : ""}${brief.market_requirements.length ? `For purchase and delivery: ${brief.market_requirements.map(sentence).join("; ")}. ` : ""}What specific products would suit this?${budget}`;
  } else if (decision.action === "explore") {
    message = `Please look for specific ${brief.category} options for my original need: ${brief.buyer_job}. Keep delivery or purchase in ${brief.target_market} in scope. ${clauses}New products are welcome; please do not limit the search to the previous suggestions. Show sources and say when a requirement cannot be established.`;
  } else if (decision.action === "compare") {
    message = `Please compare the suitable options already discussed against my original needs. ${clauses}Explain the tradeoffs, distinguish sourced facts from assumptions, and say whether there is enough evidence to choose. If a required need cannot be established, say so rather than force a winner.`;
  } else if (decision.action === "verify") {
    message = `Could you resolve the following purchase requirements for the options discussed? ${clauses}Check those points in the original sources and identify which option each finding applies to. Distinguish current listing facts from assumptions, conflicting sources, and anything requiring checkout or seller confirmation. If these options do not meet my original needs, other products are welcome. If enough is supported, explain which option suits the original needs and why.`;
  } else {
    message = "The recorded evidence review has ended; no further shopper message was sent.";
  }
  return { message, used_constraint_indexes: decision.reason === "initial_discovery" ? brief.constraints.map((_, i) => i) : selected.flatMap(n => n.id.startsWith("required_") ? [Number(n.id.slice(9))] : n.id.startsWith("preference_") ? [brief.constraints.length + Number(n.id.slice(11))] : []), naturalness_note: "Frozen buyer wording; adaptive evidence task.", adaptive_decision: decision };
}
