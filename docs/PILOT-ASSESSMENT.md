# Reference application pilot assessment

Assessed 2026-09-14 from repository source. **No pilot is selected or authorized to start.** Neither application has been migrated or verified live on 1976 Platform. This document is reference material for future migration work and acceptance gates; a compatible SDK method alone does not establish application readiness.

## Reproducible inventory

| Source snapshot | Entity schema files | Function entry files | Workflow definitions | Agent definitions |
| --- | ---: | ---: | ---: | ---: |
| [SocialCloud](https://github.com/sdavignon/socialcloud/tree/9c962d3011d90c7bea346fe5c2ebb7f037d7d772) | 19 | 40 | 2 | 0 |
| [MailWorthy](https://github.com/sdavignon/mailworthy/tree/c1e5ea14d80258100dc86a68d501a70747c4074e) | 29 | 52 | 3 | 2 |

Counts cover files under `base44/entities`, `base44/functions/**/entry.ts`, `base44/workflows`, and `base44/agents`. Function-entry counts are source inventory, not counts of verified deployed endpoints: SocialCloud includes a utility at `base44/functions/utils/logger/entry.ts`. Both repositories mix `Deno.serve(...)` registration and default-export handlers. Port each executable entry and its shared dependencies; do not infer deployment parity from the directory count. Built-in User data and authentication-provider records require separate discovery beyond these schema counts.

### SDK usage requiring pilot coverage

* SocialCloud: no `base44.agents.*`, entity `.subscribe`, or `base44.workflows.*` calls found in the scanned `src` and `base44` trees. Its two workflows are declarative backend invocations, not client workflow SDK calls.
* MailWorthy: 11 `base44.agents.*` call sites across `src/pages/AutomationAdvisor.jsx` and `src/pages/PostcardSafetyReviewer.jsx`. These use five distinct methods: `listConversations`, `getConversation`, `createConversation`, `subscribeToConversation`, and `addMessage`. The safety-review page has two `addMessage` call sites. Conversation updates carry a complete `messages` collection; image review supplies `file_urls`.
* MailWorthy: one entity subscription at `src/components/RenderedPostcardThumbnails.jsx`, using `entities.PostcardOrder.subscribe` and the returned unsubscribe callback. No `base44.workflows.*` calls found in its scanned application/source trees.
* Exact interface regressions identified during the SDK pilot: SocialCloud `src/components/admin/ErrorLogViewer.jsx` uses `list({sort:{created_date:-1},limit:100})`; MailWorthy `src/pages/Register.jsx` uses `auth.resendOtp(email)`. Both call shapes have been exercised against the replacement clients. This does not validate those complete screens or auth-provider delivery.

## SocialCloud migration gates

1. **Brand authorization and identity.** Preserve stable user IDs, verified email correspondence, brand IDs, membership roles and per-member permissions. `base44/shared/publishingAccess.js` distinguishes brand access, inviting members, and publishing. Its `postTargetAccounts` checks that every account belongs to the selected brand. A generic creator-only policy cannot replace these rules. `base44/entities/Brand.jsonc` also references `created_by_id`, `owner_email`, and administrator access; its nullable read rule needs an explicit migration decision rather than guessed semantics.
2. **Provider connections and runtime.** Port OAuth initiation/callback, account refresh and Google Drive operations, including provider tokens, callback URLs, required secrets and request context. Evidence includes `base44/functions/initiateOAuth/entry.ts`, `base44/functions/oauthCallback/entry.ts`, `base44/functions/refreshAccount/entry.ts`, and `base44/functions/listDriveFiles/entry.ts`. Changing the SDK import does not transfer these integrations or their grants.
3. **Publishing and schedules.** `base44/workflows/Publish Scheduled Posts.jsonc` invokes `publishScheduledPosts` at an anchored one-hour interval in UTC. `Daily Profile Image Refresh.jsonc` invokes `refreshProfileImages` at `0 11 * * *` UTC. Preserve interval anchoring and ensure only one scheduler owns each due post during cutover. Validate retries, account matching, approval state and durable provider receipt before enabling real publication.
4. **Media and data.** Reconcile entity IDs, relational references, authorship metadata, existing media URLs and private/public access. Cached images and uploaded assets require migration evidence; an R2 adapter does not copy existing objects. Measure query behavior and pagination with realistic brand data before selecting production indexes and limits.

## MailWorthy migration gates

1. **Identity, ownership and protected mutations.** `base44/entities/PostcardOrder.jsonc` grants reads by `user_id`, `created_by_id`, or administrator role, while writes are administrator-only at the entity layer. `base44/functions/createLobPostcard/entry.ts` additionally checks the caller against the order before trusted fulfillment. Preserve those distinctions and built-in User billing/profile fields. Exercise registration, OTP, password reset, OAuth return routes and session survival after reload against the selected identity provider.
2. **Money and physical fulfillment.** Preserve Stripe customer/session/payment IDs, credit history, order identity and Lob identifiers. `base44/functions/stripeWebhook/entry.ts`, `base44/functions/lobWebhook/entry.ts` and `base44/shared/paymentSecurity.ts` depend on raw-body signature verification and event tracking. `base44/shared/fulfillment.ts` and payment/credit functions need concurrency and replay testing. Do not activate both old and new consumers simultaneously without a verified deduplication design. A successful callback response is not evidence of exactly-once crediting, charging, mailing or delivery.
3. **Email.** Port the shared-email entities, suppression checks, recipient authorization, HTML treatment, rate limits, routing signatures, inbound parsing and status reconciliation. Source anchors: `base44/shared/sharedEmailSend.ts`, `sharedEmailTransport.ts`, `sharedEmailRouter.js`, `sharedEmailWebhook.js`, and the `base44/functions/shared-email-*` entries. Verify raw-body and multipart handling with the actual provider interface. Preserve conversation IDs, provider message IDs and delivery state. The community [Base44 Shared Email repository](https://github.com/sdavignon/base44-shared-email) is a useful companion; installing the package does not migrate provider routes or prove delivery.
4. **Agents.** `base44/agents/automation_rule_advisor.jsonc` allows AutomationRule read/create/update and read access to Recipient and SocialConnection. Its instructions require explicit confirmation before rule mutation or activation. `postcard_safety_reviewer.jsonc` invokes `moderatePostcard` and disallows anonymous access. Preserve tool permissions, per-user conversation visibility, image attachment handling and memory boundaries. Model output is not authorization to mail or weaken a moderation decision.
5. **Realtime.** Validate the thumbnail subscription event shape and agent conversation updates against the actual components. Test authorization on initial connection and reconnect, unsubscribe cleanup, missed-event recovery and changes made by background workers. A local event stream without verified cross-process propagation cannot establish production completeness.
6. **Schedules.** `Automatic Postcard Mailings.jsonc` invokes `runScheduledAutomations` every five minutes in America/Denver; `Daily Lob Delivery Refresh.jsonc` invokes `refreshLobStatuses` at 06:00 in that zone. `shared-email-status-poll.jsonc` runs at minute 15 hourly in America/Denver and chains `shared-email-poll-status` followed by `shared-email-reconcile`. Preserve timezone/DST behavior and ordered steps. Keep mailing schedules disabled until spending caps, consent and duplicate prevention pass acceptance.

## Staged acceptance cases

All cases below are **not run against migrated applications**. Use synthetic staging data and sandbox providers first. Provider credentials, customer data and internal access details do not belong in public test artifacts.

| Stage | Case | Required evidence |
| --- | --- | --- |
| 1: inventory | Export/import all declared entities plus User data and referenced objects | Per-entity counts, stable IDs, relationship checks, authorship preservation, missing-object report; failed import leaves a recoverable state |
| 1: policy | Anonymous, owner, unrelated user, member/editor and administrator matrix | Allowed reads and writes match reviewed rules; cross-brand/order/conversation access denied; no service capability accepted from a client |
| 1: runtime | Port each actual function entry and shared dependency | Build/load results and request/response contract tests; explicit handling for raw webhook bodies and provider callbacks |
| 2: identity | Email/OTP, password reset, OAuth, logout and reload | Verified identity continuity and persistent session behavior; old identifiers map correctly without merging unrelated users |
| 2: SocialCloud | Draft, edit, approve and simulate scheduled publishing | Exact brand/account/media/copy remain associated; unauthorized editor and cross-brand target denied; retries do not create duplicate provider submissions |
| 2: MailWorthy | Preview, checkout, credit redemption and simulated fulfillment | Order identity and approved proof preserved; duplicate/reordered signed events do not duplicate credit or mailing; unsigned/stale callbacks rejected |
| 2: email | Draft/reply, unauthorized recipients, suppression, inbound and event replay | Sanitized rendering and recipient enforcement; stable threading; replay-safe status updates; provider acceptance distinguished from delivery |
| 2: agents | Open/reopen conversation, attach image, request rule change, disconnect/reconnect | Correct message snapshots and owner isolation; confirmation before authorized mutation; moderation tool behavior and unsubscribe verified |
| 2: realtime | Background thumbnail update and reconnect | UI updates without reload; unrelated orders never appear; missed-event recovery and multi-process delivery demonstrated |
| 3: schedules | Due jobs, two workers, interrupted step, retry and DST boundary | Single effective side effect; durable execution record; ordered email steps; old scheduler demonstrably disabled before new one takes ownership |
| 3: infrastructure | MySQL backup/restore, R2 public/private media, staging DNS and HTTPS | Restored consistency, private-object denial, signed URL expiry, asset availability, hostname/certificate checks and tested rollback |
| 4: controlled pilot | Approved narrow live cohort with rollback window | Versioned deployment, reconciled delta data and signed-off acceptance; separately recorded provider/public-result evidence for any authorized live action |

If a pilot is requested later, the source assessment favors a read-only SocialCloud brand/media scope with synthetic data because it has fewer commercial side effects and no agent definitions. MailWorthy requires separate payment, fulfillment, email and agent gates before any live cutover. This is future planning only; no pilot is selected or started.
