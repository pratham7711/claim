import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BuyerRoom } from "../../../components/buyer-room";
import { getService } from "../../../lib/server";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ showId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { showId } = await params;
  const v = getService().view(showId);
  return { title: v ? `${v.shopName} · live` : "Claim!" };
}

export default async function LivePage({ params }: Props) {
  const { showId } = await params;
  const view = getService().view(showId);
  if (!view) notFound();
  return <BuyerRoom initial={view} />;
}
