import type { FcmClient } from "../../platform/push/fcm";

export async function notifyBillReady(
  fcm: FcmClient,
  tokens: string[],
  bill: {
    id: string;
    businessId: string;
    vendorName?: string | null | undefined;
    totalAmount?: string | null | undefined;
  },
): Promise<number> {
  const vendor = bill.vendorName?.trim() || "A new";
  const title = "Bill Ready for Review";
  const body = `${vendor} bill is ready for review.`;

  let delivered = 0;
  for (const token of tokens) {
    const success = await fcm.send(token, {
      title,
      body,
      data: {
        bill_id: bill.id,
        business_id: bill.businessId,
        screen: "review",
      },
      collapseKey: `bill_ready_${bill.businessId}`,
    });
    if (success) delivered++;
  }
  return delivered;
}
