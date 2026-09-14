# 1976 Platform

**Your app. Your database. Your infrastructure.**

An open-source application library by **1976Studios**, created by Scott Davignon at [1976.cloud](https://1976.cloud). It provides familiar Base44-style JavaScript interfaces backed by MySQL and Cloudflare R2, with a server-only Cloudflare DNS client.

**v0.1 is an early compatibility release, not a complete Base44 clone.** It implements the common data, function and upload patterns observed in [SocialCloud](https://github.com/sdavignon/socialcloud) and [MailWorthy](https://github.com/sdavignon/mailworthy). Authentication lifecycle, AI and email use explicitly configured handlers. Existing apps need a deliberate migration; changing one import does not migrate users, policies, functions or data.

## What you get

- Browser SDK: `createClient`, entity CRUD, filters, sorting, pagination, bulk creation, auth calls, function calls and integrations.
- MySQL 8 persistence with app isolation, transactional writes, parameterized queries and per-entity access policies.
- Fetch-compatible server handler and trusted `createClientFromRequest` / `asServiceRole` interfaces.
- JWT verification against an OIDC issuer, with audience and issuer checks.
- Cloudflare R2 public uploads, private uploads and expiring private downloads.
- Cloudflare DNS listing, creation, updates and deletion through explicit server-side credentials.
- TypeScript declarations, tests, CI with MySQL 8.4, and a runnable Node example.

## Install

Requires Node.js 22+ and MySQL 8.0+ (MySQL, not MariaDB).

```sh
npm install github:sdavignon/1976-platform#v0.1.0
```

The package name is `@1976studios/platform`. Distribution is currently through GitHub; it is not published to the npm registry.

```js
import { createClient } from '@1976studios/platform';

export const base44 = createClient({
  appId: 'my-app',
  serverUrl: 'https://api.example.com',
  token: accessToken
});

const task = await base44.entities.Task.create({ title: 'Ship something useful' });
const tasks = await base44.entities.Task.filter({ title: 'Ship something useful' }, '-created_date', 20);
await base44.entities.Task.update(task.id, { title: 'Shipped' });
const { data } = await base44.functions.invoke('hello', {});
```

Use a same-origin reverse proxy for the API, or configure restricted CORS at your gateway. Cross-origin credential policy is not configured by this library.

## Run the backend

```sh
git clone https://github.com/sdavignon/1976-platform.git
cd 1976-platform
npm ci
cp .env.example .env
# Edit .env with your own MySQL and OIDC configuration.
node --env-file=.env examples/server.mjs
```

The example creates the records table and serves a policy-protected `Task` entity and `hello` function on loopback port 1976. Provide a valid JWT from your OIDC provider. Optional R2 variables enable storage. The example does not create cloud resources or DNS records.

```js
import { MySQLStore, ownerOnly } from '@1976studios/platform/mysql';
import { createHandler, jwtAuthenticator } from '@1976studios/platform/server';

const store = new MySQLStore(process.env.MYSQL_URL, {
  Task: { authorize: ownerOnly }
});
await store.migrate();
const handle = createHandler({
  appId: 'my-app', store,
  authenticate: jwtAuthenticator({
    jwksUrl: process.env.OIDC_JWKS_URL,
    issuer: process.env.OIDC_ISSUER,
    audience: process.env.OIDC_AUDIENCE
  }),
  functions: {
    hello: { authorize: scope => !!scope.user, run: () => ({ hello: '1976' }) }
  }
});
// Connect handle(Request) -> Response to your Node HTTP framework.
```

`ownerOnly` is an example, not a replacement for multi-brand membership policies. Every entity must be registered with a policy. The service role is a trusted backend capability and must never be selected by a request parameter.

## Cloudflare

```js
import { R2Storage, CloudflareDNS } from '@1976studios/platform/cloudflare';
const storage = new R2Storage({
  accountId: process.env.R2_ACCOUNT_ID,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  privateBucket: 'private-files',
  publicBucket: 'public-files',
  publicBaseUrl: 'https://media.example.com'
});
// Add storage.integrations() to the server's integrations registry.
const dns = new CloudflareDNS(process.env.CLOUDFLARE_API_TOKEN, process.env.CLOUDFLARE_ZONE_ID);
const { result, result_info } = await dns.list({ name: 'example.com' });
```

Use separate R2 buckets. Keep the private bucket's public access disabled. Public upload URLs use your configured public custom domain; private signed URLs use the R2 S3 endpoint. See [Cloudflare's signed URL documentation](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

## Shared Email — another useful 1976 repository

[**base44-shared-email**](https://github.com/sdavignon/base44-shared-email) provides a reusable shared inbox, aliases, threading, drafts, delivery tracking and email administration for Base44 apps. It is a companion project by 1976, and a useful reference for building shared email into your apps. Its current installer targets Base44; it is **not yet an installer for this platform**. See [the migration guide](docs/MIGRATION.md) for the work needed to port it.

## Documentation and community

- [Compatibility and limitations](docs/COMPATIBILITY.md)
- [Migration guide](docs/MIGRATION.md)
- [Security and deployment](docs/SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Report an issue](https://github.com/sdavignon/1976-platform/issues)

```sh
npm test
# Include real database tests (use a dedicated test database):
TEST_MYSQL_URL=mysql://user:password@localhost:3306/platform_test npm test
npm pack --dry-run
```

MIT licensed. Independent community software; not affiliated with or endorsed by Base44, MySQL, or Cloudflare. Base44 names describe interface compatibility only.
