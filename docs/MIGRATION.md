# Migrating an existing Base44 app

Start on a branch against a staging database. Existing production apps are not migrated by installing this package.

1. Inventory SDK calls and backend functions. Map entity names, defaults, validation, relationship IDs, access rules, schedules, secrets, connectors and files. Include indirect imports under `src/api` and Base44 internal deep imports.
2. Register each entity on the server with an explicit policy and validation. SocialCloud's multi-brand memberships and MailWorthy's recipient/order/credit permissions need their own policies; the example owner policy is insufficient.
3. Create MySQL schema and a separate, reviewed importer. Preserve IDs, dates, ownership, account relationships, credits, orders, provider IDs and audit history. Normal create/bulkCreate rejects server-managed fields intentionally; use a dedicated trusted migration process. Verify counts and samples before switching traffic.
4. Configure an OIDC issuer and map its immutable subject to existing user records. Supply lifecycle handlers for registration, verification, password reset, logout and profile updates. Never assume matching display names or emails establish account continuity. Do not place service credentials in frontend configuration.
5. Replace the import in `src/api/base44Client.js` with `@1976studios/platform` and point `serverUrl` to the new API. Remove Base44-specific internal imports and build plugins as needed. Preserve exported `base44` if that avoids unnecessary app edits.
6. Port each Deno function into a registered handler. Use `context.client` for SDK access. Validate caller authorization **before** using `context.client.asServiceRole`. Configure provider secrets only on the server. Keep payment/mail/publication idempotency and signature checks.
7. Provision separate public/private R2 buckets. Copy authorized media and update records only after verifying new URLs. Preserve private attachment policies. No automatic host deletion or DNS change is performed.
8. Replace unsupported agent/realtime/connector APIs. For example MailWorthy's `PostcardOrder.subscribe` needs a realtime provider or explicitly implemented polling before the component can run.
9. Run end-to-end staging tests: anonymous/owner/other-user/admin access; existing-user login; credits/orders; function envelopes; uploads/private downloads; webhook validation; idempotency; pagination and concurrent updates.
10. Back up, freeze or reconcile writes, compare data, then perform a planned cutover. Keep a rollback route and reconcile any writes before reverting. DNS changes do not migrate application data.

## Porting Shared Email

The [base44-shared-email repository](https://github.com/sdavignon/base44-shared-email) is an independent useful companion, not a direct dependency. Its installer currently expects Base44 files and runtime APIs.

Port SharedEmail entities and their permission rules, then register inbox/send/status/webhook functions. Preserve mailbox-specific view/send authorization, verified sender aliases, private attachment access, provider webhook verification, delivery status, idempotency and audit records. Replace Base44 request-client imports with this server's explicit configuration. Keep senders and recipients constrained by application policy. Test provider acceptance separately from delivery. A raw `SendEmail` handler is not a complete shared inbox.

Do not run the existing installer against this package expecting automatic compatibility.
