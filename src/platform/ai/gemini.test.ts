import { describe, expect, test } from "bun:test";
import { createGeminiProvider } from "./gemini";
import type { AiError } from "./provider";

const input = {
  files: [{ mime: "image/jpeg", bytes: Uint8Array.from([1, 2, 3]) }],
  hints: { billType: "purchase" as const, ownName: "Demo Business" },
  model: "gemini-3.8-flash",
  signal: new AbortController().signal,
  prompt: "read it",
  responseSchema: { type: "OBJECT" },
};

const reply =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe("GeminiProvider (stubbed fetch)", () => {
  test("sends the documented request and parses the JSON answer", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const ai = createGeminiProvider({
      apiKey: "k",
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"is_bill":true}' }] } }],
            usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 },
          }),
        );
      }) as unknown as typeof fetch,
    });
    const res = await ai.extractBill(input);
    expect(res.output).toEqual({ is_bill: true });
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 4 });
    expect(seen?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    );
    const headers = (seen?.init.headers ?? {}) as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("k");
    const body = JSON.parse(seen?.init.body as string);
    expect(body.generationConfig).toMatchObject({
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: { type: "OBJECT" },
    });
    expect(body.contents[0].parts[1].inline_data).toEqual({
      mime_type: "image/jpeg",
      data: "AQID",
    });
  });

  test("non-JSON text is returned raw for the repair path", async () => {
    const ai = createGeminiProvider({
      apiKey: "k",
      fetchImpl: reply({ candidates: [{ content: { parts: [{ text: "oops" }] } }] }) as never,
    });
    expect((await ai.extractBill(input)).output).toBe("oops");
  });

  test("429 and 5xx are retryable, 400 is not", async () => {
    const run = (status: number) =>
      createGeminiProvider({ apiKey: "k", fetchImpl: reply({}, status) as never })
        .extractBill(input)
        .catch((e: AiError) => e);
    expect(await run(429)).toMatchObject({ retryable: true, status: 429 });
    expect(await run(503)).toMatchObject({ retryable: true });
    expect(await run(400)).toMatchObject({ retryable: false });
  });

  test("a hung request times out as retryable", async () => {
    const ai = createGeminiProvider({
      apiKey: "k",
      timeoutMs: 20,
      fetchImpl: ((_: string, init: RequestInit) =>
        new Promise((_res, rej) =>
          init.signal?.addEventListener("abort", () => rej(init.signal?.reason)),
        )) as never,
    });
    expect(await ai.extractBill(input).catch((e) => e)).toMatchObject({ retryable: true });
  });
});
