import { getService } from "../../../lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ shows: getService().list() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { title?: string; shopName?: string; seed?: boolean };
  const showId = await getService().create({ ...body, seed: body.seed !== false });
  return Response.json({ showId }, { status: 201 });
}
