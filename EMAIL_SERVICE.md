# ShortJob email delivery

ShortJob uses the ScreenSync deployment pattern: the Render API sends an HMAC-signed HTTPS request to `https://short-job-3.vercel.app/api/email`; the Vercel function delivers email through Gmail SMTP. SMTP remains available for local development.

## Configuration

On the **backend**, configure `EMAIL_PROVIDER=gmail-bridge`, `EMAIL_BRIDGE_URL=https://short-job-3.vercel.app/api/email`, and `EMAIL_BRIDGE_SECRET` (at least 32 characters).

On **Vercel**, configure the same `EMAIL_BRIDGE_SECRET`, `SMTP_USER`, `SMTP_PASS` (Gmail app password), and `APP_URL=https://short-job-3.vercel.app`. These are server-only variables; never use the `VITE_` prefix or commit credentials. Deploy the frontend with its `api/email.js` function and filesystem-first routing in `vercel.json`.

For direct SMTP, set `EMAIL_PROVIDER=smtp`, `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, and `EMAIL_PASSWORD`. Port 465 enables TLS automatically; `EMAIL_SECURE` can override it.

## Behavior

- Registration OTP expires in 10 minutes; password-reset OTP expires in 15 minutes; legacy verification links expire in one hour.
- The relay validates the signature, recipient, purpose, token, timestamp (within 60 seconds), name and nonce before contacting Gmail. It only generates ShortJob templates, escapes names and does not accept arbitrary HTML.
- Delivery is awaited. HTTP, timeout, SMTP rejection and configuration failures produce a sanitized HTTP 503 response, rather than a false success.
- OTP values, recipients and SMTP credentials are not logged by the email service.
- Signed requests are time-limited. The nonce contributes unique request signatures; there is no distributed replay store or automatic retry after ambiguous delivery failures.

## Tests

Run `npm test --prefix server` and `npm run test:email --prefix client`. The backend tests can also run independently in the exported `short-job` repository; the relay tests can run independently in `short-job-3`.

The tests cover all three email purposes, signed requests, bad authentication, payload tampering, stale requests, invalid recipients/tokens, HTML escaping, delivery failures, awaiting SMTP, and password-reset HTTP failure handling.

## Verified delivery — 13 October 2026

Nine backend tests and three Vercel relay tests passed. The client production build passed. Registration OTP, password-reset OTP and verification-link test messages were sent through the production ShortJob Vercel relay and confirmed in the configured sender’s Gmail inbox before code was pushed. These synthetic messages were delivery checks, not usable production account credentials.
