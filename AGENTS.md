# shopify-check contributor instructions

This public repository is the single source of truth for the application. Read README.md for setup, source boundaries and release steps. Never copy private operating records, credentials, production resource IDs, customer reports or private Git history into it.

Preserve evidence boundaries: product-data checks are deterministic; AI shopping runs are controlled API observations. Missing/blocked/failed evidence is not proof of product absence. Keep product identity out of the natural shopping conversation until it appears naturally. Preserve terminal reports and uncertain-call recovery behavior.

Operators choose their own model/provider configuration. Do not hard-code a preferred production model or require OpenRouter. Keep provider credentials server-side and never log credential values. Configuration must be request-scoped, not mutable global state shared across customers.

The hosted and self-hosted applications share the same collector, workflow and report logic. Implement shared fixes once. Keep deployment-specific data outside source control. Run npm run check and npm run dry-run; visually verify UI changes at desktop/mobile widths and by keyboard. Review staged files and run npm run privacy:check before any public push.

Publish only reviewed source and synthetic fixtures. Do not add production secrets to CI. Never use a contributor PR workflow to expose deployment credentials. Contributions use Apache-2.0; use a noreply Git identity for public commits.
