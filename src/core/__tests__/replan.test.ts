import { describe, it, expect } from "vitest";
import { Orchestrator } from "../orchestrator.js";
import { MockLLMClient } from "../llm-client.js";
import type { LLMMessage } from "../llm-client.js";

describe("Replan loop", () => {
  it("replans when completeness is below threshold", async () => {
    let synthesisCallCount = 0;

    const client = new MockLLMClient((messages: LLMMessage[]) => {
      const lastMsg = messages[messages.length - 1].content;

      if (lastMsg.includes("Create a task plan") || lastMsg.includes("REVISED plan")) {
        return JSON.stringify({
          tasks: [
            { id: "t1", description: "Do it", dependencies: [], toolsNeeded: [], estimatedTokens: 50 },
          ],
        });
      }

      if (lastMsg.includes("Synthesize these results")) {
        synthesisCallCount++;
        if (synthesisCallCount <= 1) {
          return JSON.stringify({
            output: "Partial",
            goalSatisfied: false,
            completeness: 0.3,
            conflicts: [],
            missingElements: ["more work needed"],
            summary: "Partial",
          });
        }
        return JSON.stringify({
          output: "Full",
          goalSatisfied: true,
          completeness: 1.0,
          conflicts: [],
          missingElements: [],
          summary: "Done",
        });
      }

      return '[RESULT]\n{"output": "ok"}\n[/RESULT]';
    });

    const orch = new Orchestrator(client, {
      tokenBudget: 100_000,
      maxReplanIterations: 3,
    });
    const result = await orch.run("Replan test");

    expect(result.success).toBe(true);
    expect(result.replanHistory).toHaveLength(1);
    expect(result.totalIterations).toBe(2);
  });

  it("respects maxReplanIterations limit", async () => {
    const client = new MockLLMClient((messages: LLMMessage[]) => {
      const lastMsg = messages[messages.length - 1].content;

      if (lastMsg.includes("task plan") || lastMsg.includes("REVISED plan")) {
        return JSON.stringify({
          tasks: [
            { id: "t1", description: "Do it", dependencies: [], toolsNeeded: [], estimatedTokens: 10 },
          ],
        });
      }

      if (lastMsg.includes("Synthesize")) {
        return JSON.stringify({
          output: null,
          goalSatisfied: false,
          completeness: 0.1,
          conflicts: [],
          missingElements: ["still broken"],
          summary: "Bad",
        });
      }

      return '[RESULT]\n{"output": "ok"}\n[/RESULT]';
    });

    const orch = new Orchestrator(client, {
      tokenBudget: 1_000_000,
      maxReplanIterations: 2,
    });
    const result = await orch.run("Bounded replan test");

    expect(result.success).toBe(false);
    expect(result.replanHistory).toHaveLength(2);
    expect(result.totalIterations).toBe(3);
  });

  it("does not replan when goal is satisfied", async () => {
    const client = new MockLLMClient((messages: LLMMessage[]) => {
      const lastMsg = messages[messages.length - 1].content;

      if (lastMsg.includes("task plan")) {
        return JSON.stringify({
          tasks: [{ id: "t1", description: "Do it", dependencies: [], toolsNeeded: [] }],
        });
      }

      if (lastMsg.includes("Synthesize")) {
        return JSON.stringify({
          output: "Done",
          goalSatisfied: true,
          completeness: 1.0,
          conflicts: [],
          missingElements: [],
          summary: "Perfect",
        });
      }

      return '[RESULT]\n{"output": "ok"}\n[/RESULT]';
    });

    const orch = new Orchestrator(client, { tokenBudget: 50_000 });
    const result = await orch.run("No replan needed");

    expect(result.success).toBe(true);
    expect(result.replanHistory).toHaveLength(0);
    expect(result.totalIterations).toBe(1);
  });
});
