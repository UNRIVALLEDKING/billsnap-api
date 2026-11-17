import { AiError, type AiExtractInput, type AiExtractResult, type AiProvider } from "./provider";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 60_000;

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

export function createGeminiProvider(opts: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): AiProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    name: "gemini",
    async extractBill(input: AiExtractInput): Promise<AiExtractResult> {
      const started = performance.now();
      const parts: object[] = [{ text: input.prompt }];
      if (input.repairHint) parts.push({ text: input.repairHint });
      for (const f of input.files) {
        parts.push({
          inline_data: { mime_type: f.mime, data: Buffer.from(f.bytes).toString("base64") },
        });
      }
      const signal = AbortSignal.any([
        input.signal,
        AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
      ]);
      let res: Response;
      try {
        res = await doFetch(`${BASE}/${encodeURIComponent(input.model)}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: {
              temperature: 0,
              responseMimeType: "application/json",
              responseSchema: input.responseSchema,
            },
          }),
          signal,
        });
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === "TimeoutError" || name === "AbortError") {
          throw new AiError("Gemini request timed out", true);
        }
        throw new AiError(`Gemini request failed: ${(err as Error).message}`, true);
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        throw new AiError(
          `Gemini HTTP ${res.status}: ${detail}`,
          res.status === 429 || res.status >= 500,
          res.status,
        );
      }
      const body = (await res.json().catch(() => null)) as GeminiResponse | null;
      const text = body?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? "")
        .join("")
        .trim();
      if (!text) {
        const why =
          body?.promptFeedback?.blockReason ?? body?.candidates?.[0]?.finishReason ?? "empty";
        throw new AiError(`Gemini returned no content (${why})`, false);
      }
      let output: unknown = text;
      try {
        output = JSON.parse(text);
      } catch {
        // Keep the raw text: the caller's schema check rejects it and triggers the repair retry.
      }
      return {
        output,
        usage: {
          inputTokens: body?.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: body?.usageMetadata?.candidatesTokenCount ?? 0,
        },
        latencyMs: Math.round(performance.now() - started),
      };
    },
  };
}
