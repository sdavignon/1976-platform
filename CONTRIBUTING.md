# Contributing

1976Studios welcomes community improvements. Open an issue describing a concrete SDK interface or migration need, then submit a focused pull request with tests and documentation.

Use Node 22+, run `npm ci`, `npm test`, and `npm pack --dry-run`. Set `TEST_MYSQL_URL` to a dedicated MySQL 8 test database for integration tests. CI runs against MySQL 8.4.

Compatibility claims require a reference call shape and an executable test. Keep browser code free of server dependencies. Never add service credentials, real customer data, copied proprietary SDK source or production fixture exports. Add provider adapters behind explicit authorization; no silent success for unsupported methods.

Priority contributions: scalable SQL-scoped policies; durable change-event replay; identity-provider adapters; shared-email port; Worker/Hyperdrive runtime; typed entity registries; large-dataset migration and change-data-capture; provider contract tests.

By submitting changes, you agree they may be distributed under this project's MIT license. Be respectful and specific in reviews.
