# Compatibility

Scope: common application interfaces, not the Base44 hosting/editor platform or its wire protocol. No proprietary SDK implementation was copied.

Reference snapshots inspected on 2026-09-14:

- SocialCloud: `9c962d3011d90c7bea346fe5c2ebb7f037d7d772`
- MailWorthy: `c1e5ea14d80258100dc86a68d501a70747c4074e`

A textual scan found 116 `base44.functions.invoke` and 95 `base44.auth.me` calls across their source and functions. This is a prioritization signal, not a percentage compatibility guarantee; aliases, generated code and dead code affect counts. Both apps use numerous entity CRUD operations and public/private storage integrations.

| Interface | Status in 0.1 | Notes |
|---|---|---|
| `createClient({appId,serverUrl,token})` | Implemented | Explicit new API URL; tokens held in memory |
| `entities.Name.list/filter/get/create/update/delete` | Implemented | Registered entity and policy required |
| `list({sort:{created_date:-1},limit:100})` | Implemented | Single sort field only |
| `bulkCreate` | Implemented | Atomic transaction; max 1000 records |
| `filter(query,sort,limit,skip,fields)` | Implemented subset | Equality, `$eq/$ne/$gt/$gte/$lt/$lte/$in/$nin/$or/$and`; simple top-level fields |
| `auth.me/isAuthenticated/setToken` | Implemented | JWT verifier supplied; optional profile handler |
| `auth.register/loginViaEmailPassword/verifyOtp/resendOtp` | Handler interface | Host must supply identity-provider operations; otherwise 501 |
| `auth.resetPasswordRequest/resetPassword/updateMe/logout` | Handler interface | Host implements validation, revocation and profile persistence |
| `auth.redirectToLogin/loginWithProvider` | Redirect interface | Login UI and provider callback must be supplied |
| `functions.invoke(name,data)` | Implemented | Returns `{data}`; registered authorized handlers |
| `createClientFromRequest(req,options)` | Implemented, adapted | Requires explicit runtime options and is async |
| `asServiceRole.entities/functions/integrations` | Implemented | Trusted server factory only; policy bypass is intentional |
| `Core.UploadFile/UploadPublicFile` | R2 implementation | Returns `{file_url}`; public bucket/domain required |
| `Core.UploadPrivateFile/CreateFileSignedUrl` | R2 implementation | `{file_uri}` / `{signed_url}`; uploader policy by default |
| `Core.InvokeLLM/GenerateImage/SendEmail` | Extension interface | Supply authorized provider handlers; otherwise 501 |
| `analytics.track/appLogs.logUserInApp` | Extension interface | Supply event sink; otherwise 501 |
| Cloudflare DNS CRUD | Implemented extension | Server-only; explicit zone; paginated list envelope |
| Entity subscriptions / agents conversations | Not implemented | Port to a realtime/agent provider before app cutover |
| Connectors / SSO / user invitations | Not implemented | Port integrations explicitly |
| Schema import, Base44 RLS syntax, data export/import | Not implemented | Translate schemas and policies; separate migration tooling |
| Base44 CLI, Deno hosting, schedules, app editor | Not implemented | Use your own runtime and scheduler |

The client accepts `requiresAuth`, `functionsVersion`, and `appBaseUrl` for source configuration compatibility, but these do not configure hosting, versioned functions, or server authorization. Server policies are authoritative. No automatic token persistence or cookie authentication is provided by the JWT helper.

## Behavioral limits

- Default page size 50, maximum 1000, skip maximum 100000. Missing/null fields follow MySQL JSON semantics, not full Mongo semantics. `$ne`/`$nin` do not match missing fields. Regex, nested dotted paths, `$exists`, array membership semantics and arbitrary object matching are not supported.
- Policies run before pagination, but the initial implementation loads matching rows before filtering by authorization. Suitable for small/medium datasets; implement SQL-scoped policies and indexes before large workloads. Do not expose unbounded scans to untrusted traffic without rate limits.
- MySQL stores JSON documents in one namespaced table. No automatic foreign keys, generated column indexes or uniqueness constraints on arbitrary document fields. Entity business invariants belong in application code/database extensions.
- `created_by` uses email when present to match common Base44 patterns. `ownerOnly` assumes your provider guarantees verified, unique, stable email ownership. Prefer a custom immutable-subject policy for production and identity migration.
- Function handlers may return data or a Response. The browser `invoke` helper expects JSON; streaming/binary responses require a separate client.
- The browser SDK has no automatic retries, avoiding accidental duplicate paid side effects. Add explicit idempotency to sending, charging and publishing functions.
- R2 transfers buffer uploads with a 10 MiB default limit. Signed download links expire in 1–3600 seconds. No automatic upload metadata entity or cross-user sharing policy.
- The Node MySQL adapter is not a Cloudflare Worker deployment template. Run on Node with Cloudflare R2/DNS services; Worker/Hyperdrive support is future work.

Official interface references: [Base44 entities](https://docs.base44.com/developers/references/sdk/docs/type-aliases/entities), [Base44 data guide](https://docs.base44.com/developers/references/sdk/getting-started/work-with-data).
