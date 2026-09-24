# shopify-check

**Check your Shopify product data. Test the AI shopping conversation. Keep the evidence.**

An open-source application by MC Lab, with a free product-data checker and a full, self-hosted AI shopping diagnostic. Choose your own providers and models. No MC Lab account, purchase or OpenRouter subscription is required to self-host.

[Try MC Lab’s free hosted check](https://check.geo.mclab.party/) · [Self-host](#quick-start) · [Configure models](#your-providers-and-models) · [Professional diagnosis](https://geo.mclab.party/)

## What you get

| Product-data check — no AI calls | Recorded AI diagnostic — your provider costs |
| --- | --- |
| Product facts and structured data | Product research and structured buyer understanding |
| Variant-level price, availability and SKU checks | Natural, unbranded buyer questions and independent question audit |
| Crawler rules, images and identifiers | A controlled, adaptive shopping conversation with search |
| Missing, conflicting and unavailable evidence | Separate direct-product retrieval control |
| Explained fixes and consecutive rechecks | Candidate-set observations, sources, transcript and a terminal report |

Reports distinguish an observed result from a possible cause. Interrupted runs retain available evidence and are marked inconclusive. Provider responses are journaled privately before interpretation; uncertain requests are not blindly replayed. A completed negative observation is a valid result.

**This is not a universal AI visibility score or a consumer ChatGPT/Gemini ranking.** Readable product data does not guarantee recommendations, rankings, traffic or sales. Results depend on the configured models, search providers, buyer context and time of testing.

## Quick start

Requires **Node.js 22+**, npm and internet access. Uses Cloudflare Workers local emulation with local D1, R2 and Queues.

```sh
git clone https://github.com/Ch1nZ/shopify-check.git
cd shopify-check
npm ci
npm run setup
npm run db:migrate
npm run dev
```

Open `http://localhost:8787` (or the address printed by Wrangler). Product-data checks work without AI configuration. `npm run setup` creates ignored local configuration files and a random operator access token; it does not print credentials or create cloud resources.

To run AI diagnostics, follow the next section. Open the application, enter your operator token from `apps/worker/.dev.vars`, supply a product URL and target market, and start a diagnostic. The operator token is separate from your provider API keys. Provider keys remain server-side.

Reports are stored in your deployment. Signing in with the same operator token on another browser restores access to its shared operator account and saved reports. This is a single-operator application; do not share that token with people who should not access all of its reports.

## Your providers and models

**There are no automatic model selections.** Edit the ignored `models.local.json` created by setup. The sample provider names are illustrative; choose the provider and exact model ID for each route:

| Route | Used for | Requirement |
| --- | --- | --- |
| `observer` | Product research, separate direct lookup, shopping answers | Native web search |
| `planner` | Adaptive planning, question audit, result classification | Structured output |
| `synthesizer` | Product understanding and buyer-brief synthesis | Structured output |

All three may use one provider, or different providers and models. Add their API keys to the matching `key_env` names in `apps/worker/.dev.vars`, then run:

```sh
npm run configure
npm run dev
```

`configure` copies the model configuration into the ignored local variables file. Restart the development server after changing it.

Supported adapters:

- **OpenAI:** direct Responses API, including native web search for search roles.
- **Google:** direct generative AI API, including Google Search grounding.
- **Anthropic:** direct Messages API, including native web search.
- **OpenRouter:** optional, including native search and explicit provider ordering.
- **OpenAI-compatible endpoints:** configurable HTTPS `base_url` for structured roles. A generic chat endpoint has no portable native-search contract, so it cannot be the observer in this release. Pair it with a supported search provider.

Each entry accepts `provider`, `model`, `key_env`, `search`, optional `base_url`, optional `provider_order` for OpenRouter, and `provider_options`. Use `provider_options` for your provider's supported reasoning/thinking settings; do not put credentials there. Endpoint URLs must not contain credentials or query parameters. Provider/model capabilities differ: choose models that support the required features. Unsupported combinations fail explicitly rather than silently changing providers or dropping search.

Changing a model changes the experiment. Keep configuration stable while runs are in progress and record it when comparing results. The optional Decisions classifier is disabled in the self-hosting template; standard classification uses your configured planner model.

**Costs:** software is free; hosting, model and search usage may cost money. No MC Lab credits are purchased. The existing reservation ledger is reused internally with an operator-only allowance, not currency or provider credits. Call/turn limits bound the workflow, but reported dollar costs are unknown when a provider does not return billing data. Set provider-side spending limits; the displayed cost is not a guaranteed invoice or hard provider spending cap.

## Deploy to your Cloudflare account

The source contains no MC Lab account IDs, database IDs, production secrets or domains configured as deployment targets. Resource names below are defaults; change them consistently if you host multiple installations. Resource creation and deployment can incur Cloudflare charges.

```sh
npx wrangler login
npm run cloud:config
npx wrangler d1 create shopify-check
npx wrangler r2 bucket create shopify-check-evidence
npx wrangler queues create shopify-check-dead-letter
npx wrangler queues create shopify-check-jobs
```

Put the returned D1 database ID in the ignored `.runtime/wrangler.jsonc`. Set your account ID there if your login has multiple accounts. Keep the R2 bucket private; do not enable a public bucket URL.

Configure cloud secrets using Wrangler's interactive prompts:

```sh
npx wrangler secret put SELF_HOST_ACCESS_TOKEN --config .runtime/wrangler.jsonc
npx wrangler secret put PLANNER_API_KEY --config .runtime/wrangler.jsonc
npx wrangler secret put OBSERVER_API_KEY --config .runtime/wrangler.jsonc
npx wrangler secret put SYNTHESIZER_API_KEY --config .runtime/wrangler.jsonc
```

Use the credential names from your own `key_env` configuration if different. Set a random operator access token of at least 24 characters. Upload model configuration without putting keys into it:

```sh
npx wrangler secret put MODEL_CONFIG --config .runtime/wrangler.jsonc < models.local.json
npm run check
npm run dry-run
npx wrangler d1 migrations apply DB --remote --config .runtime/wrangler.jsonc
npm run deploy
```

Open the Worker URL printed by deployment. You can later add your own domain in your private runtime configuration. For local cron recovery testing, use Wrangler's local scheduled-event endpoint; cloud deployments run the included recovery schedule automatically.

## One source of truth

All application code lives in **this repository**: collection, rules, model adapters, workflow, report logic, web interfaces and optional hosted-service integrations. Fix it here once.

MC Lab's private operating repository references a reviewed release of this repository as a Git submodule. It holds business records and private hosted configuration/assets—not a second application source tree. New public releases are adopted by updating that reference, testing and deploying. Self-hosters independently choose when to update their checkout and apply new migrations.

The default web entry is the self-hosted application. The hosted-service UI remains available as a separate entry for MC Lab's managed deployment. Billing and email integrations are disabled in self-hosted mode; no remote MC Lab service is called except when a user intentionally follows an optional service link.

## Privacy and security

- Provider API keys and the operator token belong in ignored local variables or Cloudflare secrets, never in browser code, Git, issue reports or URLs.
- Product-data checks fetch the submitted public storefront. AI diagnostics send relevant product evidence and prompts to **your configured providers**.
- Diagnostic transcripts, source captures and report history stay in your own D1/R2 resources. They may contain sensitive commercial information. Keep storage private and review exports before sharing.
- The default self-hosted application sends no analytics to MC Lab and disables hosted payment/signup endpoints. A session cookie protects the operator account.
- Public product fetches reject IP literals, local hostnames and authenticated URLs; redirects, fetch duration and body sizes are bounded. The supported server runtime is Cloudflare Workers. Other integrations need public-only network egress, including protection against DNS rebinding.
- [Report security issues privately](SECURITY.md). Use fictional examples in public bug reports.

## Development

```sh
npm run check          # types + regression/integration tests, no real model calls
npm run build
npm run privacy:check  # tracked-file scan; also review changes manually
npm run dry-run
```

| Directory | Responsibility |
| --- | --- |
| `apps/web` | Self-hosted and hosted interfaces, report viewer |
| `apps/worker` | API, operator sessions, durable workflow, evidence storage |
| `packages/source-adapters` | Shopify fetch, normalization and checking rules |
| `packages/model-adapters/openrouter` | Provider adapters and AI roles (directory name retained for compatibility; OpenRouter is optional) |
| `packages/contracts`, `packages/domain` | Versioned data contracts and diagnostic decisions |
| `migrations` | Database schema only, never production data |

Tests use synthetic fixtures and mocked model responses. Adapter contract tests are not a claim that every model offered by each provider has been live-qualified. See [CONTRIBUTING.md](CONTRIBUTING.md) for releases.

## Hosted and professional options

Use [MC Lab's hosted Self-Check](https://check.geo.mclab.party/) for the free preview and optional paid recorded diagnostics without managing infrastructure. Use [professional diagnosis](https://geo.mclab.party/) for deeper investigation and a focused fix-and-retest plan. Both are optional; neither is required to use this project.

## License

[Apache-2.0](LICENSE), copyright MC Lab contributors. The license covers the application code, including its diagnostic workflow. It does not grant MC Lab trademark rights. Shopify is a trademark of Shopify Inc.; this independent project is not affiliated with or endorsed by Shopify.
