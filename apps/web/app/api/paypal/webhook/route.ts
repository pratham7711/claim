import { getService } from "../../../../lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** PayPal webhook deliveries. The raw body is verified as received, before any parsing. */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const headers = Object.fromEntries(req.headers.entries());
  const r = await getService().webhook(headers, rawBody);
  return Response.json(r.body, { status: r.status });
}
