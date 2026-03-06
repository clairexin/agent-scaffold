// ─────────────────────────────────────────────
// Synthesizer — Results Aggregation & Quality Gate
// ─────────────────────────────────────────────

import { RunContext, PlatformConfig, TaskResult } from "../types/index.js";
import { LLMClient } from "./llm-client.js";

const SYNTHESIZER_SYSTEM_PROMPT = `You are a synthesis agent. You receive the original goal and results from multiple completed tasks.

Your job:
1. Combine all task results into a coherent final output
2. Resolve any conflicts between task results
3. Evaluate whether the combined output fully satisfies the original goal
4. Flag anything missing or incomplete

Output ONLY valid JSON:
{
  "output": "The synthesized final result (can be a string or structured object)",
  "goalSatisfied": true/false,
  "completeness": 0.0-1.0,
  "conflicts": ["any conflicts found between task results"],
  "missingElements": ["anything still needed to fully satisfy the goal"],
  "summary": "Brief summary of what was accomplished"
}`;

export interface SynthesisResult {
  output: unknown;
  goalSatisfied: boolean;
  completeness: number;
  conflicts: string[];
  missingElements: string[];
  summary: string;
  tokensUsed: number;
}

export class Synthesizer {
  constructor(
    private llm: LLMClient,
    private config: PlatformConfig
  ) {}

  /**
   * Synthesize all task results into a final output.
   */
  async synthesize(ctx: RunContext): Promise<SynthesisResult> {
    const taskSummaries = Object.entries(ctx.results)
      .map(([taskId, result]) => {
        return [
          `### Task: ${taskId}`,
          `Status: ${result.status}`,
          `Output: ${JSON.stringify(result.output, null, 2)}`,
          result.artifacts
            ? `Artifacts: ${JSON.stringify(result.artifacts, null, 2)}`
            : null,
          result.error ? `Error: ${result.error}` : null,
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n---\n\n");

    const memoryDump =
      Object.keys(ctx.memory).length > 0
        ? `\n## Shared Memory:\n${JSON.stringify(ctx.memory, null, 2)}`
        : "";

    const response = await this.llm.complete(
      [
        { role: "system", content: SYNTHESIZER_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `## Original Goal:\n${ctx.goal}`,
            `\n## Task Results:\n${taskSummaries}`,
            memoryDump,
            `\n## Token Budget:\nUsed: ${ctx.tokenBudget.used} / ${ctx.tokenBudget.total}`,
            `\nSynthesize these results into a coherent final output.`,
          ].join("\n"),
        },
      ],
      {
        model: this.config.llm.synthesizerModel,
        temperature: 0.1,
        responseFormat: "json",
      }
    );

    const cleaned = response.content.replace(/```json\n?|```\n?/g, "").trim();

    try {
      const parsed = JSON.parse(cleaned);
      return {
        output: parsed.output,
        goalSatisfied: parsed.goalSatisfied ?? false,
        completeness: parsed.completeness ?? 0,
        conflicts: parsed.conflicts ?? [],
        missingElements: parsed.missingElements ?? [],
        summary: parsed.summary ?? "",
        tokensUsed: response.tokensUsed.total,
      };
    } catch (e: any) {
      return {
        output: response.content,
        goalSatisfied: false,
        completeness: 0,
        conflicts: [],
        missingElements: ["Failed to parse synthesis result"],
        summary: "Synthesis produced unparseable output",
        tokensUsed: response.tokensUsed.total,
      };
    }
  }
}
