import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SellerConsole } from "../../../components/seller/seller-console";
import { getService } from "../../../lib/server";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ showId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { showId } = await params;
  const v = getService().view(showId);
  return { title: v ? `Console · ${v.title} · Claim!` : "Claim!" };
}

export default async function SellerPage({ params }: Props) {
  const { showId } = await params;
  const view = getService().view(showId);
  if (!view) notFound();
  return <SellerConsole initial={view} />;
}
