import { PlatformError } from "./client.js";
/** Authenticated SSE snapshots. Every poll rechecks identity and current row policies. */
export async function snapshotStream(
  request: Request,
  read: () => Promise<unknown>,
  options: { intervalMs?: number; maxDurationMs?: number } = {},
) {
  const interval = options.intervalMs ?? 1000,
    duration = options.maxDurationMs ?? 60000;
  if (interval < 50 || duration < interval)
    throw new Error("Invalid stream interval");
  const first = await read();
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const encoder = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const started = Date.now();
      let previous = JSON.stringify(first);
      const send = (event: string, data: unknown) =>
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      stop = () => {
        if (stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        request.signal.removeEventListener("abort", stop);
        try {
          controller.close();
        } catch {}
      };
      request.signal.addEventListener("abort", stop, { once: true });
      if (request.signal.aborted) {
        stop();
        return;
      }
      send("snapshot", first);
      const poll = async () => {
        if (stopped) return;
        if ((controller.desiredSize ?? 0) <= 0) {
          stop();
          return;
        }
        try {
          const value = await read();
          if (stopped) return;
          const next = JSON.stringify(value);
          if (next !== previous) {
            send("snapshot", value);
            previous = next;
          } else controller.enqueue(encoder.encode(": heartbeat\n\n"));
          if (Date.now() - started >= duration) {
            stop();
            return;
          }
          timer = setTimeout(poll, interval);
        } catch (error) {
          if (!stopped) {
            send("error", {
              error:
                error instanceof PlatformError
                  ? error.message
                  : "Stream unavailable",
            });
            stop();
          }
        }
      };
      timer = setTimeout(poll, interval);
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
