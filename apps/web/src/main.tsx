import { Feedback } from './components/Feedback';
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";

import {
  CollectionError,
  previewReadiness,
  previewSnapshot,
  validatePublicProductUrl,
  type PreviewSnapshot,
  type ProductRecord,
  type TechnicalCheck,
} from "@mclab/shopify-online-store";
import {
  FREE_PREVIEW_SHARE_PARAM,
  previewFailureMessage,
} from "@mclab/domain";

import { TechnicalReport } from "./components/TechnicalReport";
import type { FreeProductPreview } from "./components/FreeProductPreview";
import { AccountAccess } from "./components/AccountAccess";
import { DiagnosticSetup } from "./components/DiagnosticSetup";
import { StartingTask, TaskProgress } from "./components/TaskProgress";
import {
  CreditPacks,
  HeroCopy,
  FreeCheckExample,
  FreeCheckQuestions,
  HowItWorks,
  OutcomeStrip,
  ProfessionalReview,
  SampleReport,
} from "./components/MarketingSections";
import { SiteFooter, SiteHeader } from "./components/SiteChrome";
import { trackConversion } from "./analytics";
import { readBootstrappedPublicOffer } from "./public-offer";
import { readPreviewSnapshot, rememberPreviewSnapshot } from "./preview-history";
import { splitList, taskArtifactLinks } from "./task-utils";
import type {
  AccountAccessState,
  ApiError,
  CollectionResult,
  CreditBalance,
  CustomerTask,
  FreeCheckState,
} from "./types";

import "./styles.css";
import "./free-check.css";

const DEFAULT_SHOPPING_MODEL_ROUTE = "observer";
const DEFAULT_SHOPPING_REASONING_EFFORT = "medium";
let consumedSharedPreview = false;

