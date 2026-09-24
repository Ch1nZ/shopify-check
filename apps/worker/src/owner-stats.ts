import { configuredOwnerExclusions } from "@mclab/openrouter-adapter";
import { normalizeAccountEmail } from "./free-check";

type OwnerEnv = Env & { OWNER_STATS_TOKEN?: string };

export function ownerStatsBlockedEmails(): string[] {
  return [...new Set(
    configuredOwnerExclusions().split(",")
      .map((email) => normalizeAccountEmail(email))
      .filter((email): email is string => Boolean(email)),
  )];
}

export function isOwnerStatsBlockedEmail(email: string | null | undefined): boolean {
  const normalized = normalizeAccountEmail(email);
  return Boolean(normalized && ownerStatsBlockedEmails().includes(normalized));
}

export type OwnerProductAttemptInput = {
  accountId: string;
  jobId?: string | null;
  source: "preview" | "diagnostic";
  billingKind: "none" | "free_check" | "paid";
  productUrl: string;
};

export type OwnerStatsBoard = {
  generated_at: string;
  counts: {
    self_check_views: number;
    main_site_views: number;
    self_check_cta: number;
    unique_self_check_journeys: number;
    unique_main_journeys: number;
    preview_started: number;
    preview_completed: number;
    preview_recheck_completed: number;
    preview_share_copied: number;
    preview_products: number;
    checkout_started: number;
    checkout_completed: number;
    diagnostic_started: number;
    diagnostic_completed: number;
    human_service_cta: number;
    diagnostics_admitted: number;
    free_check_diagnostics: number;
    paid_diagnostics: number;
    signup_customers: number;
    email_connected_accounts: number;
    purchases: number;
    recorded_shops: number;
  };
  signup_customers: Array<{
    signed_up_at: string;
    email: string;
    account_id: string;
  }>;
  products: Array<{
    attempted_at: string;
    shop_domain: string;
    product_url: string;
    source: "preview" | "diagnostic";
    billing_kind: "none" | "free_check" | "paid";
    email: string | null;
    job_id: string | null;
  }>;
};

const EVENT_COUNTS = {
  main_site_view: 0,
  self_check_cta: 0,
  self_check_view: 0,
  preview_started: 0,
  preview_completed: 0,
  preview_recheck_completed: 0,
  preview_share_copied: 0,
  checkout_started: 0,
  checkout_completed: 0,
  diagnostic_started: 0,
  diagnostic_completed: 0,
  human_service_cta: 0,
} as const;

export function ownerStatsToken(env: Env): string | null {
  const token = (env as OwnerEnv).OWNER_STATS_TOKEN?.trim() ?? "";
  return token.length > 0 ? token : null;
}

export async function ownerStatsAuthorized(
  request: Request,
  env: Env,
  suppliedToken?: string | null,
): Promise<boolean> {
  const expected = ownerStatsToken(env);
  if (!expected) return false;
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;
  return timingSafeEqual(suppliedToken ?? bearer, expected);
}

export function shopDomainFromProductUrl(productUrl: string): string | null {
  try {
    const hostname = new URL(productUrl).hostname.trim().toLowerCase();
    return hostname || null;
  } catch {
    return null;
  }
}

