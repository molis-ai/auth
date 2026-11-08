# Auth GitHub staging

GitHub OAuth App #4002147 is owned by `molis-ai`. Its callback is
`https://auth-staging.molis.ai/api/v2/auth/external/github/callback`.
The Auth Worker uses `TEST` with `LIVE` providers and `MOCK` delivery.
`wrangler.json` binds the custom domain and the dedicated staging D1.
`seed.sql` records the Club, Work web and Work desktop client registrations.
Apply it once after migrations when provisioning an empty staging D1.

The 2026-11-08 browser acceptance used Cloudflare Worker version
`28174880-4cae-438e-bba7-3fc3adba1b5e`. The local WASM built for that upload
has SHA-256 `399b6ac2d852403531a896f45067a8cbb5774594f510adc2c7e3f6850c0fff98`.
GitHub's client ID is public. Set `UNIFIED_GITHUB_CLIENT_SECRET` and
`PROVIDER_STATE_KEY` in the staging Worker's secret store.

After `npm run setup`, build and validate from the repository root.

```sh
npm run build:web
npm --prefix worker run build:rust
node --test worker/rust-tests/github-live.test.ts
(cd worker && ./node_modules/.bin/wrangler deploy --config deploy/staging/wrangler.json --dry-run)
```

The adapter tests exercise the real Worker WASM against ephemeral D1 with
fixture responses for GitHub. They cover PKCE, issuer and browser binding,
shared identity across products, binding, replacement and reauthentication.
