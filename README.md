# Agent Framework

> TypeScript framework for LLM-powered multi-agent pipelines with adaptive replanning.

![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?logo=typescript)
![Node.js](https://img.shields.io/badge/Node.js-ESM-green?logo=node.js)
![Vitest](https://img.shields.io/badge/tested_with-vitest-yellow?logo=vitest)

Agent Framework decomposes a natural language goal into a dependency-aware task graph, executes tasks in parallel with an agentic tool-use loop, evaluates the results, and replans automatically when the goal isn't fully satisfied — all while tracking token usage across every phase.

---

## Features

- **Adaptive replan loop** — automatically re-decomposes and re-executes when completeness falls below a configurable threshold (default 70%)
- **Parallel task execution** — topological sort groups independent tasks; a concurrency limiter runs them in parallel
- **Agentic executor** — each task runs an LLM loop that can call tools, receive results, and iterate before producing a final answer
- **LLM provider abstraction** — swap between Google Gemini, OpenAI, Anthropic Claude, or a mock client; `createAutoClient()` auto-selects based on available API keys
- **Pluggable tool registry** — register custom tools; built-ins cover `write_file`, `read_file`, `shell`, `store_memory`, `read_memory`
- **Event bus** — subscribe to typed lifecycle events for logging, tracing, or external integrations
- **Token budget tracking** — total and per-task token counts accumulate in the run context; replanning stops when budget is nearly exhausted
- **DAG validation** — detects missing dependencies and cycles before execution begins

---

## Architecture

### Pipeline Flow

```
Goal (string)
     │
     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         ORCHESTRATOR                                │
│                                                                     │
│  ┌──────────┐  task DAG                                             │
│  │ Planner  │ ─────────────────────────────────────┐               │
│  └──────────┘                                      │               │
│                                                    ▼               │
│              ┌──────────────────────────────────────────────────┐  │
│              │  Parallel Execution (per dependency group)       │  │
│              │                                                  │  │
│              │  ┌──────────┐  ┌──────────┐  ┌──────────┐       │  │
│              │  │ Executor │  │ Executor │  │ Executor │  ...  │  │
│              │  └────┬─────┘  └────┬─────┘  └────┬─────┘       │  │
│              │       │  tool calls (agentic loop) │              │  │
│              │  ┌────▼─────────────▼──────────────▼──────────┐  │  │
│              │  │              Tool Registry                  │  │  │
│              │  │  write_file · read_file · shell · memory    │  │  │
│              │  └─────────────────────────────────────────────┘  │  │
│              └──────────────────────────────────────────────────┘  │
│                                    │ all TaskResults                │
│                                    ▼                               │
│                          ┌─────────────────┐                       │
│                          │   Synthesizer   │                       │
│                          └────────┬────────┘                       │
│                                   │                                │
│               completeness ≥ 0.7  │  completeness < 0.7            │
│               or goalSatisfied    │  and iterations remain         │
│                        ┌──────────┴───────────┐                    │
│                        │                      │                    │
│                        ▼                      ▼                    │
│                    RunResult            Replan → Planner            │
│                                        (loops back up)             │
└─────────────────────────────────────────────────────────────────────┘
```

### Module Map

```
src/
  types/index.ts        ← shared types: Task, Plan, RunContext, FrameworkEvent, ...
  core/
    orchestrator.ts     ← control plane; exposes run(), manages all 4 phases
    planner.ts          ← goal → JSON task DAG via LLM; validates with DAG utils
    executor.ts         ← agentic tool-use loop per task (LLM ↔ tools, ≤ 10 rounds)
    synthesizer.ts      ← aggregate results + evaluate goal completeness via LLM
    llm-client.ts       ← Gemini / OpenAI / Anthropic / Mock adapters + createAutoClient()
    tool-registry.ts    ← register, validate, and invoke tools
  utils/
    dag.ts              ← topologicalSort · validateDAG · isTaskReady
    events.ts           ← EventBus (on/onAll/emit) · createLogger
  index.ts              ← public API barrel export
examples/
  basic-run.ts          ← runnable demo (auto-selects LLM from env vars)
```

### Executor Tool-Use Loop

```
LLM prompt (task + context + available tools)
     │
     ▼
  ┌──────────────────────────────────────────┐
  │  round ≤ 10                              │
  │                                          │
  │  LLM responds with either:               │
  │                                          │
  │  [TOOL_CALL]                             │
  │  { "tool": "...", "params": {...} }       │  ──▶  ToolRegistry.execute()
  │  [/TOOL_CALL]                            │            │
  │              ◀───────────────────────────┤  [TOOL_RESULT] appended
  │                                          │
  │  or                                      │
  │                                          │
  │  [RESULT]                                │
  │  { "output": ..., "artifacts": {...} }   │  ──▶  TaskResult (exit loop)
  │  [/RESULT]                               │
  └──────────────────────────────────────────┘
```

---

## Installation

```bash
git clone <repo-url>
cd agent-framework
npm install
```

Requires Node.js ≥ 18 (ESM, `fetch` built-in).

---

## Quick Start

**Run the example with the mock LLM (no API key needed):**

```bash
npm run dev
```

**Run with a real LLM:**

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

The LLM provider is auto-selected by priority: Gemini → OpenAI → Anthropic → Mock. Tavily is optional — without it, web search falls back to the DuckDuckGo Instant Answer API.

Then run:

```bash
npm run dev
```

The example will summarize the three main benefits of TypeScript and print synthesis results and replan history.

---

## Usage

```typescript
import { Orchestrator, createAutoClient, createLogger } from "./src/index.js";

// Auto-selects provider: GEMINI_API_KEY → OPENAI_API_KEY → ANTHROPIC_API_KEY → Mock
const client = createAutoClient();

// Or construct a specific provider directly:
// const client = new GeminiClient(process.env.GEMINI_API_KEY!);
// const client = new OpenAIClient(process.env.OPENAI_API_KEY!);
// const client = new AnthropicClient(process.env.ANTHROPIC_API_KEY!);

const orchestrator = new Orchestrator(client, {
  maxConcurrency: 3,       // tasks running in parallel
  tokenBudget: 50_000,     // total tokens across the run
  maxReplanIterations: 3,  // max adaptive replanning cycles
});

// Register a custom tool
orchestrator.tools.register({
  name: "search_web",
  description: "Search the web for information on a topic",
  parameters: { query: "string" },
  execute: async ({ query }) => {
    // your implementation
    return { results: [`result for: ${query}`] };
  },
});

// Attach structured logging
orchestrator.events.onAll(createLogger(true));

// Run the pipeline
const result = await orchestrator.run(
  "Write a technical blog post about WebAssembly's impact on server-side development"
);

console.log(`Success:      ${result.success}`);
console.log(`Duration:     ${result.durationMs}ms`);
console.log(`Iterations:   ${result.totalIterations}`);
console.log(`Completeness: ${(result.synthesis!.completeness * 100).toFixed(0)}%`);
console.log(`Summary:      ${result.synthesis!.summary}`);

if (result.replanHistory.length > 0) {
  for (const rp of result.replanHistory) {
    console.log(`  Replan #${rp.iteration}: ${rp.reason}`);
  }
}
```

---

## Configuration Reference

| Field | Default | Description |
|-------|---------|-------------|
| `maxConcurrency` | `5` | Maximum tasks executing in parallel |
| `tokenBudget` | `100_000` | Total token budget for the entire run |
| `defaultMaxRetries` | `2` | Per-task retry attempts on failure |
| `taskTimeoutMs` | `60_000` | Timeout per task in milliseconds |
| `maxReplanIterations` | `3` | Maximum adaptive replan cycles |
| `llm.plannerModel` | *(provider default)* | Model for the Planner phase |
| `llm.executorModel` | *(provider default)* | Model for the Executor phase |
| `llm.synthesizerModel` | *(provider default)* | Model for the Synthesizer phase |

All fields are optional. When model names are omitted, each client falls back to its own default (see table below). You can also mix models per phase, e.g. use a faster model for the Executor and a smarter one for the Planner.

---

## LLM Providers

`createAutoClient()` detects available API keys and picks a provider automatically (Gemini → OpenAI → Anthropic → Mock). You can also construct a specific client directly.

| Priority | Provider | Class | Default Model | Environment Variable |
|----------|----------|-------|---------------|---------------------|
| 1 | Google Gemini | `GeminiClient` | `gemini-2.5-flash-lite` | `GEMINI_API_KEY` |
| 2 | OpenAI | `OpenAIClient` | `gpt-4o-mini` | `OPENAI_API_KEY` |
| 3 | Anthropic Claude | `AnthropicClient` | `claude-sonnet-4-20250514` | `ANTHROPIC_API_KEY` |
| 4 | Mock (testing) | `MockLLMClient` | — | — |

```typescript
// Auto-detect (recommended for most setups)
const client = createAutoClient();

