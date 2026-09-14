# Schema/data migration and cutover tooling

No pilot is selected. The library provides operator tools and synthetic tests; it has not cut over SocialCloud, MailWorthy, or any production app.

## Schemas and data

```sh
npx 1976-platform schemas --directory ./base44/entities --output ./schema-review.json
```

Reads JSON/JSONC, verifies entity filename/name agreement and preserves schema/RLS text for review. `defineEntities(schemas, policies)` compiles JSON Schema validators and requires an explicit policy for every entity. It never guesses Base44 RLS meanings. Validation uses Ajv with formats; no default insertion, coercion or field removal. Schema changes are validation changes; this JSON document backend does not generate relational columns, indexes or foreign keys.

A bundle has this structure:

```json
{
  "formatVersion": 1,
  "sourceAppId": "source-app",
  "entities": {
    "Task": {
      "schema": {"type":"object","required":["title"]},
      "records": [{"id":"existing-id","title":"Preserved","created_by":"owner@example.com"}]
    }
  }
}
```

Obtain source data through an authorized export. Automatic extraction from Base44 is not included. The platform exporter reads an existing **1976 Platform MySQL** database using a consistent snapshot; it does not log into Base44. Preserve all user/account references and private metadata deliberately. Passwords/provider identity records require separate identity migration. Keep bundles outside Git; `*.migration.json` and `*.receipt.json` are ignored.

```sh
# All database commands require MYSQL_URL and an initialized records table.
npx 1976-platform plan --bundle data.migration.json --app target-app
# Review the digest, counts and conflicts before applying:
npx 1976-platform import --bundle data.migration.json --app target-app --digest REVIEWED_DIGEST --receipt imported.receipt.json
npx 1976-platform verify --bundle data.migration.json --app target-app
# Export platform data, with explicit schemas:
npx 1976-platform export --directory ./base44/entities --app target-app --output backup.migration.json
```

Plan is read-only. Import locks target entity ranges, rechecks the bundle and target digest, and inserts missing records in one transaction. It preserves IDs, timestamps and ownership metadata exactly. Existing identical records are skipped; conflicting IDs cause a refusal with no writes. Plans become stale if target data changes. Imports never silently overwrite or delete. The CLI reserves a new receipt file before starting and prints the receipt after commit; retain stdout if saving the receipt fails. An error before commit can leave an empty reserved receipt file. Verify reports missing, changed and extra records.

The trusted server API also exposes `rollbackMigration(pool, receipt)`. It preflights every inserted row and refuses if any imported row has changed. It removes only unchanged rows inserted by that receipt, preserving preexisting records. Receipts are trusted operator artifacts, not untrusted browser input. **Never expose migration APIs to application users.** Quiesce writers for migration/rollback; this is not change-data-capture or conflict reconciliation. This release reads bundles/selected target entities into memory and applies one transaction, so split and rehearse large datasets with a deliberate plan.

## Cutover control

`assessCutover(plan)` requires fresh evidence for backup restoration, data parity, identity continuity, authorization, media, functions, workflows, agents, webhooks and rollback rehearsal, plus a frozen/reconciled write boundary. It returns blockers and a content digest. References identify the operator's actual tests; the library does not validate arbitrary evidence URLs or infer successful tests from a checked box.

`executeCutover(plan, approvedDigest, operations)` refuses missing/stale/changed evidence, then calls supplied `switchTraffic` and `verifyTarget` operations. If either fails, it calls `restoreTraffic` and `verifySource`. Outcomes distinguish `verified`, `rolled_back` and `recovery_required`. The digest must come from your reviewed operational approval process; passing a hash is not itself user authorization.

These adapters can wrap a deployment router, feature flag or reviewed DNS change. There is no default production DNS operation. The operator must serialize cutovers and persist the plan/outcomes in their deployment journal. This coordinator is not a crash-durable distributed deployment system. If the host crashes during a routing operation, reconcile provider state before retrying. Never point it at production until provider-specific rollback and post-switch write reconciliation have been tested.

The automated suite rehearses import verification, rejection of stale/conflicting plans, preservation of IDs, ownership checks, and traffic restoration with synthetic adapters. Full production application equivalence still requires ported auth, business functions, secrets, media, integrations and operational infrastructure.
