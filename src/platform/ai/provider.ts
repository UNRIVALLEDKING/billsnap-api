export type AiHints = {
  billType: "purchase" | "sale";
  ownGstin?: string;
  ownName: string;
  /** Other names the business appears under on bills. */
  ownAliases?: string[];
  ownStateCode?: string;
};

export type AiExtractInput = {
  /** Pages in order. */
  files: { mime: string; bytes: Uint8Array }[];
  hints: AiHints;
  model: string;
  signal: AbortSignal;
  /** The full instruction text (built by the extraction module, versioned in extraction/prompts). */
  prompt: string;
  /** Provider-neutral JSON schema of the expected output (OpenAPI subset, as Gemini takes it). */
  responseSchema: object;
  /** Set on the repair retry: what was wrong with the previous output. */
  repairHint?: string;
};

export type AiExtractResult = {
  /** Parsed JSON, or the raw text when the model did not return valid JSON. */
  output: unknown;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
};

export interface AiProvider {
  readonly name: string;
  extractBill(input: AiExtractInput): Promise<AiExtractResult>;
}

/** Provider failure. `retryable` is true for 429, 5xx and timeouts. */
export class AiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AiError";
  }
}
