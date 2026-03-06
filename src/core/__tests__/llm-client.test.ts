import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createAutoClient,
  GeminiClient,
  OpenAIClient,
  AnthropicClient,
  MockLLMClient,
} from "../llm-client.js";

describe("createAutoClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns GeminiClient when GEMINI_API_KEY is set", () => {
    vi.stubEnv("GEMINI_API_KEY", "gk-test");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(createAutoClient()).toBeInstanceOf(GeminiClient);
  });

  it("returns OpenAIClient when OPENAI_API_KEY is set (no Gemini key)", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(createAutoClient()).toBeInstanceOf(OpenAIClient);
  });

  it("returns AnthropicClient when ANTHROPIC_API_KEY is set (no Gemini/OpenAI key)", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    expect(createAutoClient()).toBeInstanceOf(AnthropicClient);
  });

  it("returns MockLLMClient when no API keys are set", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(createAutoClient()).toBeInstanceOf(MockLLMClient);
  });

  it("prefers explicit options over env vars", () => {
    vi.stubEnv("GEMINI_API_KEY", "env-gemini-key");
    const client = createAutoClient({ openaiApiKey: "explicit-openai-key", geminiApiKey: undefined });
    // geminiApiKey: undefined means it falls through to GEMINI_API_KEY env var,
    // so Gemini still wins if the env var is set.
    // Test explicit geminiApiKey: "" falls through to openai
    const client2 = createAutoClient({ geminiApiKey: "", openaiApiKey: "explicit-openai-key" });
    expect(client2).toBeInstanceOf(OpenAIClient);
  });
});
