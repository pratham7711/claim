import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DemoSplit } from "../../../components/demo-split";
import { getService } from "../../../lib/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Demo · Claim!" };

type Props = { params: Promise<{ showId: string }> };

export default async function DemoPage({ params }: Props) {
  const { showId } = await params;
  const view = getService().view(showId);
  if (!view) notFound();
  return <DemoSplit showId={showId} title={view.title} shopName={view.shopName} />;
}
