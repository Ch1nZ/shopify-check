import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import type {
  AiEvidenceAnalysis,
  ModelCapability,
  ModelRouteKey,
  ReasoningEffort,
} from "@mclab/contracts";

type RunResult = {
  id: string;
  status: "queued" | "running" | "fixture_completed" | "completed" | "incomplete";
  mode: "fixture" | "live";
  model_id: string;
  reasoning_effort: ReasoningEffort;
  target_market: string;
  analysis?: AiEvidenceAnalysis;
  error_message?: string | null;
};

export function AiTestPanel({ collectionId }: { collectionId: string }) {
  const [models, setModels] = useState<ModelCapability[]>([]);
  const [routeKey, setRouteKey] = useState<ModelRouteKey>("observer");
  const [reasoning, setReasoning] = useState<ReasoningEffort>("medium");
  const [market, setMarket] = useState("United States");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<RunResult | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/model-capabilities")
      .then((response) => response.json())
      .then((payload: { data?: { registry?: ModelCapability[] } }) => {
        if (active) setModels(payload.data?.registry ?? []);
      })
      .catch(() => {
        if (active) setError("Model configuration could not be loaded.");
      });
    return () => { active = false; };
  }, []);

  const selected = useMemo(
    () => models.find((model) => model.route_key === routeKey),
    [models, routeKey],
  );

  async function startFixture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setRun(null);
    setError(null);
    try {
      const response = await fetch("/api/v1/dev/ai-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collection_id: collectionId,
          route_key: routeKey,
          reasoning_effort: reasoning,
          target_market: market,
        }),
      });
      const payload = await response.json() as {
        data?: { run_id: string };
        error?: { message: string };
      };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "Fixture run could not start.");
      const completed = await pollRun(payload.data.run_id);
      setRun(completed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Fixture run could not be completed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="report-section ai-test macos-window" aria-labelledby="ai-test-title">
      <div className="macos-window-titlebar" aria-hidden="true">
        <div className="macos-traffic-lights">
          <span className="dot dot-close" />
          <span className="dot dot-minimize" />
          <span className="dot dot-zoom" />
        </div>
        <span className="macos-window-title">Diagnostics Utility · Model Configuration</span>
      </div>
      <div className="section-intro">
        <p className="eyebrow">CONTROLLED AI SHOPPING TEST</p>
        <h3 id="ai-test-title">Choose the recorded test conditions.</h3>
        <p>
          This preview validates evidence handling with a free fixture. The listed model routes are
          catalog-verified but have not yet passed a paid live qualification run.
        </p>
      </div>

      <form className="ai-config" onSubmit={startFixture}>
        <label>
          Model route
          <select value={routeKey} onChange={(event) => setRouteKey(event.target.value as ModelRouteKey)}>
            {models.map((model) => <option key={model.route_key} value={model.route_key}>{model.display_name}</option>)}
          </select>
        </label>
        <label>
          Thinking strength
          <select value={reasoning} onChange={(event) => setReasoning(event.target.value as ReasoningEffort)}>
            {(selected?.supported_reasoning ?? ["low", "medium", "high"]).map((effort) => (
              <option key={effort} value={effort}>{effort}</option>
            ))}
          </select>
        </label>
        <label>
          Target market
          <input value={market} minLength={2} maxLength={80} required onChange={(event) => setMarket(event.target.value)} />
        </label>
        <div className="ai-cost">
          <span>Complete live task</span>
          <strong>{selected?.credit_cost ?? 30} credits</strong>
          <small>Fixture preview: 0 credits</small>
        </div>
        <button type="submit" disabled={pending || !selected}>
          {pending ? "Running fixture…" : "Run evidence fixture"}
        </button>
      </form>

      <p className="route-note">
        Controlled API / OpenRouter · native search configured · provider pinned · fallback disabled
      </p>
      {error ? <p className="result" role="alert">{error}</p> : null}
      {run?.analysis ? <AiRunResult run={run} /> : null}
    </div>
  );
}

function AiRunResult({ run }: { run: RunResult }) {
  return (
    <section className="ai-result" aria-labelledby="ai-result-title">
      <div className="ai-result-meta">
        <span className="state state-verified">fixture complete</span>
        <span>{run.model_id}</span>
        <span>{run.reasoning_effort} thinking</span>
        <span>{run.target_market}</span>
      </div>
      <h4 id="ai-result-title">Evidence-linked interpretation preview</h4>
      <p>{run.analysis?.summary}</p>
      <ol>
        {run.analysis?.findings.map((finding, index) => (
          <li key={`${finding.kind}-${index}`}>
            <div><strong>{label(finding.kind)}</strong><p>{finding.statement}</p></div>
            <small>{finding.confidence} confidence · {finding.evidence.map((citation) => citation.evidence_id).join(", ")}</small>
          </li>
        ))}
      </ol>
      <div className="fixture-warning">
        <strong>What this does not prove</strong>
        <ul>{run.analysis?.unresolved_questions.map((question) => <li key={question}>{question}</li>)}</ul>
      </div>
    </section>
  );
}

async function pollRun(runId: string): Promise<RunResult> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`/api/v1/dev/ai-runs/${runId}`);
    const payload = await response.json() as { data?: RunResult; error?: { message: string } };
    if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "Run status is unavailable.");
    if (["fixture_completed", "completed"].includes(payload.data.status)) return payload.data;
    if (payload.data.status === "incomplete") {
      throw new Error(payload.data.error_message ?? "The model run was incomplete.");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The fixture is still queued. Its saved run can be checked again later.");
}

function label(kind: AiEvidenceAnalysis["findings"][number]["kind"]): string {
  return kind.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}
