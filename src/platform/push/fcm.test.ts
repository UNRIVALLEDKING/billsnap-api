import { describe, expect, test } from "bun:test";
import { notifyBillReady } from "../../modules/notifications/notifications.service";
import { buildFcmV1Message, MemoryFcmClient } from "./fcm";

describe("FCM Push Notifications", () => {
  test("buildFcmV1Message formats valid FCM HTTP v1 JSON with collapse key", () => {
    const msg = buildFcmV1Message("test-fcm-token", {
      title: "Bill Ready",
      body: "Green Mart bill ready for review",
      data: { bill_id: "bill-123" },
      collapseKey: "bill_ready_biz-1",
    });

    expect(msg.message.token).toBe("test-fcm-token");
    expect(msg.message.notification.title).toBe("Bill Ready");
    expect(msg.message.notification.body).toBe("Green Mart bill ready for review");
    expect(msg.message.data?.bill_id).toBe("bill-123");
    expect(msg.message.android?.collapse_key).toBe("bill_ready_biz-1");
    expect(msg.message.android?.priority).toBe("high");
  });

  test("notifyBillReady delivers to all user tokens with correct business collapse key", async () => {
    const client = new MemoryFcmClient();
    const tokens = ["device-token-1", "device-token-2"];

    const delivered = await notifyBillReady(client, tokens, {
      id: "b-999",
      businessId: "biz-42",
      vendorName: "Kisan Mandi",
    });

    expect(delivered).toBe(2);
    expect(client.sent.length).toBe(2);

    const first = client.sent[0];
    expect(first?.token).toBe("device-token-1");
    expect(first?.payload.title).toBe("Bill Ready for Review");
    expect(first?.payload.body).toBe("Kisan Mandi bill is ready for review.");
    expect(first?.payload.collapseKey).toBe("bill_ready_biz-42");
    expect(first?.payload.data?.bill_id).toBe("b-999");
    expect(first?.payload.data?.business_id).toBe("biz-42");
    expect(first?.payload.data?.screen).toBe("review");
  });
});
