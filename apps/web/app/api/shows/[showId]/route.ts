import { getService } from "../../../../lib/server";
import type { ShowAction } from "../../../../lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ showId: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { showId } = await params;
  const view = getService().view(showId);
  return view ? Response.json(view) : Response.json({ error: "No such show." }, { status: 404 });
}

export async function POST(req: Request, { params }: Ctx) {
  const { showId } = await params;
  const body = (await req.json().catch(() => null)) as ShowAction | null;
  if (!body || typeof body !== "object" || typeof body.action !== "string") {
    return Response.json({ ok: false, error: "Send a JSON body with an action." }, { status: 400 });
  }
  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  const r = await getService().act(showId, body, { origin });
  const status = r.ok ? 200 : (r.status ?? 400);
  return Response.json(r, { status });
}
