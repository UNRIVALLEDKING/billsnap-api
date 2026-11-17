export type PushNotificationPayload = {
  title: string;
  body: string;
  data?: Record<string, string> | undefined;
  collapseKey?: string | undefined;
};

export type FcmV1Message = {
  message: {
    token: string;
    notification: {
      title: string;
      body: string;
    };
    data?: Record<string, string> | undefined;
    android?:
      | {
          collapse_key?: string | undefined;
          priority: "high" | "normal";
        }
      | undefined;
  };
};

export function buildFcmV1Message(token: string, payload: PushNotificationPayload): FcmV1Message {
  const msg: FcmV1Message = {
    message: {
      token,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      android: {
        priority: "high",
        collapse_key: payload.collapseKey,
      },
    },
  };
  if (payload.data) {
    msg.message.data = payload.data;
  }
  return msg;
}

export interface FcmClient {
  send(token: string, payload: PushNotificationPayload): Promise<boolean>;
}

export class MemoryFcmClient implements FcmClient {
  public sent: Array<{ token: string; payload: PushNotificationPayload; message: FcmV1Message }> =
    [];

  async send(token: string, payload: PushNotificationPayload): Promise<boolean> {
    const message = buildFcmV1Message(token, payload);
    this.sent.push({ token, payload, message });
    return true;
  }
}