function syncPreviewShareQuery(productUrl: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(FREE_PREVIEW_SHARE_PARAM, productUrl);
  url.hash = "start";
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function App() {
  const [productUrl, setProductUrl] = useState("");
  const [result, setResult] = useState<CollectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [category, setCategory] = useState("");
  const [market, setMarket] = useState("United States");
  const [buyerJob, setBuyerJob] = useState("");
  const [useCases, setUseCases] = useState("");
  const [constraints, setConstraints] = useState("");
  const [preferences, setPreferences] = useState("");
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [accountUnavailable, setAccountUnavailable] = useState(false);
  const [accountAccess, setAccountAccess] = useState<AccountAccessState | null>(null);
  const [freeCheck, setFreeCheck] = useState<FreeCheckState>(() => {
    const enabled = readBootstrappedPublicOffer().free_check_enabled;
    return { enabled, signup_available: enabled, granted: false, remaining: 0 };
  });
  const [taskCost, setTaskCost] = useState<number | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<CustomerTask | null>(null);
  const [preview, setPreview] = useState<FreeProductPreview | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previousPreviewSnapshot, setPreviousPreviewSnapshot] = useState<PreviewSnapshot | null>(null);
  const [showCreditPrompt, setShowCreditPrompt] = useState(false);
  const completedTracked = useRef<string | null>(null);
  const focusedTaskId = useRef<string | null>(null);
  const skipPreviewScroll = useRef(false);
  const previewRequest = useRef<AbortController | null>(null);
  const taskRequest = useRef(false);
  const [previewNotice, setPreviewNotice] = useState<string | null>(null);
  useEffect(() => () => { previewRequest.current?.abort(); }, []);

  useEffect(() => trackConversion("self_check_view"), []);

  useEffect(() => {
    let active = true;
    const refresh = () => void fetch("/api/v1/billing/credits").then((response) => response.json()).then(
      (payload: { data?: CreditBalance & { account_access?: AccountAccessState; credits_per_completed_task?: number; free_check?: FreeCheckState } }) => {
        if (active && payload.data) {
          setAccountUnavailable(false);
          setBalance(payload.data);
          if (payload.data.account_access) setAccountAccess(payload.data.account_access);
          if (payload.data.free_check) setFreeCheck(payload.data.free_check);
          if (payload.data.credits_per_completed_task) setTaskCost(payload.data.credits_per_completed_task);
        } else if (active) setAccountUnavailable(true);
      },
    ).catch(() => { if (active) setAccountUnavailable(true); });
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!taskId) return;
    let active = true;
    const poll = async () => {
      const response = await fetch(`/api/v1/tasks/${taskId}`);
      const payload = await response.json() as { data?: CustomerTask; error?: { message: string } };
      if (!active) return;
      if (!response.ok || !payload.data) {
        setError(payload.error?.message ?? "Task status is unavailable.");
        return;
      }
      setTask(payload.data);
      setBalance(payload.data.balance);
      if (payload.data.session.status === "completed" && completedTracked.current !== payload.data.id) {
        completedTracked.current = payload.data.id;
        trackConversion("diagnostic_completed", "report");
      }
      if (["completed", "incomplete", "budget_exhausted", "failed_validation", "cancelled"].includes(payload.data.session.status)) {
        window.clearInterval(timer);
      }
    };
    const refresh = () => void poll().catch(() => { if (active) setError("Task status is temporarily unavailable. We’ll keep checking."); });
    refresh();
    const timer = window.setInterval(refresh, 2_500);
    return () => { active = false; window.clearInterval(timer); };
  }, [taskId]);

  useEffect(() => {
    if (!taskId || focusedTaskId.current === taskId) return;
    focusedTaskId.current = taskId;
    window.requestAnimationFrame(() => {
      document.getElementById("report")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    });
  }, [taskId]);

  useEffect(() => {
    const readable = preview !== null && !(
      preview.fields.title.value === null && preview.fields.price.value === null
    );
    if (!readable) return;
    if (skipPreviewScroll.current) {
      skipPreviewScroll.current = false;
      return;
    }
    const card = document.getElementById("free-preview-result");
    if (!card) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.requestAnimationFrame(() => {
      card.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    });
  }, [preview]);

  async function runCheck(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (taskRequest.current || taskInProgress) return;
    if (!hasEnoughCredits) {
      const guestNeedsSignup = freeCheck.signup_available && accountAccess?.status !== "connected";
      if (!guestNeedsSignup) setShowCreditPrompt(true);
      window.requestAnimationFrame(() => {
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const signupInput = document.getElementById("free-check-signup-email");
        const target = guestNeedsSignup
          ? (signupInput ?? document.getElementById("free-check-signup"))
          : document.getElementById("pricing");
        target?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
        if (guestNeedsSignup && signupInput instanceof HTMLInputElement) {
          signupInput.focus({ preventScroll: true });
        }
      });
      return;
    }
    taskRequest.current = true;
    setPending(true);
    setResult(null);
    setError(null);

    try {
      const response = await fetch("/api/v1/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_url: productUrl,
          category: category.trim() || undefined,
          target_market: market,
          buyer_job: buyerJob.trim() || undefined,
          use_cases: splitList(useCases),
          constraints: splitList(constraints),
          preferences: splitList(preferences),
          shopping_model_route: DEFAULT_SHOPPING_MODEL_ROUTE,
          shopping_reasoning_effort: DEFAULT_SHOPPING_REASONING_EFFORT,
        }),
      });
      const payload = (await response.json()) as {
        data?: {
          task_id: string;
          collection_id: string;
          product_record: ProductRecord | null;
          technical_check: TechnicalCheck | null;
        };
        error?: { message: string };
      };
      if (!response.ok || !payload.data) {
        setError(payload.error?.message ?? "The technical check could not be completed.");
        return;
      }
      setTask(null);
      setTaskId(payload.data.task_id);
      trackConversion("diagnostic_started");
      if (payload.data.product_record && payload.data.technical_check) setResult({
        collection_id: payload.data.collection_id,
        record: payload.data.product_record,
        technical_check: payload.data.technical_check,
        artifact_links: taskArtifactLinks(payload.data.task_id),
      });
    } catch {
      setError("The test could not be started. Please try again.");
    } finally {
      taskRequest.current = false;
      setPending(false);
    }
  }

  function cancelPreview(notify = true) {
    previewRequest.current?.abort();
    previewRequest.current = null;
    setPreviewPending(false);
    setPreviewNotice(notify ? "Check cancelled. You can start again." : null);
  }

  async function runFreePreview(requestedUrl = productUrl) {
    if (previewRequest.current) return;
    try {
      requestedUrl = validatePublicProductUrl(requestedUrl).toString();
    } catch (error) {
      setPreviewError(previewFailureMessage(error instanceof CollectionError ? { code: error.code } : { code: "INVALID_URL" }));
      return;
    }
    setPreviewNotice(null);
    const refreshing = preview !== null && !previewError;
    skipPreviewScroll.current = refreshing;
    setPreviewPending(true);
    if (!refreshing) setPreview(null);
    setPreviewError(null);
    trackConversion("preview_started");
    const controller = new AbortController();
    previewRequest.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    let nextPreview: FreeProductPreview | null = null;
    let nextError: string | null = null;
    try {
      const response = await fetch("/api/v1/free-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_url: requestedUrl }),
        signal: controller.signal,
      });
      const payload = await response.json() as { data?: FreeProductPreview; error?: ApiError };
      if (previewRequest.current !== controller) return;
      if (!response.ok || !payload.data) {
        nextError = previewFailureMessage(payload.error);
      } else {
        nextPreview = payload.data;
        const readiness = previewReadiness(nextPreview);
        const previous = readPreviewSnapshot(nextPreview.product_url) ?? readPreviewSnapshot(requestedUrl);
        setPreviousPreviewSnapshot(previous);
        rememberPreviewSnapshot(previewSnapshot(readiness), [requestedUrl, nextPreview.product_url]);
        syncPreviewShareQuery(nextPreview.product_url);
        trackConversion("preview_completed");
        if (refreshing) trackConversion("preview_recheck_completed");
      }
    } catch (error) {
      nextError = error instanceof DOMException && error.name === "AbortError"
        ? "The preview timed out. Check the URL and try again."
        : "The free preview is temporarily unavailable.";
    } finally {
      window.clearTimeout(timeout);
      if (previewRequest.current === controller) {
        previewRequest.current = null;
        setPreview(nextPreview);
        setPreviewError(nextError);
        setPreviewPending(false);
      }
    }
  }

  useEffect(() => {
    if (consumedSharedPreview) return;
    const raw = new URLSearchParams(window.location.search).get(FREE_PREVIEW_SHARE_PARAM);
    if (!raw) return;
    consumedSharedPreview = true;
    try {
      const url = validatePublicProductUrl(raw).toString();
      setProductUrl(url);
      void runFreePreview(url);
    } catch (error) {
      setProductUrl(raw);
      setPreviewError(previewFailureMessage(
        error instanceof CollectionError ? { code: error.code, message: error.message } : { code: "INVALID_URL" },
      ));
    }
  }, []);

  const requiredCredits = taskCost ?? 30;
  const hasEnoughCredits = (balance?.available_credits ?? 0) >= requiredCredits;
  const freeCheckRemaining = freeCheck?.remaining === 1;
  const previewReadable = preview !== null && !(
    preview.fields.title.value === null && preview.fields.price.value === null
  );
  const showHeroSignup = Boolean(
    freeCheck.enabled &&
    freeCheck.signup_available &&
    accountAccess?.status !== "connected" &&
    !freeCheckRemaining,
  );

  const taskInProgress = Boolean(taskId && (!task || !["completed", "incomplete", "budget_exhausted", "failed_validation", "cancelled"].includes(task.session.status)));

  return (
    <main>
      <SiteHeader
        accountAccess={accountAccess}
        balance={balance}
        freeCheckRemaining={freeCheckRemaining}
        requiredCredits={requiredCredits}
      />

      <section className={`hero self-check-hero free-first${preview || previewPending || previewError ? " has-result" : ""}`}>
        <div className="hero-layout">
        <div className="hero-intro">
        <HeroCopy />

        <DiagnosticSetup
          productUrl={productUrl}
          onProductUrlChange={(value) => {
            cancelPreview(false);
            setProductUrl(value);
            setPreview(null);
            setPreviewError(null);
            setPreviousPreviewSnapshot(null);
          }}
          preview={preview}
          previewPending={previewPending}
          previewError={previewError}
          previousPreviewSnapshot={previousPreviewSnapshot}
          previewReadable={previewReadable}
          onRunPreview={() => void runFreePreview()}
          onCancelPreview={() => cancelPreview()}
          previewNotice={previewNotice}
          onSubmit={runCheck}
          pending={pending}
          activeTask={taskInProgress}
          market={market}
          onMarketChange={setMarket}
          category={category}
          onCategoryChange={setCategory}
          buyerJob={buyerJob}
          onBuyerJobChange={setBuyerJob}
          useCases={useCases}
          onUseCasesChange={setUseCases}
          constraints={constraints}
          onConstraintsChange={setConstraints}
          preferences={preferences}
          onPreferencesChange={setPreferences}
          freeCheckEnabled={freeCheck.enabled}
          showHeroSignup={showHeroSignup}
          freeCheckRemaining={freeCheckRemaining}
          requiredCredits={requiredCredits}
        />

        {pending ? <p className="progress" role="status">Starting your recorded AI shopping test…</p> : null}
        {!preview && !previewPending && !previewError ? <p className="hero-links"><a href="#free-example">See an example report ↓</a><a href="#recorded-test">Explore the optional AI test ↓</a></p> : <p className="hero-links"><a href="#feedback">Report a problem with this check</a></p>}
        {error ? <p className="result" role="alert">{error}</p> : null}

        </div>
        {!preview && !previewPending && !previewError ? <FreeCheckExample /> : null}
        </div>
        <OutcomeStrip />
      </section>

      {taskId && !task ? <StartingTask /> : null}
      {task ? <TaskProgress task={task} /> : null}

      {result ? (
        <TechnicalReport
          collectionId={result.collection_id}
          record={result.record}
          technicalCheck={result.technical_check}
          artifactLinks={result.artifact_links}
        />
      ) : null}

      <HowItWorks freeCheckEnabled={freeCheck.enabled} />

      <CreditPacks
        freeCheckEnabled={freeCheck.enabled}
        showCreditPrompt={showCreditPrompt}
        freeCheckGranted={freeCheck.granted}
        freeCheckRemainingZero={freeCheck.remaining === 0}
        requiredCredits={requiredCredits}
      />

      <FreeCheckQuestions />

      <SampleReport />

      <ProfessionalReview />

      <AccountAccess
        accountAccess={accountAccess}
        unavailable={accountUnavailable}
        balance={balance}
        freeCheck={freeCheck}
        onOpenReport={(id) => { if (id !== taskId) setTask(null); setTaskId(id); window.location.hash = "report"; }}
      />

      <Feedback taskId={task ? taskId ?? undefined : undefined} productUrl={preview?.product_url} />

      <SiteFooter />
    </main>
  );
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("Application root is missing.");
}

createRoot(root).render(<App />);
