// ─────────────────────────────────────────────
// Orchestrator — The Control Plane
// ─────────────────────────────────────────────

import {
  Plan,
  Task,
  TaskStatus,
  RunContext,
  PlatformConfig,
  PlatformEvent,
  RunId,
  TaskId,
} from "../types/index.js";
import { Planner } from "./planner.js";
import { Executor } from "./executor.js";
import { Synthesizer, SynthesisResult } from "./synthesizer.js";
import { LLMClient } from "./llm-client.js";
import { ToolRegistry, createBuiltinTools } from "./tool-registry.js";
import { EventBus } from "../utils/events.js";
import { randomUUID } from "crypto";

export interface ReplanRecord {
  iteration: number;
  reason: string;
  plan: Plan;
  synthesis: SynthesisResult;
}

export interface RunResult {
  runId: RunId;
  success: boolean;
  plan: Plan;
  synthesis: SynthesisResult | null;
  context: RunContext;
  durationMs: number;
  replanHistory: ReplanRecord[];
  totalIterations: number;
}

const DEFAULT_CONFIG: PlatformConfig = {
  maxConcurrency: 5,
  tokenBudget: 100_000,
  defaultMaxRetries: 2,
  taskTimeoutMs: 60_000,
  maxReplanIterations: 3,
  // Model names are intentionally omitted here so each LLM client uses its own
  // built-in default (gemini-2.5-flash, gpt-4o-mini, claude-sonnet-4-20250514).
  // Override per-phase via config.llm.{plannerModel,executorModel,synthesizerModel}.
  llm: {},
};

export class Orchestrator {
  private planner: Planner;
  private executor: Executor;
  private synthesizer: Synthesizer;
  private toolRegistry: ToolRegistry;
  public events: EventBus;
  private config: PlatformConfig;

  constructor(llm: LLMClient, config?: Partial<PlatformConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      llm: { ...DEFAULT_CONFIG.llm, ...(config?.llm ?? {}) },
    };
    this.events = new EventBus();
    this.toolRegistry = new ToolRegistry();

    // Register built-in tools
    for (const tool of createBuiltinTools()) {
      this.toolRegistry.register(tool);
    }

