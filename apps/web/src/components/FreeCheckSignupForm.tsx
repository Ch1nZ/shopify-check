import { useRef, useState } from "react";

export function FreeCheckSignupForm({
  id,
  title,
  description,
  compact = false,
  className,
  submitLabel = (pending: boolean) => pending ? "Sending…" : "Email verification link",
}: {
  id?: string;
  title: string;
  description: string;
  compact?: boolean;
  className?: string;
  submitLabel?: (pending: boolean) => string;
}) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inputId = id ? `${id}-email` : "signup-email";

  const input = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  async function requestSignup() {
    if (sending.current || !input.current?.reportValidity()) return;
    sending.current = true;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/v1/account/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const payload = await response.json() as { data?: { message?: string }; error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "The verification email could not be requested right now.");
      setMessage(payload.data?.message ?? "If that email can receive mail, a verification link is on its way.");
      setEmail("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The verification email could not be requested right now.");
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  return (
    <div id={id} className={className ? `free-check-signup ${className}` : "free-check-signup"}>
      <h3>{title}</h3>
      <p>{description}</p>
      {compact ? (
        <details className="signup-expectations-details">
          <summary>Timing, spam folder, expiry, and resend</summary>
          <SignupExpectations />
        </details>
      ) : <SignupExpectations />}
      <label htmlFor={inputId}>Email</label>
      <div className="recovery-row">
        <input
          ref={input}
          disabled={pending}
          id={inputId}
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void requestSignup();
            }
          }}
        />
        <button type="button" disabled={pending || !email} onClick={() => void requestSignup()}>
          {submitLabel(pending)}
        </button>
      </div>
      {message ? <p className="account-message" role="status">{message}</p> : null}
    </div>
  );
}

function SignupExpectations() {
  return (
    <ul className="signup-expectations">
      <li>The email usually arrives within a minute. Check spam or promotions if it does not.</li>
      <li>Each link works once and expires in 15 minutes.</li>
      <li>Request another link if it expired; that replaces any unused previous link.</li>
    </ul>
  );
}
