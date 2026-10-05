import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Closeout } from "../../../../components/closeout";
import { getService } from "../../../../lib/server";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ showId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { showId } = await params;
  const v = getService().view(showId);
  return { title: v ? `Close-out · ${v.title} · Claim!` : "Claim!" };
}

export default async function CloseoutPage({ params }: Props) {
  const { showId } = await params;
  const view = getService().view(showId, "seller");
  if (!view) notFound();
  return <Closeout initial={view} />;
}
