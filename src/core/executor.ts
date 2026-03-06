// ─────────────────────────────────────────────
// Executor — Runs Individual Tasks
// ─────────────────────────────────────────────

import { Task, TaskResult, RunContext, PlatformConfig } from "../types/index.js";
import { LLMClient } from "./llm-client.js";
import { ToolRegistry } from "./tool-registry.js";

const EXECUTOR_SYSTEM_PROMPT = `You are a task executor agent. You receive a specific task to complete, along with context from prior tasks.

You have access to tools. To use a tool, output a JSON block:
[TOOL_CALL]
{"tool": "tool_name", "params": {"key": "value"}}
[/TOOL_CALL]

After receiving tool results, continue reasoning and either use another tool or produce your final output.

When you're done, output your final result as:
[RESULT]
{"output": "your result here", "artifacts": {"key": "value"}}
[/RESULT]

Rules:
- Focus ONLY on the specific task assigned to you
- Use upstream task results as context when available
- Be concise and produce structured output
- If a tool call fails, try an alternative approach
- Always end with a [RESULT] block`;

/** Maximum tool-use rounds before forcing completion */
const MAX_TOOL_ROUNDS = 10;

const RESULT_REGEX = /\[RESULT\]\s*([\s\S]*?)\s*\[\/RESULT\]/;
const TOOL_CALL_REGEX = /\[TOOL_CALL\]\s*([\s\S]*?)\s*\[\/TOOL_CALL\]/;

export class Executor {
  constructor(
    private llm: LLMClient,
    private toolRegistry: ToolRegistry,
    private config: PlatformConfig
  ) {}

  /**
   * Execute a single task with agentic tool-use loop.
   */
  async execute(task: Task, ctx: RunContext): Promise<TaskResult> {
    const startTime = Date.now();
    let totalTokens = 0;

    // Build context from upstream results
    const upstreamContext = task.dependencies
      .map((depId) => {
        const result = ctx.results[depId];
        if (!result) return null;
        return `[Task ${depId} output]: ${JSON.stringify(result.output)}`;
      })
      .filter(Boolean)
      .join("\n\n");

    // Available tools for this task
    const availableTools = task.toolsNeeded.length > 0
      ? task.toolsNeeded
          .map((name) => {
            const tool = this.toolRegistry.get(name);
            return tool ? `- ${tool.name}: ${tool.description}` : null;
          })
          .filter(Boolean)
          .join("\n")
      : this.toolRegistry.getToolDescriptions();

    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: EXECUTOR_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `## Task: ${task.description}`,
          upstreamContext ? `\n## Context from prior tasks:\n${upstreamContext}` : "",
          `\n## Available tools:\n${availableTools}`,
          ctx.memory && Object.keys(ctx.memory).length > 0
            ? `\n## Shared memory:\n${JSON.stringify(ctx.memory, null, 2)}`
            : "",
          `\n## Instructions:\nComplete the task above. Use tools if needed, then provide your result.`,
        ].join("\n"),
      },
    ];

    // Agentic tool-use loop
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.llm.complete(messages, {
        model: this.config.llm.executorModel,
        temperature: 0.1,
      });
      totalTokens += response.tokensUsed.total;

      const content = response.content;
      messages.push({ role: "assistant", content });

      // Check for final result
      const resultMatch = content.match(RESULT_REGEX);
      if (resultMatch) {
        try {
          const parsed = JSON.parse(resultMatch[1]);
          return {
            taskId: task.id,
            status: "success",
            output: parsed.output,
            artifacts: parsed.artifacts,
            tokensUsed: totalTokens,
            durationMs: Date.now() - startTime,
          };
        } catch {
          // If result isn't valid JSON, use the raw text
          return {
            taskId: task.id,
            status: "success",
            output: resultMatch[1].trim(),
            tokensUsed: totalTokens,
            durationMs: Date.now() - startTime,
          };
        }
      }

      // Check for tool calls
      const toolMatch = content.match(TOOL_CALL_REGEX);
      if (toolMatch) {
        try {
          const { tool, params } = JSON.parse(toolMatch[1]);
          const toolResult = await this.toolRegistry.execute(tool, params, ctx);
          messages.push({
            role: "user",
            content: `[TOOL_RESULT]\n${JSON.stringify(toolResult, null, 2)}\n[/TOOL_RESULT]`,
          });
        } catch (e: any) {
          messages.push({
            role: "user",
            content: `[TOOL_ERROR] ${e.message} [/TOOL_ERROR]`,
          });
        }
        continue;
      }

      // No tool call or result — ask model to produce a result
      messages.push({
        role: "user",
        content: "Please provide your final result in a [RESULT] block.",
      });
    }

    // Exhausted tool rounds — return what we have
    return {
      taskId: task.id,
      status: "failed",
      output: null,
      error: `Executor exceeded max tool rounds (${MAX_TOOL_ROUNDS})`,
      tokensUsed: totalTokens,
      durationMs: Date.now() - startTime,
    };
  }
}
