// Public descriptions are allow-listed. Never expose provider errors, prompts,
// credentials or private validation text in a customer report.
export function reportInterruption(status: string, calls: Array<Record<string, unknown>> = [], preparationStage?: string) {
  const last = [...calls].reverse().find(call => ["incomplete", "failed_validation", "budget_rejected"].includes(String(call.status)));
  const stage = preparationStage ?? ({ query_generator: "Reviewing the shopping evidence", query_auditor: "Reviewing the next buyer question", shopping_observer: "Obtaining a shopping answer", result_classifier: "Assessing the captured shopping answer" }[String(last?.role)] ?? "Completing the shopping test");
  const code = String(last?.error_code ?? "");
  const explanation = code === "MODEL_RATE_LIMITED" ? "The model service could not accept the next request. Captured evidence is retained below."
    : code === "MODEL_TIMEOUT_UNCERTAIN" ? "The model service did not return a confirmed result. The unanswered request is not counted as a shopping observation."
    : status === "budget_exhausted" ? "The run reached its execution allowance before a complete assessment was available."
    : status === "failed_validation" ? "The next internal assessment could not be validated. Earlier captured answers are retained and are not treated as a completed negative result."
    : status === "cancelled" ? "The run was cancelled before the shopping test finished."
    : "The next step did not return a usable result. All available captured evidence is retained below.";
  return { stage, explanation };
}
