# Workflows, schedules and live agents

Version 0.2 adds reusable runtime capabilities. No existing application has been selected for a pilot or moved to this runtime.

## Durable workflows

```js
import { WorkflowEngine } from '@1976studios/platform/workflows';
const workflows = new WorkflowEngine(pool, 'my-app', {
  generateReport: {
    version: '1',
    authorize: scope => scope.user?.role === 'admin',
    run: async (input, context) => context.step('build', async idempotencyKey => {
      return buildReport(input, { idempotencyKey, signal: context.signal });
    })
  }
}, resolveCurrentUser);
await workflows.migrate();
// Add workflows to createHandler; use a dedicated worker process:
await workflows.tick();
// Browser:
const job = await base44.workflows.enqueue('generateReport', {month:'2026-09'}, {
  idempotencyKey: 'report-2026-09', maxAttempts: 3, delayMs: 0
});
const status = await base44.workflows.get(job.id);
```

Jobs, inputs, results, attempts and completed steps persist in MySQL. Workers are scoped to one app and claim only registered workflow names/versions. Concurrent claims use `FOR UPDATE SKIP LOCKED`, renewable leases and fenced writes. Resolve identity afresh when executing a job. Unknown versions remain queued for the correct worker; monitor them explicitly.

Delivery is **at least once**, not exactly once. If a process crashes after an external action but before saving its step, that action may run again. Use the supplied stable step idempotency key with the provider. Step names must be stable and unique within a run. Do not run the same step name concurrently. Handlers must use timeouts and honor `context.signal`; a stuck handler otherwise keeps its worker occupied. Retried steps are skipped only after their result is committed. Persisted results must be JSON serializable. Terminal failures expose status, not raw provider errors.

## Recurring schedules and Base44 workflow conversion

```js
import { WorkflowSchedules, compileBase44Workflow } from '@1976studios/platform/schedules';
const schedules = new WorkflowSchedules(workflows);
await schedules.migrate();
await schedules.create(scope, 'generateReport', {
  cron: '0 6 * * *', timezone: 'America/Denver'
}, {month:'2026-09'});
await schedules.tick();
```

Cron expressions use explicit IANA timezones. Interval schedules use `{intervalMs, anchorAt}`. Schedule insertion and advancement are atomic. After downtime, one due run is queued and missed intervals are coalesced; historical intervals are not replayed. `pause(scope,id)` stops future scheduling, not already queued runs. Creating a schedule always creates a new schedule; retain its ID and avoid calling create during every server boot.

`compileBase44Workflow(source, authorize, invoke)` accepts the static ordered backend-call subset found in the reference repositories, including the two-step shared-email reconciliation workflow. It returns a definition and schedule; **it does not register or enable them**. The invoke adapter receives function name, arguments, workflow context and step idempotency key. Port the named functions and permission checks separately. Unsupported branching, expressions, event triggers, one-time/end conditions or ambiguous local interval anchors fail explicitly. No Base44 SDK source is imported.

## Agents and subscriptions

```js
import { AgentService } from '@1976studios/platform/agents';
const agents = new AgentService(pool, {
  assistant: { authorize: scope => !!scope.user, respond: yourProviderAdapter }
});
await agents.migrate();
// createHandler({ ..., agents, realtime:{intervalMs:1000} })
const conversation = await base44.agents.createConversation({agent_name:'assistant'});
const unsubscribe = base44.agents.subscribeToConversation(conversation.id, value => {
  renderMessages(value.messages);
}, reportError);
await base44.agents.addMessage(conversation, {role:'user',content:'Hello'});
unsubscribe();
```

Supported methods: create/list/get conversation, add user message and subscribe to conversation. `respond(messages, context)` returns `{content}` and receives an AbortSignal. Conversations are owned by immutable user ID and app; agent authorization is rechecked for every request. Concurrent messages return 409 while a reply is pending. Provider errors/timeouts leave the conversation in `failed`; user messages remain in history. After a process crash, a later message may reclaim an expired response lease. Limits: 200 messages before accepting a new user message, 32,000 input characters, 128,000 output characters, ten HTTPS attachment URLs. Providers must validate attachment fetches against SSRF and enforce image/tool permissions. The runtime does not fetch attachments itself.

This is an agent conversation runtime, not a built-in LLM or automatic tool executor. Supply your provider adapter and allowlisted tools deliberately. Native Base44 agent definitions/tool grants are not automatically imported. Streaming updates expose persisted conversation state; token-by-token model streaming is not implemented.

`entities.Name.subscribe(callback)` emits `{id,type,data}` for create/update and `{id,type:'delete'}` when a previously visible row disappears or loses authorization. The first snapshot emits creates. It uses authenticated Fetch/SSE with reconnect and unsubscribe, rechecks identity and row policy at every snapshot, and works across Node instances sharing MySQL. HTTP disconnects must abort the Request; see the server example.

Snapshots are normally refreshed each second, not a durable change-event log. Intermediate transitions between snapshots may be coalesced. Subscriptions support fewer than 1,000 visible rows per entity; they fail rather than silently truncate at the limit. Slow unread streams close to bound buffering and reconnect. Configure gateway stream/concurrency limits. Reconnect does not replay historical events. Do not use these notifications as triggers for financial or irreversible actions.

See [runtime wiring](../examples/runtime.mjs) and [migration/cutover tooling](MIGRATION-TOOLS.md).