// Explicit API key override (skips env var lookup)
const client = createAutoClient({
  openaiApiKey: "sk-...",  // forces OpenAI regardless of GEMINI_API_KEY
});

// Direct construction (full control)
const client = new OpenAIClient(process.env.OPENAI_API_KEY!, "https://api.openai.com");
```

The `MockLLMClient` accepts an optional handler function for full control over responses in tests:

```typescript
const client = new MockLLMClient((messages) => {
  if (messages.at(-1)?.content.includes("Create a task plan")) {
    return JSON.stringify({ tasks: [/* ... */] });
  }
  return '{ "output": "done" }';
});
```

---

## Built-in Tools

| Name | Description | Parameters |
|------|-------------|------------|
| `write_file` | Write text content to a file path | `path: string`, `content: string` |
| `read_file` | Read text content from a file path | `path: string` |
| `shell` | Execute a shell command (30s timeout) | `command: string`, `cwd?: string` |
| `store_memory` | Write a value to the shared run memory | `key: string`, `value: any` |
| `read_memory` | Read a value from the shared run memory | `key: string` |

Register additional tools via `orchestrator.tools.register(toolDefinition)`.

---

## Event System

Subscribe to lifecycle events for logging, metrics, or external integrations:

```typescript
// Subscribe to a specific event type
const unsub = orchestrator.events.on("task:completed", (event) => {
  console.log(`Task ${event.taskId} done in ${event.result.durationMs}ms`);
});

