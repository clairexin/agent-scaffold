// ─────────────────────────────────────────────
// Agent Framework — Type Definitions
// ─────────────────────────────────────────────

/** Unique identifiers */
export type TaskId = string;
export type RunId = string;
export type ToolName = string;

/** Task lifecycle states */
export enum TaskStatus {
  Pending = "pending",
  Ready = "ready",
  Running = "running",
  Success = "success",
  Failed = "failed",
  Retry = "retry",
  Skipped = "skipped",
}

/** A single task within an execution plan */
export interface Task {
  id: TaskId;
  description: string;
  dependencies: TaskId[];
  toolsNeeded: ToolName[];
  estimatedTokens?: number;
  status: TaskStatus;
  result?: TaskResult;
  retryCount: number;
  maxRetries: number;
  metadata?: Record<string, unknown>;
}

/** Output produced by a task executor */
export interface TaskResult {
  taskId: TaskId;
  status: "success" | "failed";
  output: unknown;
  /** Structured data other tasks can consume */
  artifacts?: Record<string, unknown>;
  error?: string;
  tokensUsed?: number;
  durationMs?: number;
}

/** The execution plan produced by the Planner */
export interface Plan {
  runId: RunId;
  goal: string;
  tasks: Task[];
  /** Groups of task IDs that can run in parallel — topological ordering */
  executionOrder: TaskId[][];
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

/** Shared scratchpad available to all tasks in a run */
export interface RunContext {
  runId: RunId;
  goal: string;
  /** Accumulated results keyed by taskId */
  results: Record<TaskId, TaskResult>;
  /** Shared key-value scratchpad for cross-task communication */
  memory: Record<string, unknown>;
  /** Token budget tracking */
  tokenBudget: {
    total: number;
    used: number;
    remaining: number;
  };
}

/** Tool definition that executors can invoke */
export interface ToolDefinition {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>, ctx: RunContext) => Promise<unknown>;
}

/** Configuration for the agent framework */
export interface FrameworkConfig {
  /** Max tasks to run concurrently */
  maxConcurrency: number;
  /** Total token budget per run */
  tokenBudget: number;
  /** Max retries per task */
  defaultMaxRetries: number;
  /** Timeout per task in ms */
  taskTimeoutMs: number;
  /** Maximum number of replan iterations (default: 3) */
  maxReplanIterations: number;
  /** LLM provider configuration */
  llm: {
    /** Model for the Planner phase. Defaults to provider's default model if not set. */
    plannerModel?: string;
    /** Model for the Executor phase. Defaults to provider's default model if not set. */
    executorModel?: string;
    /** Model for the Synthesizer phase. Defaults to provider's default model if not set. */
    synthesizerModel?: string;
  };
}

/** Events emitted by the orchestrator */
export type FrameworkEvent =
  | { type: "run:started"; runId: RunId; goal: string }
  | { type: "plan:created"; runId: RunId; plan: Plan }
  | { type: "task:ready"; runId: RunId; taskId: TaskId }
  | { type: "task:started"; runId: RunId; taskId: TaskId; description: string }
  | { type: "task:completed"; runId: RunId; taskId: TaskId; result: TaskResult }
  | { type: "task:failed"; runId: RunId; taskId: TaskId; error: string }
  | { type: "task:retry"; runId: RunId; taskId: TaskId; attempt: number }
  | { type: "synthesis:started"; runId: RunId }
  | { type: "synthesis:completed"; runId: RunId; output: unknown }
  | { type: "run:completed"; runId: RunId; success: boolean }
  | { type: "replan:triggered"; runId: RunId; reason: string };

export type EventHandler = (event: FrameworkEvent) => void;
