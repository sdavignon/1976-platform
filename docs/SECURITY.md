# Security and deployment

All request scope is derived by the server. App ID is fixed in server configuration; role/service fields in JSON or headers cannot elevate callers. JWT verification checks signature, issuer, audience, subject and expiration. Do not use unverified JWT decoding for authentication.

Policies are required per entity and per function/integration. Never publish a generic user-accessible function that simply forwards arbitrary service-role operations. Service access bypasses policies by design. Treat registered handlers as trusted code. Schema validation is supplied by your application; do not register sensitive user/account/credit models without field-level controls.

Authentication lifecycle handlers are trusted integrations: implement rate limiting, verified email, MFA where applicable, secure redirects, reset/OTP expiry, anti-enumeration, logout/session revocation and protected profile fields. The SDK does not implement these policies for you. If using cookie authentication instead of the JWT helper, implement CSRF protection and secure SameSite cookies. Return only public profile fields from `auth.me`.

Use TLS for API and MySQL connections, least-privilege database credentials, backups and restore tests. The example binds to localhost; deploy behind an HTTPS gateway with request/rate/concurrency limits. Avoid leaking raw exceptions, provider secrets or full private URLs into logs. Configure a redacted `onError` handler for diagnostics.

Public and private R2 buckets must be separate. Do not enable public access to the private bucket. Signed URLs are bearer credentials. The built-in integration restricts signing to uploader/app prefixes; shared inbox attachments need an explicit mailbox permission policy. Direct storage methods are trusted server operations.

Cloudflare DNS uses a separate API token scoped to the intended zone. The SDK does not auto-select zones or change MX records. Review DNS mutations in application workflows, particularly email routing.

For vulnerabilities, use GitHub private vulnerability reporting if enabled or contact the maintainer through [1976.cloud](https://1976.cloud). Do not post credentials or exploitable production details in a public issue.
