// ─────────────────────────────────────────────
// Planner — Goal → Task DAG
// ─────────────────────────────────────────────

import { Plan, Task, TaskStatus, FrameworkConfig, RunId } from "../types/index.js";
import { LLMClient } from "./llm-client.js";
import { ToolRegistry } from "./tool-registry.js";
import { topologicalSort, validateDAG } from "../utils/dag.js";

const PLANNER_SYSTEM_PROMPT = `You are a planning agent. Given a goal and available tools, decompose the goal into discrete tasks.

Output ONLY valid JSON with this structure:
{
  "tasks": [
    {
      "id": "t1",
      "description": "Clear description of what this task should accomplish",
      "dependencies": [],
      "toolsNeeded": ["tool_name"],
      "estimatedTokens": 500
    },
    {
      "id": "t2",
      "description": "Another task that depends on t1",
      "dependencies": ["t1"],
      "toolsNeeded": [],
      "estimatedTokens": 300
    }
  ]
}

Rules:
- Task IDs must be short strings (t1, t2, t3, etc.)
- Dependencies reference other task IDs — a task only runs after its deps complete
- Use dependencies to express ordering; independent tasks can run in parallel
- Each task should be a single, coherent unit of work
- Prefer more granular tasks over fewer large ones
- estimatedTokens is your best guess at LLM tokens needed
- toolsNeeded lists the tools the executor will need for this task
- No circular dependencies allowed`;

export class Planner {
  constructor(
    private llm: LLMClient,
    private toolRegistry: ToolRegistry,
    private config: FrameworkConfig
  ) {}

  /**
   * Generate an execution plan from a goal string.
   */
  async createPlan(goal: string, runId: RunId): Promise<Plan> {
    const toolDescriptions = this.toolRegistry.getToolDescriptions();

    const response = await this.llm.complete(
      [
        { role: "system", content: PLANNER_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Goal: ${goal}\n\nAvailable tools:\n${toolDescriptions}\n\nCreate a task plan.`,
        },
      ],
      {
        model: this.config.llm.plannerModel,
        temperature: 0.2,
        responseFormat: "json",
      }
    );

    // Parse LLM output
    const parsed = this.parsePlanResponse(response.content);

    // Build Task objects
    const tasks: Task[] = parsed.tasks.map((t: any) => ({
      id: t.id,
      description: t.description,
      dependencies: t.dependencies ?? [],
      toolsNeeded: t.toolsNeeded ?? [],
      estimatedTokens: t.estimatedTokens,
      status: TaskStatus.Pending,
      retryCount: 0,
      maxRetries: this.config.defaultMaxRetries,
    }));

    // Validate the DAG
    const validation = validateDAG(tasks);
    if (!validation.valid) {
      throw new Error(`Invalid plan DAG: ${validation.errors.join("; ")}`);
    }

    // Compute execution order
    const executionOrder = topologicalSort(tasks);

    return {
      runId,
      goal,
      tasks,
      executionOrder,
      createdAt: new Date(),
    };
  }

  /**
   * Re-plan: given partial results and a failure reason, produce a revised plan.
   */
  async replan(
    originalPlan: Plan,
    completedResults: Record<string, unknown>,
    failureReason: string
  ): Promise<Plan> {
    const response = await this.llm.complete(
      [
        { role: "system", content: PLANNER_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `Original goal: ${originalPlan.goal}`,
            `\nCompleted task results:\n${JSON.stringify(completedResults, null, 2)}`,
            `\nFailure reason: ${failureReason}`,
            `\nAvailable tools:\n${this.toolRegistry.getToolDescriptions()}`,
            `\nCreate a REVISED plan that accounts for what's already done and addresses the failure.`,
          ].join("\n"),
        },
      ],
      {
        model: this.config.llm.plannerModel,
        temperature: 0.3,
        responseFormat: "json",
      }
    );

    const parsed = this.parsePlanResponse(response.content);

    const tasks: Task[] = parsed.tasks.map((t: any) => ({
      id: t.id,
      description: t.description,
      dependencies: t.dependencies ?? [],
      toolsNeeded: t.toolsNeeded ?? [],
      estimatedTokens: t.estimatedTokens,
      status: TaskStatus.Pending,
      retryCount: 0,
      maxRetries: this.config.defaultMaxRetries,
    }));

    const validation = validateDAG(tasks);
    if (!validation.valid) {
      throw new Error(`Invalid replan DAG: ${validation.errors.join("; ")}`);
    }

    return {
      runId: originalPlan.runId,
      goal: originalPlan.goal,
      tasks,
      executionOrder: topologicalSort(tasks),
      createdAt: new Date(),
      metadata: { replan: true, originalTaskCount: originalPlan.tasks.length },
    };
  }

  private parsePlanResponse(content: string): { tasks: any[] } {
    // Strip markdown fences if present
    const cleaned = content.replace(/```json\n?|```\n?/g, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
        throw new Error("Plan response missing 'tasks' array");
      }
      return parsed;
    } catch (e: any) {
      throw new Error(`Failed to parse plan response: ${e.message}\nRaw: ${content.slice(0, 500)}`);
    }
  }
}
