import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import type { AccountAccessState, CreditBalance, FreeCheckState, ReportHistoryItem } from "../types";
import { FreeCheckSignupForm } from "./FreeCheckSignupForm";

export function AccountAccess({
  accountAccess,
  balance,
  freeCheck,
  onOpenReport,
}: {
  accountAccess: AccountAccessState | null;
  balance: CreditBalance | null;
  freeCheck: FreeCheckState;
  onOpenReport: (taskId: string) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [signupAvailable, setSignupAvailable] = useState(false);
  const [history, setHistory] = useState<ReportHistoryItem[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const params = new URLSearchParams(window.location.search);
  const recoveryState = params.get("recovery");
  const signupState = params.get("signup");
  const [message, setMessage] = useState<string | null>(
    recoveryState === "success"
      ? "Access restored. Your credits and reports are now available on this browser."
      : recoveryState === "invalid"
        ? "That access link is invalid or has expired. Request a new one below."
        : signupState === "success"
          ? "Email verified. You can run 1 free Self-Check from this browser."
          : signupState === "invalid"
            ? "That verification link is invalid or has expired. Request a new one below."
            : null,
  );
  const connected = accountAccess?.status === "connected";
  const accessLoading = accountAccess === null;
  const remaining = freeCheck?.remaining === 1;

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetch("/api/v1/account/recovery-config").then((response) => response.json()),
      fetch("/api/v1/account/history").then((response) => response.json()),
    ]).then(([config, reports]: [
      { data?: { enabled?: boolean; free_check?: { signup_available?: boolean } } },
      { data?: { reports?: ReportHistoryItem[] } },
    ]) => {
      if (!active) return;
      setEnabled(Boolean(config.data?.enabled));
      setSignupAvailable(Boolean(config.data?.free_check?.signup_available));
      setHistory(reports.data?.reports ?? []);
      setHistoryLoaded(true);
    }).catch(() => {
      if (active) setHistoryLoaded(true);
    });
    return () => { active = false; };
  }, []);

  async function requestLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/v1/account/recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const payload = await response.json() as { data?: { message?: string } };
      setMessage(payload.data?.message ?? "If that email is linked to a purchase, a secure access link is on its way.");
      setEmail("");
    } catch {
      setMessage("The access email could not be requested right now.");
    } finally {
      setPending(false);
    }
  }

  const connectedSummary = remaining
    ? "1 free Self-Check"
    : freeCheck?.granted && (balance?.available_credits ?? 0) < 30
      ? "0 remaining"
      : `${balance?.available_credits ?? 0} credits`;

  return (
    <section className="account-access macos-window" id="account" aria-labelledby="account-title">
      <div className="macos-window-titlebar" aria-hidden="true">
        <div className="macos-traffic-lights">
          <span className="dot dot-close" />
          <span className="dot dot-minimize" />
          <span className="dot dot-zoom" />
        </div>
        <span className="macos-window-title">Account & Credits</span>
      </div>
      <header>
        <p className="eyebrow">{accessLoading ? "ACCOUNT ACCESS" : connected ? "ACCOUNT CONNECTED" : "PASSWORDLESS ACCESS"}</p>
        <h2 id="account-title">{accessLoading ? "Checking this browser…" : connected ? "Your credits and reports are ready." : "Sign in to your credits and reports."}</h2>
        <p>{accessLoading
          ? "Looking for saved access to your MC Lab account."
          : connected
          ? `This browser has secure access to ${accountAccess.email_hint ?? "your account"}.`
          : "Passwordless. Use the email you verified or the Paddle checkout email. Each link works once and expires in 15 minutes. Credits and reports are not lost if the link expires."}</p>
      </header>
      <div className="account-access-body">
        {accessLoading ? (
          <p className="account-loading" role="status">Checking account access…</p>
        ) : connected ? (
          <div className="connected-account-summary">
            <h3>Account available on this browser</h3>
            <strong>{connectedSummary}</strong>
            <p>{remaining
              ? "Your complimentary Self-Check is ready. A completed result uses it; a technical failure does not."
              : "Credits do not expire. You can return to this browser without requesting another access link."}</p>
          </div>
        ) : (
          <div className="account-access-forms">
            {signupAvailable ? (
              <FreeCheckSignupForm
                title="Need a verification link?"
                description="New here? Verify your email for 1 free Self-Check. Already verified? Use the sign-in form beside this."
              />
            ) : null}
            {enabled ? (
              <form onSubmit={requestLink}>
                <h3>Email me a sign-in link</h3>
                <p>Already have credits or a report? Use the email on that account. If a link was already opened or expired, request a new one.</p>
                <label htmlFor="recovery-email">Account email</label>
                <div className="recovery-row">
                  <input id="recovery-email" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
                  <button type="submit" disabled={pending}>{pending ? "Sending…" : "Email access link"}</button>
                </div>
              </form>
            ) : null}
          </div>
        )}
        <div>
          <h3>{connected ? "Your reports" : "Reports on this browser"}</h3>
          {!historyLoaded ? <p role="status">Loading reports…</p> : history.length ? (
            <ul className="report-history">
              {history.map((item) => (
                <li key={item.task_id}>
                  <button type="button" onClick={() => onOpenReport(item.task_id)}>View report</button>
                  <span>{new Date(item.created_at).toLocaleDateString()} · {historyStatusLabel(item.status)}</span>
                </li>
              ))}
            </ul>
          ) : <p>{connected ? "No diagnostic reports yet." : "No diagnostic reports are linked to this browser yet."}</p>}
        </div>
        {connected && enabled ? (
          <details className="account-switch">
            <summary>Use a different checkout email</summary>
            <form onSubmit={requestLink}>
              <label htmlFor="recovery-email-connected">Checkout email</label>
              <div className="recovery-row">
                <input id="recovery-email-connected" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
                <button type="submit" disabled={pending}>{pending ? "Sending…" : "Email access link"}</button>
              </div>
            </form>
          </details>
        ) : null}
        {message ? <p className="account-message" role="status">{message}</p> : null}
      </div>
    </section>
  );
}

function historyStatusLabel(status: string): string {
  if (["collecting", "queued", "running"].includes(status)) return "generating";
  return status.replaceAll("_", " ");
}
