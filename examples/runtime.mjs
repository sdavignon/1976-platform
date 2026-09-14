import { WorkflowEngine } from "../dist/workflows.js";
import { WorkflowSchedules } from "../dist/schedules.js";
import { AgentService } from "../dist/agents.js";

// Add these to createHandler({ ...options, ...runtime }) in your host.
// resolveUser MUST resolve current identity/roles; never trust stale queue claims.
export async function configureRuntime(pool, appId, resolveUser, respond) {
  const workflows = new WorkflowEngine(
    pool,
    appId,
    {
      summarize: {
        version: "1",
        authorize: (scope) => !!scope.user,
        run: async (input, context) =>
          context.step("summary", async (idempotencyKey) => ({
            text: String(input.text),
            idempotencyKey,
          })),
      },
    },
    resolveUser,
  );
  const schedules = new WorkflowSchedules(workflows);
  const agents = new AgentService(pool, {
    assistant: { authorize: (scope) => !!scope.user, respond },
  });
  await workflows.migrate();
  await schedules.migrate();
  await agents.migrate();
  return { workflows, agents, realtime: { intervalMs: 1000 }, schedules };
}

// Run in a dedicated worker process, not in every web request.
export async function runWorker(runtime, signal) {
  while (!signal.aborted) {
    await runtime.schedules.tick();
    const didWork = await runtime.workflows.tick();
    if (!didWork)
      await new Promise((resolve) => {
        const timer = setTimeout(done, 1000);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
  }
}
