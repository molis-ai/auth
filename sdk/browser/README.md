# V2 browser client

AccountClient calls only the current product's same-origin `/api/account` Host/BFF endpoints. It uses HttpOnly session cookies and a CSRF header; no central access/refresh token, PKCE verifier or verification proof is exposed or persisted by this client.

`session()` reads AccountView. `request(path, body?, method?, idempotencyKey?)` invokes a declared product endpoint. Writes are not automatically retried. `logout(all?)` fences outstanding responses and requests current-login or global revocation. `close()` invalidates pending UI work.

V1 AuthClient, browser token installation and hosted-login redirects are removed. The SDK contains no V1 fallback. The Host/BFF must implement the pinned unified-account product contract and validate all authority on the server.
