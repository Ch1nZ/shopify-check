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
import { SiteFooter, SiteHeader, StickyStart } from "./components/SiteChrome";
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

  useEffect(() => trackConversion("self_check_view"), []);

  useEffect(() => {
    let active = true;
    const refresh = () => void fetch("/api/v1/billing/credits").then((response) => response.json()).then(
      (payload: { data?: CreditBalance & { account_access?: AccountAccessState; credits_per_completed_task?: number; free_check?: FreeCheckState } }) => {
        if (active && payload.data) {
          setBalance(payload.data);
          if (payload.data.account_access) setAccountAccess(payload.data.account_access);
          if (payload.data.free_check) setFreeCheck(payload.data.free_check);
          if (payload.data.credits_per_completed_task) setTaskCost(payload.data.credits_per_completed_task);
        }
      },
    );
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
    void poll();
    const timer = window.setInterval(() => void poll(), 2_500);
    return () => { active = false; window.clearInterval(timer); };
  }, [taskId]);

  useEffect(() => {
    if (!taskId || focusedTaskId.current === taskId) return;
    focusedTaskId.current = taskId;
    window.requestAnimationFrame(() => {
      document.getElementById("report")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
      setTaskId(payload.data.task_id);
      trackConversion("diagnostic_started");
      if (payload.data.product_record && payload.data.technical_check) setResult({
        collection_id: payload.data.collection_id,
        record: payload.data.product_record,
        technical_check: payload.data.technical_check,
        artifact_links: taskArtifactLinks(payload.data.task_id),
      });
    } catch {
      setError("The development API is not available.");
    } finally {
      setPending(false);
    }
  }

  async function runFreePreview(requestedUrl = productUrl) {
    const refreshing = preview !== null && !previewError;
    skipPreviewScroll.current = refreshing;
    setPreviewPending(true);
    if (!refreshing) setPreview(null);
    setPreviewError(null);
    trackConversion("preview_started");
    const startedAt = Date.now();
    const controller = new AbortController();
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
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const wait = (reducedMotion ? 0 : 700) - (Date.now() - startedAt);
      if (wait > 0) await new Promise((resolve) => window.setTimeout(resolve, wait));
      setPreview(nextPreview);
      setPreviewError(nextError);
      setPreviewPending(false);
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

  function handleStartSubmit(event: FormEvent<HTMLFormElement>) {
    if (!previewReadable) {
      event.preventDefault();
      if (!previewPending) void runFreePreview();
      return;
    }
    void runCheck(event);
  }

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
        <HeroCopy freeCheckEnabled={freeCheck.enabled} hasResult={Boolean(preview || previewPending || previewError)} />

        <DiagnosticSetup
          productUrl={productUrl}
          onProductUrlChange={(value) => {
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
          onSubmit={handleStartSubmit}
          pending={pending}
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

        {pending ? <p className="progress" role="status">Reading the public page, Shopify product data, and robots.txt. This usually takes a few seconds.</p> : null}
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

      <Feedback taskId={task ? taskId ?? undefined : undefined} productUrl={preview?.product_url} />

      <FreeCheckQuestions />
      <HowItWorks freeCheckEnabled={freeCheck.enabled} />

      <SampleReport />

      <CreditPacks
        freeCheckEnabled={freeCheck.enabled}
        showCreditPrompt={showCreditPrompt}
        freeCheckGranted={freeCheck.granted}
        freeCheckRemainingZero={freeCheck.remaining === 0}
        requiredCredits={requiredCredits}
      />

      <ProfessionalReview />

      <AccountAccess
        accountAccess={accountAccess}
        balance={balance}
        freeCheck={freeCheck}
        onOpenReport={(id) => { setTaskId(id); window.location.hash = "report"; }}
      />

      <StickyStart />

      <SiteFooter />
    </main>
  );
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("Application root is missing.");
}

createRoot(root).render(<App />);
