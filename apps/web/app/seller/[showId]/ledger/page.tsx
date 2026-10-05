import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Ledger } from "../../../../components/seller/ledger";
import { getService } from "../../../../lib/server";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ showId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { showId } = await params;
  const v = getService().view(showId);
  return { title: v ? `Ledger · ${v.title} · Claim!` : "Claim!" };
}

export default async function LedgerPage({ params }: Props) {
  const { showId } = await params;
  const view = getService().view(showId, "seller");
  if (!view) notFound();
  return <Ledger initial={view} />;
}
