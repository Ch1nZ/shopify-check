import { useEffect, useRef, useState } from "react";
import { initializePaddle, type Paddle } from "@paddle/paddle-js";

import { CREDIT_PACKS, PRICING_VERSION } from "@mclab/domain";
import { journeyId } from "../analytics";

type PackKey = (typeof CREDIT_PACKS)[number]["key"];

type CheckoutConfig = {
  environment: "sandbox" | "production";
  pricing_version: string;
  client_token: string;
  price_ids: Record<PackKey, string>;
};

type CheckoutIntent = {
  intent_id: string;
  price_id: string;
  custom_data: Record<string, string>;
  customer_email?: string | null;
};

export function PaddleCheckout({ onEvent }: { onEvent?: (name: "checkout_started" | "checkout_completed") => void }) {
  const paddleRef = useRef<Paddle | null>(null);
  const [config, setConfig] = useState<CheckoutConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [openingPack, setOpeningPack] = useState<PackKey | null>(null);
  const [message, setMessage] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("checkout") === "success"
      ? "Checkout completed. Your signed Paddle receipt is being processed."
      : null;
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function setupCheckout() {
      try {
        const response = await fetch("/api/v1/billing/paddle/config", {
          headers: { Accept: "application/json" },
        });
        const payload = await response.json() as {
          data?: CheckoutConfig;
          error?: { message?: string };
        };
        if (!response.ok || !payload.data) {
          throw new Error(payload.error?.message ?? "Checkout configuration is unavailable.");
        }
        const checkoutConfig = validateCheckoutConfig(payload.data);
        const paddle = await initializePaddle({
          environment: checkoutConfig.environment,
          token: checkoutConfig.client_token,
          eventCallback(event) {
            if (!active) return;
            if (event.name === "checkout.completed") {
              onEvent?.("checkout_completed");
              setOpeningPack(null);
              setMessage(`${checkoutConfig.environment === "sandbox" ? "Sandbox payment" : "Payment"} completed. The signed Paddle webhook will be the source of truth for the purchase.`);
            } else if (event.name === "checkout.closed") {
              setOpeningPack(null);
            } else if (event.name === "checkout.error" || event.name === "checkout.failed") {
              setOpeningPack(null);
              console.error(JSON.stringify({
                message: "paddle_checkout_failed",
                event_name: event.name,
                type: event.type,
                code: event.code,
                detail: event.detail,
                documentation_url: event.documentation_url,
              }));
              setError(
                event.code
                  ? `Paddle Checkout error: ${event.code}.`
                  : "Paddle Checkout could not complete this test payment.",
              );
            }
          },
        });
        if (!paddle) throw new Error("Paddle Checkout did not initialize.");
        if (!active) return;
        paddleRef.current = paddle;
        setConfig(checkoutConfig);
      } catch (caught) {
        if (active) {
          setError(caught instanceof Error ? caught.message : "Checkout is unavailable.");
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void setupCheckout();
    return () => {
      active = false;
      paddleRef.current = null;
    };
  }, []);

  async function openCheckout(packKey: PackKey) {
    const paddle = paddleRef.current;
    if (!paddle || !config) {
      setError("Checkout is still loading. Please try again.");
      return;
    }

    setError(null);
    setMessage(null);
    setOpeningPack(packKey);
    onEvent?.("checkout_started");
    try {
      const response = await fetch("/api/v1/billing/paddle/checkout-intents", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ pack_key: packKey }),
      });
      const payload = await response.json() as {
        data?: CheckoutIntent;
        error?: { message?: string };
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "Checkout session could not be created.");
      }
      const intent = payload.data;
      if (
        !/^[0-9a-f-]{36}$/i.test(intent.intent_id) ||
        intent.price_id !== config.price_ids[packKey] ||
        intent.custom_data.mclab_checkout_intent_id !== intent.intent_id ||
        intent.custom_data.mclab_catalog_key !== packKey ||
        intent.custom_data.pricing_version !== config.pricing_version
      ) {
        throw new Error("Checkout session failed validation.");
      }
      paddle.Checkout.open({
        items: [{ priceId: intent.price_id, quantity: 1 }],
        customData: intent.custom_data,
        ...(intent.customer_email ? { customer: { email: intent.customer_email } } : {}),
        settings: {
          displayMode: "overlay",
          variant: "one-page",
          theme: "light",
          successUrl: `${window.location.origin}/?checkout=success&journey=${journeyId}#pricing`,
        },
      });
    } catch (caught) {
      setOpeningPack(null);
      setError(caught instanceof Error ? caught.message : "Checkout could not be opened.");
    }
  }

  return (
    <>
      {config?.environment === "sandbox" ? (
        <p className="sandbox-notice" role="status">
          Sandbox checkout — test payments only. No real charge will be made.
        </p>
      ) : null}
      <div className="pack-grid">
        {CREDIT_PACKS.map((pack) => (
          <article key={pack.key}>
            <p>{pack.key.toUpperCase()}</p>
            <h3>${(Number(pack.amount) / 100).toFixed(0)}</h3>
            <strong>{pack.creditGrant} credits</strong>
            <span className="pack-usage">{pack.completedTasks} tests</span>
            <button
              type="button"
              disabled={loading || !config || openingPack !== null}
              onClick={() => { void openCheckout(pack.key); }}
            >
              {loading
                ? "Loading checkout…"
                : openingPack === pack.key
                  ? "Opening Paddle…"
                  : `Buy ${pack.key[0]!.toUpperCase()}${pack.key.slice(1)}`}
            </button>
          </article>
        ))}
      </div>
      {message ? <p className="checkout-message success" role="status">{message}</p> : null}
      {error ? <p className="checkout-message" role="alert">{error}</p> : null}
    </>
  );
}

function validateCheckoutConfig(config: CheckoutConfig): CheckoutConfig {
  const expectedPrefix = config.environment === "sandbox" ? "test_" : "live_";
  if (
    !config.client_token.startsWith(expectedPrefix) ||
    config.pricing_version !== PRICING_VERSION ||
    !Object.values(config.price_ids).every((priceId) => /^pri_[a-z\d]{26}$/.test(priceId))
  ) {
    throw new Error("Checkout configuration failed validation.");
  }
  return config;
}
