import { z } from "zod";
import { CREDIT_PACKS, PRICING_VERSION } from "@mclab/domain";

const PaddleListResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) }).passthrough()),
  meta: z.object({ request_id: z.string().min(1) }).passthrough(),
});

const PaddleProductSchema = z.object({
  id: z.string().regex(/^pro_[a-z\d]{26}$/),
  name: z.string(),
  description: z.string().nullable(),
  tax_category: z.string(),
  status: z.string(),
  custom_data: z.record(z.string(), z.unknown()).nullable(),
});

const PaddlePriceSchema = z.object({
  id: z.string().regex(/^pri_[a-z\d]{26}$/),
  product_id: z.string().regex(/^pro_[a-z\d]{26}$/),
  name: z.string().nullable(),
  description: z.string(),
  billing_cycle: z.unknown().nullable(),
  unit_price: z.object({
    amount: z.string().regex(/^\d+$/),
    currency_code: z.string(),
  }),
  status: z.string(),
  custom_data: z.record(z.string(), z.unknown()).nullable(),
});

const PaddleProductListSchema = z.object({
  data: z.array(PaddleProductSchema),
  meta: z.object({ request_id: z.string().min(1) }).passthrough(),
});

const PaddlePriceListSchema = z.object({
  data: z.array(PaddlePriceSchema),
  meta: z.object({ request_id: z.string().min(1) }).passthrough(),
});

const PaddleProductResponseSchema = z.object({
  data: PaddleProductSchema,
  meta: z.object({ request_id: z.string().min(1) }).passthrough(),
});

const PaddlePriceResponseSchema = z.object({
  data: PaddlePriceSchema,
  meta: z.object({ request_id: z.string().min(1) }).passthrough(),
});

const PaddleCustomerResponseSchema = z.object({
  data: z.object({
    id: z.string().regex(/^ctm_[a-z\d]{26}$/),
    email: z.email(),
  }).passthrough(),
  meta: z.object({ request_id: z.string().min(1) }).passthrough(),
});

const MAX_PADDLE_RESPONSE_BYTES = 256_000;
const PADDLE_LIVE_API = "https://api.paddle.com";

type PaddleCatalogEntry = {
  key: string;
  product_id: string;
  price_id: string;
  name: string;
  amount: string;
  currency_code: string;
  credits: number;
  completed_tasks: number;
  product_created: boolean;
  product_updated: boolean;
  price_created: boolean;
  price_updated: boolean;
};

const PaddlePriceIdSchema = z.string().regex(/^pri_[a-z\d]{26}$/);

async function paddleRequest(env: Env, path: string, init: RequestInit = {}): Promise<unknown> {
  const { apiBase, label } = paddleEnvironment(env);
  if (!env.PADDLE_API_KEY) throw new Error("PADDLE_API_KEY is unavailable.");

  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.PADDLE_API_KEY}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  const declaredLength = Number(response.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PADDLE_RESPONSE_BYTES) {
    throw new Error("Paddle response exceeded the configured bound.");
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_PADDLE_RESPONSE_BYTES) {
    throw new Error("Paddle response exceeded the configured bound.");
  }
  if (!response.ok) {
    let detail = "";
    try {
      const parsed = JSON.parse(body) as { error?: { code?: string; detail?: string } };
      detail = [parsed.error?.code, parsed.error?.detail].filter(Boolean).join(": ");
    } catch {
      // Paddle returned a non-JSON error; do not echo its body.
    }
    throw new Error(`Paddle ${label} returned HTTP ${response.status}${detail ? ` (${detail})` : ""}.`);
  }
  return JSON.parse(body);
}

export async function readPaddleCustomerEmail(customerId: string, env: Env): Promise<string> {
  const payload = PaddleCustomerResponseSchema.parse(
    await paddleRequest(env, `/customers/${encodeURIComponent(customerId)}`),
  );
  if (payload.data.id !== customerId) throw new Error("Paddle customer response did not match.");
  return payload.data.email.trim().toLowerCase();
}

