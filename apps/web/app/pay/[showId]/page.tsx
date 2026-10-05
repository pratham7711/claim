import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PayPage } from "../../../components/pay-page";
import { getService } from "../../../lib/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pay · Claim!" };

type Props = { params: Promise<{ showId: string }>; searchParams: Promise<{ token?: string; PayerID?: string }> };

export default async function Pay({ params, searchParams }: Props) {
  const { showId } = await params;
  const { token, PayerID } = await searchParams;
  const view = getService().view(showId);
  if (!view) notFound();
  const order = view.orders.find((o) => o.orderId === token);
  return <PayPage showId={showId} shopName={view.shopName} order={order ?? null} payments={view.payments} approved={Boolean(PayerID)} />;
}
