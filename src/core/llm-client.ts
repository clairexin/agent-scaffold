// ─────────────────────────────────────────────
// LLM Client — Abstraction over model providers
// ─────────────────────────────────────────────

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  tokensUsed: { input: number; output: number; total: number };
  model: string;
}

export interface LLMClient {
  complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;
}

export interface LLMOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: "text" | "json";
}

/**
 * Anthropic Claude client implementation.
 * Swap this out for OpenAI, local models, etc.
 */
export class AnthropicClient implements LLMClient {
  constructor(
    private apiKey: string,
    private baseUrl = "https://api.anthropic.com"
  ) {}

  async complete(messages: LLMMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
    const model = options.model ?? "claude-sonnet-4-20250514";
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMsgs = messages.filter((m) => m.role !== "system");

    const body: Record<string, unknown> = {
      model,
      max_tokens: options.maxTokens ?? 4096,
      messages: nonSystemMsgs.map((m) => ({ role: m.role, content: m.content })),
    };
    if (systemMsg) body.system = systemMsg.content;
    if (options.temperature !== undefined) body.temperature = options.temperature;

    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`LLM API error (${resp.status}): ${err}`);
    }

    const data = await resp.json();
    const content = data.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    return {
      content,
      tokensUsed: {
        input: data.usage?.input_tokens ?? 0,
        output: data.usage?.output_tokens ?? 0,
        total: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      },
      model: data.model,
    };
  }
}

/**
 * Google Gemini client implementation.
 */
export class GeminiClient implements LLMClient {
  constructor(
    private apiKey: string,
    private baseUrl = "https://generativelanguage.googleapis.com"
  ) {}

  async complete(messages: LLMMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
    const model = options.model ?? "gemini-2.5-flash-lite";
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMsgs = messages.filter((m) => m.role !== "system");

    const contents = nonSystemMsgs.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const body: Record<string, unknown> = { contents };

    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: options.maxTokens ?? 8192,
    };
    if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
    if (options.responseFormat === "json") generationConfig.responseMimeType = "application/json";
    body.generationConfig = generationConfig;

    const resp = await fetch(
      `${this.baseUrl}/v1beta/models/${model}:generateContent?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Gemini API error (${resp.status}): ${err}`);
    }

    const data = await resp.json();
    const content = data.candidates?.[0]?.content?.parts
      ?.map((p: any) => p.text)
      .join("\n") ?? "";

    return {
      content,
      tokensUsed: {
        input: data.usageMetadata?.promptTokenCount ?? 0,
        output: data.usageMetadata?.candidatesTokenCount ?? 0,
        total: data.usageMetadata?.totalTokenCount ?? 0,
      },
      model,
    };
  }
}

/**
 * OpenAI client implementation.
 */
export class OpenAIClient implements LLMClient {
  constructor(
    private apiKey: string,
    private baseUrl = "https://api.openai.com"
  ) {}

  async complete(messages: LLMMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
    const model = options.model ?? "gpt-4o-mini";

    const body: Record<string, unknown> = {
      model,
      max_tokens: options.maxTokens ?? 4096,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.responseFormat === "json") body.response_format = { type: "json_object" };

    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenAI API error (${resp.status}): ${err}`);
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content ?? "";

    return {
      content,
      tokensUsed: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
        total: data.usage?.total_tokens ?? 0,
      },
      model: data.model ?? model,
    };
  }
}

export interface AutoClientOptions {
  geminiApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
}

/**
 * Auto-selects an LLM client based on available API keys.
 * Priority: Gemini → OpenAI → Anthropic → Mock (for local dev/testing).
 */
export function createAutoClient(options?: AutoClientOptions): LLMClient {
  const geminiKey = options?.geminiApiKey ?? process.env["GEMINI_API_KEY"];
  if (geminiKey) return new GeminiClient(geminiKey);

  const openaiKey = options?.openaiApiKey ?? process.env["OPENAI_API_KEY"];
  if (openaiKey) return new OpenAIClient(openaiKey);

  const anthropicKey = options?.anthropicApiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (anthropicKey) return new AnthropicClient(anthropicKey);

  return new MockLLMClient();
}

/**
 * Mock client for local development and testing.
 * Returns canned responses — replace the handlers with your logic.
 */
export class MockLLMClient implements LLMClient {
  constructor(private handler?: (messages: LLMMessage[]) => string) {}

  async complete(messages: LLMMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
    const content = this.handler
      ? this.handler(messages)
      : '{"tasks": [{"id": "t1", "description": "Mock task", "dependencies": [], "toolsNeeded": []}]}';

    return {
      content,
      tokensUsed: { input: 100, output: 50, total: 150 },
      model: "mock",
    };
  }
}