    // Initialize modules
    this.planner = new Planner(llm, this.toolRegistry, this.config);
    this.executor = new Executor(llm, this.toolRegistry, this.config);
    this.synthesizer = new Synthesizer(llm, this.config);
  }

  /** Access the tool registry to add custom tools */
  get tools(): ToolRegistry {
    return this.toolRegistry;
  }

  /**
   * Run the full pipeline: Plan → Execute → Synthesize
   */
  async run(goal: string): Promise<RunResult> {
    const runId = randomUUID() as RunId;
    const startTime = Date.now();

    this.emit({ type: "run:started", runId, goal });

    // Initialize run context
    const ctx: RunContext = {
      runId,
      goal,
      results: {},
      memory: {},
      tokenBudget: {
        total: this.config.tokenBudget,
        used: 0,
        remaining: this.config.tokenBudget,
      },
    };

    // ── Phase 1: Planning ──────────────────────────
    let plan: Plan;
    try {
      plan = await this.planner.createPlan(goal, runId);
      this.emit({ type: "plan:created", runId, plan });
    } catch (e: any) {
      this.emit({ type: "run:completed", runId, success: false });
      return {
        runId,
        success: false,
        plan: { runId, goal, tasks: [], executionOrder: [], createdAt: new Date() },
        synthesis: null,
        context: ctx,
        durationMs: Date.now() - startTime,
        replanHistory: [],
        totalIterations: 0,
      };
    }

    // ── Phase 2: Execution ─────────────────────────
    await this.executePlan(plan, ctx);

    // ── Phase 3: Synthesis ─────────────────────────
    this.emit({ type: "synthesis:started", runId });

    let synthesis: SynthesisResult;
    try {
      synthesis = await this.synthesizer.synthesize(ctx);
      ctx.tokenBudget.used += synthesis.tokensUsed;
      ctx.tokenBudget.remaining = ctx.tokenBudget.total - ctx.tokenBudget.used;
      this.emit({ type: "synthesis:completed", runId, output: synthesis.output });
    } catch (e: any) {
      synthesis = {
        output: null,
        goalSatisfied: false,
        completeness: 0,
        conflicts: [],
        missingElements: ["Synthesis failed: " + e.message],
        summary: "Synthesis failed",
        tokensUsed: 0,
      };
    }

    // ── Phase 4: Re-plan loop ─────────────────────
    const replanHistory: ReplanRecord[] = [];
    let currentPlan = plan;
    let iteration = 0;

    while (
      iteration < this.config.maxReplanIterations &&
      !synthesis.goalSatisfied &&
      synthesis.completeness < 0.7 &&
      ctx.tokenBudget.remaining > ctx.tokenBudget.total * 0.2
    ) {
      iteration++;
      const reason = `Completeness ${synthesis.completeness}, missing: ${synthesis.missingElements.join(", ")}`;

      this.emit({ type: "replan:triggered", runId, reason });

      try {
        const revisedPlan = await this.planner.replan(
          currentPlan,
          ctx.results,
          synthesis.missingElements.join("; ")
        );
        this.emit({ type: "plan:created", runId, plan: revisedPlan });
        await this.executePlan(revisedPlan, ctx);

        // Re-synthesize
        this.emit({ type: "synthesis:started", runId });
        const newSynthesis = await this.synthesizer.synthesize(ctx);
        ctx.tokenBudget.used += newSynthesis.tokensUsed;
        ctx.tokenBudget.remaining = ctx.tokenBudget.total - ctx.tokenBudget.used;
        this.emit({ type: "synthesis:completed", runId, output: newSynthesis.output });

        replanHistory.push({ iteration, reason, plan: revisedPlan, synthesis: newSynthesis });
        synthesis = newSynthesis;
        currentPlan = revisedPlan;
      } catch (e: any) {
        console.error(`[Orchestrator] Replan iteration ${iteration} failed: ${e.message}`);
        break;
      }
    }

    const success =
      synthesis.goalSatisfied || synthesis.completeness >= 0.7;
    this.emit({ type: "run:completed", runId, success });

    return {
      runId,
      success,
      plan: currentPlan,
      synthesis,
      context: ctx,
      durationMs: Date.now() - startTime,
      replanHistory,
      totalIterations: 1 + iteration,
    };
  }

  /**
   * Execute all tasks in a plan, respecting dependencies and concurrency.
   */
  private async executePlan(plan: Plan, ctx: RunContext): Promise<void> {
    for (const group of plan.executionOrder) {
      // Each group is a set of independent tasks that can run in parallel
      const tasks = group
        .map((id) => plan.tasks.find((t) => t.id === id))
        .filter((t): t is Task => t !== undefined);

      // Mark tasks as ready
      for (const task of tasks) {
        task.status = TaskStatus.Ready;
        this.emit({ type: "task:ready", runId: ctx.runId, taskId: task.id });
      }

      // Execute with concurrency limit
      const results = await this.executeWithConcurrency(tasks, ctx);

      // Process results
      for (const result of results) {
        ctx.results[result.taskId] = result;
        ctx.tokenBudget.used += result.tokensUsed ?? 0;
        ctx.tokenBudget.remaining = ctx.tokenBudget.total - ctx.tokenBudget.used;

        const task = plan.tasks.find((t) => t.id === result.taskId);
        if (task) {
          task.status =
            result.status === "success" ? TaskStatus.Success : TaskStatus.Failed;
          task.result = result;
        }
      }
    }
  }

  /**
   * Run tasks in parallel with a concurrency limit.
   */
  private async executeWithConcurrency(
    tasks: Task[],
    ctx: RunContext
  ): Promise<import("../types/index.js").TaskResult[]> {
    const results: import("../types/index.js").TaskResult[] = [];
    const executing = new Set<Promise<void>>();

    for (const task of tasks) {
      // Check token budget
      if (ctx.tokenBudget.remaining <= 0) {
        results.push({
          taskId: task.id,
          status: "failed",
          output: null,
          error: "Token budget exhausted",
          tokensUsed: 0,
          durationMs: 0,
        });
        continue;
      }

      const promise = (async () => {
        task.status = TaskStatus.Running;
        this.emit({ type: "task:started", runId: ctx.runId, taskId: task.id, description: task.description });

        let result = await this.executeWithRetry(task, ctx);
        results.push(result);

        if (result.status === "success") {
          this.emit({
            type: "task:completed",
            runId: ctx.runId,
            taskId: task.id,
            result,
          });
        } else {
          this.emit({
            type: "task:failed",
            runId: ctx.runId,
            taskId: task.id,
            error: result.error ?? "Unknown error",
          });
        }
      })();

      executing.add(promise);
      promise.finally(() => executing.delete(promise));

      // Enforce concurrency limit
      if (executing.size >= this.config.maxConcurrency) {
        await Promise.race(executing);
      }
    }

    // Wait for remaining
    await Promise.all(executing);
    return results;
  }

  /**
   * Execute a task with retry logic.
   */
  private async executeWithRetry(
    task: Task,
    ctx: RunContext
  ): Promise<import("../types/index.js").TaskResult> {
    for (let attempt = 0; attempt <= task.maxRetries; attempt++) {
      if (attempt > 0) {
        task.retryCount = attempt;
        this.emit({
          type: "task:retry",
          runId: ctx.runId,
          taskId: task.id,
          attempt,
        });
      }

      try {
        const result = await Promise.race([
          this.executor.execute(task, ctx),
          this.timeout(this.config.taskTimeoutMs, task.id),
        ]);

        if (result.status === "success") return result;
        if (attempt === task.maxRetries) return result;
      } catch (e: any) {
        if (attempt === task.maxRetries) {
          return {
            taskId: task.id,
            status: "failed",
            output: null,
            error: e.message,
            tokensUsed: 0,
            durationMs: 0,
          };
        }
      }
    }

    // Shouldn't reach here, but just in case
    return {
      taskId: task.id,
      status: "failed",
      output: null,
      error: "Exhausted retries",
      tokensUsed: 0,
      durationMs: 0,
    };
  }

  private timeout(
    ms: number,
    taskId: TaskId
  ): Promise<import("../types/index.js").TaskResult> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Task ${taskId} timed out after ${ms}ms`)), ms)
    );
  }

  private emit(event: PlatformEvent): void {
    this.events.emit(event);
  }
}
