import type { AdaptiveAssessment, BlindConversationContext } from "@mclab/contracts";
import { frozenBuyerNeeds } from "@mclab/domain";

// Match presentation-only differences, then return an actual contiguous raw
// span. Never paraphrase, concatenate passages, change units, or infer sources.
export function capturedQuote(answer: string, quote: string): string {
  if (!quote || answer.includes(quote)) return quote;
  const project = (text: string) => {
    const hidden = new Set<number>();
    for (const match of text.matchAll(/(\*\*|__|`)(?=\S)([^\n]*?\S)\1/g)) {
      const start = match.index!;
      const width = match[1]!.length;
      for (let i = 0; i < width; i++) {
        hidden.add(start + i);
        hidden.add(start + match[0].length - width + i);
      }
    }
    let visible = "";
    const offsets: number[] = [];
    for (let i = 0; i < text.length; i++) {
      if (hidden.has(i)) continue;
      const char = /\s/.test(text[i]!) ? " " : text[i]!;
      if (char === " " && visible.endsWith(" ")) continue;
      visible += char;
      offsets.push(i);
    }
    return { visible, offsets };
  };
  const source = project(answer);
  const needle = project(quote).visible.trim();
  if (!needle) return quote;
  // Only a quotation's opening letter may change case. Interior case carries
  // meaning (for example mW vs MW), and punctuation/numbers remain exact.
  const variants = new Set([needle, ...(/^[A-Za-z]/.test(needle) ? [needle[0]!.toUpperCase() + needle.slice(1), needle[0]!.toLowerCase() + needle.slice(1)] : [])]);
  for (const variant of variants) {
    const index = source.visible.indexOf(variant);
    if (index < 0) continue;
    return answer.slice(source.offsets[index], source.offsets[index + variant.length - 1]! + 1);
  }
  return quote; // Strict domain validation still rejects unmatched evidence.
}

export function anchorEvidenceQuotes(context: BlindConversationContext, assessment: AdaptiveAssessment): AdaptiveAssessment {
  const answers = new Map(context.completed_turns.map(turn => [turn.ordinal, turn.assistant_message]));
  return {
    ...assessment,
    candidates: assessment.candidates.map(candidate => ({
      ...candidate,
      needs: candidate.needs.map(need => ({
        ...need,
        quote: capturedQuote(answers.get(need.turn_ordinal) ?? "", need.quote),
      })),
    })),
    decision_quote: capturedQuote(answers.get(assessment.decision_turn_ordinal) ?? "", assessment.decision_quote),
  };
}

// A bad planner claim is unknown evidence, not a failed shopping observation.
// Keep the provider output separately; only this conservative projection may
// reach the strict decision gate. This never upgrades an unsupported claim.
export function recoverAdaptiveEvidence(context: BlindConversationContext, raw: AdaptiveAssessment): AdaptiveAssessment {
  const assessment = anchorEvidenceQuotes(context, raw);
  const turns = new Map(context.completed_turns.map(turn => [turn.ordinal, turn]));
  const needIds = new Set(frozenBuyerNeeds(context.buyer_brief).map(need => need.id));
  const names = new Set<string>();
  const candidates = assessment.candidates.filter(candidate => {
    const name = candidate.name.toLowerCase().trim();
    const answer = turns.get(candidate.turn_ordinal)?.assistant_message;
    if (!answer?.includes(candidate.identity_quote) || !candidate.identity_quote.toLowerCase().includes(candidate.name.toLowerCase()) || names.has(name)) return false;
    names.add(name);
    return true;
  }).map(candidate => {
    const seen = new Set<string>();
    return { ...candidate, needs: candidate.needs.filter(need => {
      if (!needIds.has(need.need_id) || seen.has(need.need_id)) return false;
      seen.add(need.need_id);
      return true;
    }).map(need => {
      const turn = turns.get(need.turn_ordinal);
      const validQuote = Boolean(need.quote && need.quote.length <= 700 && turn?.assistant_message.includes(need.quote));
      const validSources = need.source_ids.every(id => turn?.sources?.some(source => source.source_id === id));
      const validLevel = !(need.status === "supported" && ["conflict", "unknown"].includes(need.evidence_level)) && !(need.evidence_level === "cited_reference" && !need.source_ids.length);
      if ((need.quote && !validQuote) || (need.status !== "unknown" && !validQuote) || !validSources || !validLevel) {
        return { ...need, status: "unknown" as const, evidence_level: "unknown" as const, quote: "", source_ids: [] };
      }
      return need;
    }) };
  });
  return {
    ...assessment,
    candidates,
    need_ids: assessment.need_ids.filter(id => needIds.has(id)),
    decision_quote: assessment.decision_quote.length <= 600 && turns.get(assessment.decision_turn_ordinal)?.assistant_message.includes(assessment.decision_quote) ? assessment.decision_quote : "",
  };
}
