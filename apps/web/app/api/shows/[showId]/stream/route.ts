import { getService } from "../../../../../lib/server";
import type { ShowView } from "../../../../../lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ showId: string }> };

/** Server-sent snapshots: the full show view on connect, then on every change (coalesced). */
export async function GET(req: Request, { params }: Ctx) {
  const { showId } = await params;
  const svc = getService();
  const first = svc.view(showId);
  if (!first) return new Response("No such show.", { status: 404 });

  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const snapshot = (v: ShowView) => send(`event: snapshot\ndata: ${JSON.stringify(v)}\n\n`);
      send("retry: 1500\n\n");
      snapshot(first);
      const unsubscribe = svc.subscribe(showId, snapshot) ?? (() => {});
      const ping = setInterval(() => send(": ping\n\n"), 15_000);
      cleanup = () => {
        unsubscribe();
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
