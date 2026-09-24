import { useEffect, useState } from "react";

import { previewStartNavLabel } from "@mclab/domain";

import type { AccountAccessState, CreditBalance } from "../types";

export function SiteHeader({
  accountAccess,
  balance,
  freeCheckRemaining,
  requiredCredits,
}: {
  accountAccess: AccountAccessState | null;
  balance: CreditBalance | null;
  freeCheckRemaining: boolean;
  requiredCredits: number;
}) {
  const accountNavLabel = accountAccess?.status === "connected"
    ? (freeCheckRemaining && (balance?.available_credits ?? 0) <= requiredCredits
      ? "1 free Self-Check"
      : `Account · ${balance?.available_credits ?? 0} credits`)
    : "Sign in";

  return (
    <header className="masthead">
      <a href="https://geo.mclab.party/" className="brand" aria-label="MC Lab home">
        <span className="brand-mark" aria-hidden="true">M</span>
        <span className="brand-label"><strong>MC Lab</strong><small>AI Shopping Lab</small></span>
      </a>
      <nav className="masthead-nav" aria-label="Primary">
        <a href="#start" className="nav-start">Free<span className="nav-start-rest"> product</span> check</a>
        <a className="nav-secondary" href="#how-it-works">How it works</a>
        <a className="nav-secondary" href="#recorded-test">AI shopping test</a>
        <a
          href="#account"
          className={accountAccess?.status === "connected" ? "account-nav is-connected" : "account-nav"}
          aria-label={accountNavLabel}
        >
          {accountAccess?.status === "connected" ? (
            freeCheckRemaining && (balance?.available_credits ?? 0) <= requiredCredits ? (
              <>1 free Self-Check</>
            ) : (
              <>Account · {balance?.available_credits ?? 0}<span className="account-nav-unit"> credits</span></>
            )
          ) : "Sign in"}
        </a>
        <a className="nav-secondary" href="https://geo.mclab.party/shopify-geo-audit/">Professional review</a>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p>MC Lab</p>
      <nav aria-label="Legal">
        <a href="https://github.com/Ch1nZ/shopify-check">Open source · self-host</a>
        <a href="/privacy/">Privacy</a>
        <a href="/terms/">Terms</a>
        <a href="/refund/">Refund</a>
        <a href="https://geo.mclab.party/shopify-geo-audit/">Professional review</a>
      </nav>
    </footer>
  );
}

export function StickyStart() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const start = document.getElementById("start");
    if (!start || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(!entry?.isIntersecting),
      { rootMargin: "-90px 0px 0px 0px" },
    );
    observer.observe(start);
    return () => observer.disconnect();
  }, []);
  if (!visible) return null;
  return (
    <a className="sticky-start" href="#start">
      {previewStartNavLabel()}
    </a>
  );
}