// Subscribe to all events
orchestrator.events.onAll(createLogger(verbose));

// Unsubscribe
unsub();
```

**Event types:**

| Event | Payload |
|-------|---------|
| `run:started` | `runId`, `goal` |
| `plan:created` | `runId`, `plan` |
| `task:ready` | `runId`, `taskId` |
| `task:started` | `runId`, `taskId`, `description` |
| `task:completed` | `runId`, `taskId`, `result` |
| `task:failed` | `runId`, `taskId`, `error` |
| `task:retry` | `runId`, `taskId`, `attempt` |
| `synthesis:started` | `runId` |
| `synthesis:completed` | `runId`, `output` |
| `replan:triggered` | `runId`, `reason` |
| `run:completed` | `runId`, `success` |

---

## Scripts

```
npm run dev          Run examples/basic-run.ts (mock LLM unless API key set)
npm run build        Compile TypeScript → dist/
npm run typecheck    Type-check without emitting output
npm test             Run test suite (vitest)
npm run test:watch   Watch mode for development
```

---

## Project Structure

```
agent-framework/
├── src/
│   ├── types/
│   │   └── index.ts              Core type definitions
│   ├── core/
│   │   ├── orchestrator.ts       Main control plane
│   │   ├── planner.ts            Goal → task DAG
│   │   ├── executor.ts           Per-task agentic loop
│   │   ├── synthesizer.ts        Result aggregation & QA
│   │   ├── llm-client.ts         LLM provider adapters + createAutoClient
│   │   ├── tool-registry.ts      Tool management
│   │   └── __tests__/
│   │       ├── llm-client.test.ts
│   │       ├── orchestrator.test.ts
│   │       └── replan.test.ts
│   ├── utils/
│   │   ├── dag.ts                Topological sort & DAG validation
│   │   ├── events.ts             Event bus & logger
│   │   └── __tests__/
│   │       └── dag.test.ts
│   └── index.ts                  Public API exports
├── examples/
│   └── basic-run.ts              Runnable demo
├── package.json
└── tsconfig.json
```