export async function recordOwnerProductAttempt(
  input: OwnerProductAttemptInput,
  env: Env,
): Promise<void> {
  if (env.SELF_HOSTED === "true") return;
  const shopDomain = shopDomainFromProductUrl(input.productUrl);
  if (!shopDomain) return;
  await env.DB.prepare(
    `INSERT INTO owner_product_attempts (
      id, account_id, job_id, source, billing_kind, product_url, shop_domain, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    input.accountId,
    input.jobId ?? null,
    input.source,
    input.billingKind,
    input.productUrl,
    shopDomain,
    new Date().toISOString(),
  ).run();
}

export async function readOwnerStatsBoard(env: Env): Promise<OwnerStatsBoard> {
  const blockedEmails = ownerStatsBlockedEmails();
  const emailKeep = blockedAccountEmailSql("accounts.email_normalized", blockedEmails);
  const listedEmailKeep = blockedAccountEmailSql("email_normalized", blockedEmails, false);

  const eventRows = await env.DB.prepare(
    `SELECT event_name, COUNT(*) AS count
     FROM conversion_events
     GROUP BY event_name`,
  ).all<{ event_name: string; count: number }>();
  const events: Record<keyof typeof EVENT_COUNTS, number> = {
    main_site_view: 0,
    self_check_cta: 0,
    self_check_view: 0,
    preview_started: 0,
    preview_completed: 0,
    preview_recheck_completed: 0,
    preview_share_copied: 0,
    checkout_started: 0,
    checkout_completed: 0,
    diagnostic_started: 0,
    diagnostic_completed: 0,
    human_service_cta: 0,
  };
  for (const row of eventRows.results ?? []) {
    if (row.event_name in events) {
      events[row.event_name as keyof typeof events] = Number(row.count ?? 0);
    }
  }

  const [
    selfCheckJourneys,
    mainJourneys,
    previewProducts,
    diagnosticsAdmitted,
    freeCheckDiagnostics,
    signupCount,
    emailAccounts,
    purchases,
    recordedShops,
    signups,
    attempts,
    historical,
  ] = await Promise.all([
    countQuery(env, "SELECT COUNT(DISTINCT journey_hash) AS count FROM conversion_events WHERE site = 'self_check'"),
    countQuery(env, "SELECT COUNT(DISTINCT journey_hash) AS count FROM conversion_events WHERE site = 'main'"),
    countQuery(
      env,
      `SELECT COUNT(*) AS count FROM owner_product_attempts
       LEFT JOIN accounts ON accounts.id = owner_product_attempts.account_id
       WHERE owner_product_attempts.source = 'preview' AND ${emailKeep.sql}`,
      emailKeep.params,
    ),
    countQuery(
      env,
      `SELECT COUNT(*) AS count FROM jobs
       LEFT JOIN accounts ON accounts.id = jobs.account_id
       WHERE jobs.job_kind = 'guided_search_premium' AND ${emailKeep.sql}`,
      emailKeep.params,
    ),
    countQuery(
      env,
      `SELECT COUNT(*) AS count
       FROM free_check_admissions
       JOIN jobs ON jobs.id = free_check_admissions.job_id
       LEFT JOIN accounts ON accounts.id = jobs.account_id
       WHERE jobs.job_kind = 'guided_search_premium' AND ${emailKeep.sql}`,
      emailKeep.params,
    ),
    countQuery(
      env,
      `SELECT COUNT(*) AS count FROM free_check_grants WHERE ${listedEmailKeep.sql}`,
      listedEmailKeep.params,
    ),
    countQuery(
      env,
      `SELECT COUNT(*) AS count FROM accounts
       WHERE email_normalized IS NOT NULL AND status = 'active' AND ${listedEmailKeep.sql}`,
      listedEmailKeep.params,
    ),
    countQuery(
      env,
      `SELECT COUNT(*) AS count FROM purchases
       LEFT JOIN accounts ON accounts.id = purchases.account_id
       WHERE purchases.status = 'completed' AND ${emailKeep.sql}`,
      emailKeep.params,
    ),
    countQuery(
      env,
      `SELECT COUNT(DISTINCT owner_product_attempts.shop_domain) AS count
       FROM owner_product_attempts
       LEFT JOIN accounts ON accounts.id = owner_product_attempts.account_id
       WHERE ${emailKeep.sql}`,
      emailKeep.params,
    ),
    prepare(env,
      `SELECT created_at AS signed_up_at, email_normalized AS email, account_id
       FROM free_check_grants
       WHERE ${listedEmailKeep.sql}
       ORDER BY created_at DESC
       LIMIT 200`,
      listedEmailKeep.params,
    ).all<{ signed_up_at: string; email: string; account_id: string }>(),
    prepare(env,
      `SELECT owner_product_attempts.created_at AS attempted_at,
              owner_product_attempts.shop_domain,
              owner_product_attempts.product_url,
              owner_product_attempts.source,
              owner_product_attempts.billing_kind,
              accounts.email_normalized AS email,
              owner_product_attempts.job_id
       FROM owner_product_attempts
       LEFT JOIN accounts ON accounts.id = owner_product_attempts.account_id
       WHERE ${emailKeep.sql}
       ORDER BY owner_product_attempts.created_at DESC
       LIMIT 200`,
      emailKeep.params,
    ).all<{
      attempted_at: string;
      shop_domain: string;
      product_url: string;
      source: "preview" | "diagnostic";
      billing_kind: "none" | "free_check" | "paid";
      email: string | null;
      job_id: string | null;
    }>(),
    prepare(env,
      `SELECT collection_runs.created_at AS attempted_at,
              collection_runs.final_url AS product_url,
              jobs.id AS job_id,
              accounts.email_normalized AS email,
              CASE WHEN free_check_admissions.job_id IS NOT NULL THEN 'free_check' ELSE 'paid' END AS billing_kind
       FROM collection_runs
       JOIN shopping_sessions ON shopping_sessions.collection_id = collection_runs.id
       JOIN jobs ON jobs.id = shopping_sessions.job_id
       LEFT JOIN free_check_admissions ON free_check_admissions.job_id = jobs.id
       LEFT JOIN accounts ON accounts.id = jobs.account_id
       WHERE jobs.job_kind = 'guided_search_premium'
         AND jobs.id NOT IN (
           SELECT job_id FROM owner_product_attempts WHERE job_id IS NOT NULL
         )
         AND ${emailKeep.sql}
       ORDER BY collection_runs.created_at DESC
       LIMIT 200`,
      emailKeep.params,
    ).all<{
      attempted_at: string;
      product_url: string;
      job_id: string;
      email: string | null;
      billing_kind: "free_check" | "paid";
    }>(),
  ]);

  const products = [
    ...(attempts.results ?? []),
    ...(historical.results ?? []).flatMap((row) => {
      const shopDomain = shopDomainFromProductUrl(row.product_url);
      if (!shopDomain) return [];
      return [{
        attempted_at: row.attempted_at,
        shop_domain: shopDomain,
        product_url: row.product_url,
        source: "diagnostic" as const,
        billing_kind: row.billing_kind,
        email: row.email,
        job_id: row.job_id,
      }];
    }),
  ].sort((left, right) => right.attempted_at.localeCompare(left.attempted_at))
    .filter((row) => !isOwnerStatsBlockedEmail(row.email))
    .slice(0, 200);

  return {
    generated_at: new Date().toISOString(),
    counts: {
      self_check_views: events.self_check_view,
      main_site_views: events.main_site_view,
      self_check_cta: events.self_check_cta,
      unique_self_check_journeys: selfCheckJourneys,
      unique_main_journeys: mainJourneys,
      preview_started: events.preview_started,
      preview_completed: events.preview_completed,
      preview_recheck_completed: events.preview_recheck_completed,
      preview_share_copied: events.preview_share_copied,
      preview_products: previewProducts,
      checkout_started: events.checkout_started,
      checkout_completed: events.checkout_completed,
      diagnostic_started: events.diagnostic_started,
      diagnostic_completed: events.diagnostic_completed,
      human_service_cta: events.human_service_cta,
      diagnostics_admitted: diagnosticsAdmitted,
      free_check_diagnostics: freeCheckDiagnostics,
      paid_diagnostics: Math.max(0, diagnosticsAdmitted - freeCheckDiagnostics),
      signup_customers: signupCount,
      email_connected_accounts: emailAccounts,
      purchases,
      recorded_shops: recordedShops,
    },
    signup_customers: (signups.results ?? []).filter((row) => !isOwnerStatsBlockedEmail(row.email)),
    products,
  };
}

export function renderOwnerStatsPage(board: OwnerStatsBoard | null, options?: {
  error?: string;
}): string {
  const error = options?.error ? `<p class="error">${escapeHtml(options.error)}</p>` : "";
  if (!board) {
    return ownerPage(`
      <h1>Owner stats</h1>
      <p>Private Self-Check board. Not linked from the public site.</p>
      ${error}
      <form method="post" action="/owner/stats">
        <label>Owner token
          <input type="password" name="token" autocomplete="off" required>
        </label>
        <button type="submit">Open board</button>
      </form>
    `);
  }

  const counts = Object.entries(board.counts).map(([key, value]) => (
    `<li><span>${escapeHtml(labelForCount(key))}</span><strong>${escapeHtml(String(value))}</strong></li>`
  )).join("");
  const signups = board.signup_customers.length === 0
    ? `<p class="empty">No verified signup customers yet.</p>`
    : `<table>
        <thead><tr><th>Signed up</th><th>Email</th></tr></thead>
        <tbody>${board.signup_customers.map((row) => `<tr>
          <td>${escapeHtml(row.signed_up_at)}</td>
          <td>${escapeHtml(row.email)}</td>
        </tr>`).join("")}</tbody>
      </table>`;
  const products = board.products.length === 0
    ? `<p class="empty">No trial products recorded yet.</p>`
    : `<table>
        <thead><tr><th>When</th><th>Shop</th><th>Product</th><th>Kind</th><th>Email</th></tr></thead>
        <tbody>${board.products.map((row) => `<tr>
          <td>${escapeHtml(row.attempted_at)}</td>
          <td>${escapeHtml(row.shop_domain)}</td>
          <td><a href="${escapeHtml(row.product_url)}">${escapeHtml(row.product_url)}</a></td>
          <td>${escapeHtml(productKindLabel(row.source, row.billing_kind))}</td>
          <td>${escapeHtml(row.email ?? "")}</td>
        </tr>`).join("")}</tbody>
      </table>`;

  return ownerPage(`
    <h1>Owner stats</h1>
    <p>Self-Check first-party counts. Generated ${escapeHtml(board.generated_at)}.</p>
    ${error}
    <form method="post" action="/owner/stats">
      <p class="hint">Re-enter the token and submit to refresh.</p>
      <label>Owner token
        <input type="password" name="token" autocomplete="off" required>
      </label>
      <button type="submit">Refresh</button>
    </form>
    <section>
      <h2>Counts</h2>
      <ul class="counts">${counts}</ul>
    </section>
    <section>
      <h2>Signup customers</h2>
      <p>Verified emails that received the promotional Self-Check grant. Use later for outreach; this page does not send mail.</p>
      ${signups}
    </section>
    <section>
      <h2>Trial shops and products</h2>
      <p>Successful previews and admitted diagnostics, including shop domain for later contact.</p>
      ${products}
    </section>
    <p class="note">Visit counts are first-party <code>conversion_events</code> only. Browsers with DNT or GPC are omitted. Cloudflare Web Analytics is not included. Test emails are omitted from account-scoped counts and tables.</p>
  `);
}

export function ownerStatsResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

export async function readOwnerStatsFormToken(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) return null;
  const token = (await request.formData()).get("token");
  return typeof token === "string" && token.length <= 4_096 ? token : null;
}

async function countQuery(env: Env, sql: string, params: unknown[] = []): Promise<number> {
  const row = await prepare(env, sql, params).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

function prepare(env: Env, sql: string, params: unknown[] = []): D1PreparedStatement {
  const statement = env.DB.prepare(sql);
  return params.length ? statement.bind(...params) : statement;
}

function blockedAccountEmailSql(
  column: string,
  emails: string[],
  allowNull = true,
): { sql: string; params: string[] } {
  if (emails.length === 0) return { sql: "1 = 1", params: [] };
  const placeholders = emails.map(() => "?").join(", ");
  if (allowNull) {
    return { sql: `(${column} IS NULL OR ${column} NOT IN (${placeholders}))`, params: emails };
  }
  return { sql: `${column} NOT IN (${placeholders})`, params: emails };
}

async function timingSafeEqual(supplied: string | null | undefined, expected: string): Promise<boolean> {
  if (!supplied) return false;
  const encoder = new TextEncoder();
  const [expectedDigest, suppliedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);
  const expectedBytes = new Uint8Array(expectedDigest);
  const actualBytes = new Uint8Array(suppliedDigest);
  let difference = expectedBytes.length ^ actualBytes.length;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= expectedBytes[index]! ^ actualBytes[index]!;
  }
  return difference === 0;
}

function ownerPage(body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>Owner stats · MC Lab</title>
    <style>
      :root { color: #0f0f0f; background: #fff; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; line-height: 1.5; }
      main { max-width: 1100px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
      h1 { font-size: 1.8rem; letter-spacing: -.03em; margin: 0 0 .5rem; }
      h2 { font-size: 1.15rem; margin: 2rem 0 .6rem; }
      p, label { color: #5f5e5b; }
      form { display: grid; gap: .6rem; max-width: 24rem; margin: 1.25rem 0 2rem; }
      input { padding: .55rem .7rem; border: 1px solid #d9d9d6; border-radius: 8px; }
      button { width: fit-content; padding: .55rem .9rem; border: 0; border-radius: 8px; background: #17231b; color: #d6ff57; font-weight: 650; }
      .counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: .6rem; padding: 0; list-style: none; }
      .counts li { display: flex; justify-content: space-between; gap: 1rem; padding: .7rem .85rem; border: 1px solid #e7e7e5; border-radius: 10px; background: #f7f7f5; }
      .counts span { color: #5f5e5b; font-size: .88rem; }
      table { width: 100%; border-collapse: collapse; overflow-x: auto; display: block; }
      th, td { text-align: left; vertical-align: top; padding: .55rem .5rem; border-bottom: 1px solid #ecece9; font-size: .86rem; }
      a { color: #1a6fc2; overflow-wrap: anywhere; }
      .error { color: #9b2c2c; }
      .empty, .note, .hint { font-size: .9rem; }
      .note { margin-top: 2.5rem; }
      code { font-size: .85em; }
    </style>
  </head>
  <body>
    <main>${body}</main>
  </body>
</html>`;
}

function labelForCount(key: string): string {
  return key.replaceAll("_", " ");
}

function productKindLabel(source: string, billingKind: string): string {
  if (source === "preview") return "preview";
  if (billingKind === "free_check") return "free diagnostic";
  if (billingKind === "paid") return "paid diagnostic";
  return source;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