export async function readPaddleCatalogStatus(env: Env): Promise<Record<string, unknown>> {
  const { label } = paddleEnvironment(env);
  const payload = PaddleListResponseSchema.parse(await paddleRequest(env, "/products?per_page=1"));
  const expectedTokenPrefix = label === "sandbox" ? "test_" : "live_";

  return {
    environment: label,
    api_reachable: true,
    api_key_valid: true,
    product_read_scope_valid: true,
    existing_product_sample_count: payload.data.length,
    paddle_request_id: payload.meta.request_id,
    webhook_secret_configured: Boolean(env.PADDLE_WEBHOOK_SECRET),
    client_token_configured: Boolean(env.PADDLE_CLIENT_TOKEN),
    client_token_format_valid: env.PADDLE_CLIENT_TOKEN?.startsWith(expectedTokenPrefix) ?? false,
  };
}

export async function syncPaddleCatalog(env: Env): Promise<Record<string, unknown>> {
  const { label } = paddleEnvironment(env);
  const productPayload = PaddleProductListSchema.parse(
    await paddleRequest(env, "/products?status=active&per_page=200"),
  );
  const entries: PaddleCatalogEntry[] = [];

  for (const pack of CREDIT_PACKS) {
    const matchingProducts = productPayload.data.filter(
      (product) => product.custom_data?.mclab_catalog_key === pack.key,
    );
    if (matchingProducts.length > 1) {
      throw new Error(`Multiple active Paddle products use catalog key ${pack.key}.`);
    }

    let product = matchingProducts[0];
    let productCreated = false;
    let productUpdated = false;
    if (product) {
      if (!productMatches(product, pack)) {
        const updated = PaddleProductResponseSchema.parse(
          await paddleRequest(env, `/products/${encodeURIComponent(product.id)}`, {
            method: "PATCH",
            body: JSON.stringify({
              name: pack.productName,
              description: pack.description,
              custom_data: catalogCustomData(pack),
            }),
          }),
        );
        product = updated.data;
        productUpdated = true;
      }
    } else {
      const created = PaddleProductResponseSchema.parse(
        await paddleRequest(env, "/products", {
          method: "POST",
          body: JSON.stringify({
            name: pack.productName,
            description: pack.description,
            tax_category: pack.taxCategory,
            custom_data: catalogCustomData(pack),
          }),
        }),
      );
      product = created.data;
      productCreated = true;
    }

    const pricesPayload = PaddlePriceListSchema.parse(
      await paddleRequest(
        env,
        `/prices?status=active&product_id=${encodeURIComponent(product.id)}&per_page=200`,
      ),
    );
    const matchingPrices = pricesPayload.data.filter(
      (price) => price.custom_data?.mclab_catalog_key === pack.key,
    );
    if (matchingPrices.length > 1) {
      throw new Error(`Multiple active Paddle prices use catalog key ${pack.key}.`);
    }

    let price = matchingPrices[0];
    let priceCreated = false;
    let priceUpdated = false;
    if (price) {
      if (!priceMatches(price, product.id, pack)) {
        const updated = PaddlePriceResponseSchema.parse(
          await paddleRequest(env, `/prices/${encodeURIComponent(price.id)}`, {
            method: "PATCH",
            body: JSON.stringify({
              name: `${pack.creditGrant} Credits`,
              description: `${pack.productName} — one-time purchase`,
              unit_price: {
                amount: pack.amount,
                currency_code: pack.currencyCode,
              },
              custom_data: catalogCustomData(pack),
            }),
          }),
        );
        price = updated.data;
        priceUpdated = true;
      }
    } else {
      const created = PaddlePriceResponseSchema.parse(
        await paddleRequest(env, "/prices", {
          method: "POST",
          body: JSON.stringify({
            product_id: product.id,
            name: `${pack.creditGrant} Credits`,
            description: `${pack.productName} — one-time purchase`,
            billing_cycle: null,
            trial_period: null,
            unit_price: {
              amount: pack.amount,
              currency_code: pack.currencyCode,
            },
            quantity: { minimum: 1, maximum: 1 },
            custom_data: catalogCustomData(pack),
          }),
        }),
      );
      price = created.data;
      priceCreated = true;
    }

    entries.push({
      key: pack.key,
      product_id: product.id,
      price_id: price.id,
      name: product.name,
      amount: price.unit_price.amount,
      currency_code: price.unit_price.currency_code,
      credits: pack.creditGrant,
      completed_tasks: pack.completedTasks,
      product_created: productCreated,
      product_updated: productUpdated,
      price_created: priceCreated,
      price_updated: priceUpdated,
    });
  }

  return {
    environment: label,
    pricing_version: PRICING_VERSION,
    entries,
  };
}

