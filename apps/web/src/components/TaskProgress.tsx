import { diagnosticWaitExpectation } from "@mclab/domain";

import { trackConversion } from "../analytics";
import type { CustomerTask } from "../types";
import { DiagnosticReport } from "./DiagnosticReport";

export function StartingTask() {
  return (
    <section className="technical-report task-progress" id="report" aria-live="polite" aria-busy="true">
      <p className="eyebrow">CONTROLLED AI SHOPPING TEST</p>
      <h2>Your report is starting</h2>
      <div className="report-wait-state macos-window" role="status">
        <div className="macos-window-titlebar" aria-hidden="true">
          <div className="macos-traffic-lights">
            <span className="dot dot-close" />
            <span className="dot dot-minimize" />
            <span className="dot dot-zoom" />
          </div>
          <span className="macos-window-title">AI Shopping Observation · Initializing</span>
        </div>
        <div className="report-wait-body">
          <div className="scanner-radar" aria-hidden="true">
            <div className="radar-circle radar-circle-outer" />
            <div className="radar-circle radar-circle-mid" />
            <div className="radar-circle radar-circle-inner" />
            <div className="radar-crosshair-h" />
            <div className="radar-crosshair-v" />
            <div className="radar-sweep" />
            <span className="radar-target-dot" />
          </div>
          <div>
            <h3>Keep this page open or come back later.</h3>
            <p>{diagnosticWaitExpectation()}</p>
            <div className="wait-step-pills">
              <span className="wait-step-pill is-active"><i className="step-glow-dot" />Initializing test environment</span>
              <span className="wait-step-pill">Synthesizing buyer brief</span>
              <span className="wait-step-pill">Conducting shopping turns</span>
              <span className="wait-step-pill">Compiling diagnostic report</span>
            </div>
            <small>You can return to it from Sign in after the report is linked to this browser.</small>
          </div>
        </div>
      </div>
    </section>
  );
}

const DIAGNOSTIC_PIPELINE_STAGES = [
  { id: "brief", label: "Synthesizing unbranded buyer brief" },
  { id: "retrieval", label: "Running isolated direct product lookup" },
  { id: "turns", label: "Conducting blind shopping conversation" },
  { id: "audit", label: "Independent drift and target check" },
  { id: "diagnosis", label: "Evaluating candidate set and report" },
];

function getPipelineStageIndex(stageText?: string | null): number {
  if (!stageText) return 1;
  const lower = stageText.toLowerCase();
  if (lower.includes("brief") || lower.includes("understanding") || lower.includes("research")) return 0;
  if (lower.includes("retrieval") || lower.includes("lookup") || lower.includes("checking the product")) return 1;
  if (lower.includes("evaluat") || lower.includes("report") || lower.includes("diagnos") || lower.includes("compil")) return 4;
  if (lower.includes("drift") || lower.includes("independent")) return 3;
  if (
    lower.includes("shopping") || lower.includes("turn") || lower.includes("conversation")
    || lower.includes("answer") || lower.includes("buyer question") || lower.includes("planning the next")
  ) return 2;
  return 2;
}

export function TaskProgress({ task }: { task: CustomerTask }) {
  const completed = task.session.status === "completed";
  const terminalFailure = ["incomplete", "budget_exhausted", "failed_validation", "cancelled"].includes(task.session.status);
  const reportOutcome = task.session.report?.diagnosis?.outcome;
  const targetMissedShortlist = reportOutcome === "absent";
  const activePipelineIndex = getPipelineStageIndex(task.progress_stage);

  return (
    <section className="technical-report task-progress" id="report" aria-live="polite" aria-busy={!completed && !terminalFailure}>
      <p className="eyebrow">CONTROLLED AI SHOPPING TEST</p>
      <h2>{completed ? "Recorded test complete" : terminalFailure ? "Your recorded evidence report" : "Your report is being generated"}</h2>
      {completed || terminalFailure ? <p className="task-meta-bar">Task {task.id} · billing {task.billing_status} · {task.balance.available_credits} credits available</p> : null}
      {!completed && !terminalFailure ? (
        <div className="report-wait-state macos-window" role="status">
          <div className="macos-window-titlebar" aria-hidden="true">
            <div className="macos-traffic-lights">
              <span className="dot dot-close" />
              <span className="dot dot-minimize" />
              <span className="dot dot-zoom" />
            </div>
            <span className="macos-window-title">AI Shopping Observation · Live Diagnostics</span>
          </div>
          <div className="report-wait-body">
            <div className="scanner-radar" aria-hidden="true">
              <div className="radar-circle radar-circle-outer" />
              <div className="radar-circle radar-circle-mid" />
              <div className="radar-circle radar-circle-inner" />
              <div className="radar-crosshair-h" />
              <div className="radar-crosshair-v" />
              <div className="radar-sweep" />
              <span className="radar-target-dot" />
            </div>
            <div>
              <h3 className="live-progress-stage">
                <span className="live-stage-pulse" aria-hidden="true" />
                {task.progress_stage ?? "We are preparing the complete report."}
              </h3>
              <p>{diagnosticWaitExpectation()}</p>
              <ol className="diagnostic-pipeline-steps" aria-label="Diagnostic pipeline progress">
                {DIAGNOSTIC_PIPELINE_STAGES.map((item, idx) => {
                  const isPast = idx < activePipelineIndex;
                  const isCurrent = idx === activePipelineIndex;
                  return (
                    <li
                      key={item.id}
                      className={`pipeline-step ${isPast ? "is-complete" : isCurrent ? "is-running" : "is-pending"}`}
                    >
                      <span className="step-indicator">
                        {isPast ? "✓" : idx + 1}
                      </span>
                      <span className="step-text">{item.label}</span>
                    </li>
                  );
                })}
              </ol>
              <small>The diagnostic will continue in the background. You can return to it from Reports.</small>
            </div>
          </div>
        </div>
      ) : null}
      {terminalFailure ? (
        <div className="report-wait-state report-stopped">
          <h3>{task.session.report?.interruption?.stage ?? "The shopping test did not finish"}</h3>
          <p>{task.session.report?.interruption?.explanation ?? "The report below preserves the available evidence. Unanswered steps cannot establish whether your product would be recommended."}</p>
          <p>{task.billing_status === "released" ? "Reserved credits were returned. You can reopen this report from Reports." : "Your credit balance is shown above."}</p>
        </div>
      ) : null}
      {(completed || terminalFailure) && task.session.report ? <DiagnosticReport report={task.session.report} /> : null}
      {(completed || terminalFailure) && task.session.report?.disclaimer ? <small>{task.session.report.disclaimer}</small> : null}
      {completed && targetMissedShortlist ? (
        <aside className="human-upgrade">
          <h3>Want a tailored diagnosis and fix plan?</h3>
          <p>Professional review is a personalized, AI-powered $199 service for one product: diagnosis, a source-ready brief, and a retest.</p>
          <a
            href="https://geo.mclab.party/shopify-geo-audit/"
            onClick={() => trackConversion("human_service_cta", "report")}
          >Ask for professional review →</a>
        </aside>
      ) : null}
    </section>
  );
}
