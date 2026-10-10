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
      ? "1 AI test available"
      : `Account · ${balance?.available_credits ?? 0} credits`)
    : "Sign in";

  return (
    <header className="masthead">
      <a className="skip-link" href="#start">Skip to product check</a>
      <a href="https://geo.mclab.party/" className="brand" aria-label="MC Lab home">
        <span className="brand-mark" aria-hidden="true">M</span>
        <span className="brand-label"><strong>MC Lab</strong><small>AI Shopping Lab</small></span>
      </a>
      <nav className="masthead-nav" aria-label="Primary">
        <a href="#start" className="nav-start">Check product<span className="nav-start-rest"> data</span></a>
        <a className="nav-secondary" href="#how-it-works">How it works</a>
        <a className="nav-secondary" href="#recorded-test">AI shopping test</a>
        <a
          href="#account"
          className={accountAccess?.status === "connected" ? "account-nav is-connected" : "account-nav"}
          aria-label={accountNavLabel}
        >
          {accountAccess?.status === "connected" ? (
            freeCheckRemaining && (balance?.available_credits ?? 0) <= requiredCredits ? (
              <><span className="account-nav-detail">1 AI test available</span><span className="account-nav-compact">Account</span></>
            ) : (
              <><span className="account-nav-detail">Account · {balance?.available_credits ?? 0} credits</span><span className="account-nav-compact">Account</span></>
            )
          ) : "Sign in"}
        </a>
        <a className="nav-secondary" href="#pricing">Pricing</a>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p>MC Lab</p>
      <nav aria-label="Legal">
        <a href="#feedback">Feedback</a>
        <a href="https://github.com/Ch1nZ/shopify-check">Open source · self-host</a>
        <a href="/privacy/">Privacy</a>
        <a href="/terms/">Terms</a>
        <a href="/refund/">Refund</a>
        <a href="https://geo.mclab.party/shopify-geo-audit/">Professional review</a>
      </nav>
    </footer>
  );
}