function paddleEnvironment(env: Env): { apiBase: string; label: "sandbox" | "live" } {
  if ((env.ENVIRONMENT as string) === "production") return { apiBase: PADDLE_LIVE_API, label: "live" };
  throw new Error("Paddle catalog access is unavailable in this environment.");
}

export function readPaddleCheckoutConfig(env: Env): Record<string, unknown> | null {
  const environment = (env.ENVIRONMENT as string) === "production" ? "production" : null;
  if (!environment || !env.PADDLE_CLIENT_TOKEN) return null;
  if (String(env.PADDLE_CHECKOUT_ENABLED) !== "true") return null;

  const expectedTokenPrefix = "live_";
  if (!env.PADDLE_CLIENT_TOKEN.startsWith(expectedTokenPrefix)) return null;

  const priceIds = {
    starter: env.PADDLE_PRICE_ID_STARTER,
    builder: env.PADDLE_PRICE_ID_BUILDER,
    studio: env.PADDLE_PRICE_ID_STUDIO,
  };
  const parsedPriceIds = z.object({
    starter: PaddlePriceIdSchema,
    builder: PaddlePriceIdSchema,
    studio: PaddlePriceIdSchema,
  }).safeParse(priceIds);
  if (!parsedPriceIds.success) return null;

  return {
    environment,
    pricing_version: PRICING_VERSION,
    client_token: env.PADDLE_CLIENT_TOKEN,
    price_ids: parsedPriceIds.data,
  };
}

function catalogCustomData(pack: (typeof CREDIT_PACKS)[number]) {
  return {
    mclab_catalog_key: pack.key,
    pricing_version: PRICING_VERSION,
    diagnostics_included: pack.completedTasks,
    credit_grant: pack.creditGrant,
    billing_type: "one_time",
  };
}

function productMatches(
  product: z.infer<typeof PaddleProductSchema>,
  pack: (typeof CREDIT_PACKS)[number],
) {
  return (
    product.name !== pack.productName ||
    product.description !== pack.description ||
    product.tax_category !== pack.taxCategory ||
    product.custom_data?.pricing_version !== PRICING_VERSION ||
    product.custom_data?.diagnostics_included !== pack.completedTasks ||
    product.custom_data?.credit_grant !== pack.creditGrant ||
    product.custom_data?.billing_type !== "one_time"
  ) === false;
}

function priceMatches(
  price: z.infer<typeof PaddlePriceSchema>,
  productId: string,
  pack: (typeof CREDIT_PACKS)[number],
) {
  return (
    price.product_id !== productId ||
    price.name !== `${pack.creditGrant} Credits` ||
    price.description !== `${pack.productName} — one-time purchase` ||
    price.billing_cycle !== null ||
    price.unit_price.amount !== pack.amount ||
    price.unit_price.currency_code !== pack.currencyCode ||
    price.custom_data?.pricing_version !== PRICING_VERSION ||
    price.custom_data?.diagnostics_included !== pack.completedTasks ||
    price.custom_data?.credit_grant !== pack.creditGrant ||
    price.custom_data?.billing_type !== "one_time"
  ) === false;
}
