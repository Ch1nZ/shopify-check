# Security

Report vulnerabilities privately through this repository's GitHub Security → Report a vulnerability flow. Do not disclose exploit details, credentials or personal data in a public issue.

Never commit `.env`, `.dev.vars`, account tokens, merchant reports or database exports. The deterministic preview requires no provider credentials. AI diagnostics require operator-selected provider credentials and an operator access token, stored outside source control. Keep Cloudflare login credentials in Wrangler's local credential storage, outside this repository.

The supported self-hosting target is Cloudflare Workers. Other runtime integrations must enforce public-only outbound networking and prevent DNS rebinding. Do not bind this collector to private service networks without such controls.
