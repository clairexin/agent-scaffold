// ─────────────────────────────────────────────
// Agent Platform — Public API
// ─────────────────────────────────────────────

export { Orchestrator, type RunResult, type ReplanRecord } from "./core/orchestrator.js";
export { Planner } from "./core/planner.js";
export { Executor } from "./core/executor.js";
export { Synthesizer, type SynthesisResult } from "./core/synthesizer.js";
export {
  AnthropicClient,
  GeminiClient,
  OpenAIClient,
  MockLLMClient,
  createAutoClient,
  type AutoClientOptions,
  type LLMClient,
  type LLMMessage,
} from "./core/llm-client.js";
export { ToolRegistry, createBuiltinTools } from "./core/tool-registry.js";
export { EventBus, createLogger } from "./utils/events.js";
export { topologicalSort, validateDAG, isTaskReady } from "./utils/dag.js";
export * from "./types/index.js";
