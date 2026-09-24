import {
  AiEvidenceAnalysisSchema,
  CONTRACT_VERSIONS,
  type AiEvidenceAnalysis,
  type EvidenceItem,
  type EvidencePack,
} from "@mclab/contracts";

export function validateEvidenceLinks(
  candidate: unknown,
  pack: EvidencePack,
): AiEvidenceAnalysis {
  const analysis = AiEvidenceAnalysisSchema.parse(candidate);
  const evidenceById = new Map(pack.items.map((item) => [item.id, item.text]));
  for (const finding of analysis.findings) {
    for (const citation of finding.evidence) {
      const sourceText = evidenceById.get(citation.evidence_id);
      if (!sourceText) {
        throw new Error(`Finding references evidence outside the captured pack: ${citation.evidence_id}`);
      }
      if (!normalize(sourceText).includes(normalize(citation.quote))) {
        throw new Error(`Finding quote does not occur in captured evidence: ${citation.evidence_id}`);
      }
    }
  }
  return analysis;
}

export function buildFixtureAnalysis(pack: EvidencePack): AiEvidenceAnalysis {
  const title = findEvidence(pack.items, "fields.title.");
  const brand = findEvidence(pack.items, "fields.vendor_brand.");
  const category = findEvidence(pack.items, "fields.product_type_category.");
  const description = findEvidence(pack.items, "fields.description.");
  const findings: AiEvidenceAnalysis["findings"] = [];

  if (category) {
    findings.push({
      kind: "category_bridge",
      statement: `The page explicitly associates the product with “${shorten(category.text, 180)}”.`,
      evidence: [{ evidence_id: category.id, quote: excerpt(category.text, 180) }],
      confidence: "high",
    });
  }
  if (description) {
    findings.push({
      kind: "use_case",
      statement: `The captured description supplies a possible shopper-use signal: “${shorten(description.text, 220)}”.`,
      evidence: [{ evidence_id: description.id, quote: excerpt(description.text, 220) }],
      confidence: "medium",
    });
  }
  if (!category) {
    const fallback = title ?? brand;
    if (fallback) {
      findings.push({
        kind: "limitation",
        statement: "No explicit category observation was captured; category association would require inference from weaker page evidence.",
        evidence: [{ evidence_id: fallback.id, quote: excerpt(fallback.text, 180) }],
        confidence: "high",
      });
    }
  }

  const subject = title?.text ?? brand?.text ?? "this product";
  return validateEvidenceLinks(
    {
      schema_version: CONTRACT_VERSIONS.report,
      summary: `Fixture-only evidence analysis for ${shorten(subject, 160)}. It validates the workflow and citations; it is not a live model recommendation test.`,
      findings,
      unresolved_questions: [
        "A live qualified model route is still required to observe candidate-set inclusion.",
        "External authority and conflicting third-party sources were not evaluated by this page-evidence fixture.",
      ],
    },
    pack,
  );
}

function findEvidence(items: EvidenceItem[], pathPrefix: string): EvidenceItem | undefined {
  return items.find((item) => item.path.startsWith(pathPrefix));
}

function shorten(value: string, max: number): string {
  const normalized = normalize(value);
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function excerpt(value: string, max: number): string {
  return normalize(value).slice(0, max);
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
