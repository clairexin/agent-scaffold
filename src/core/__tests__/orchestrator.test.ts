import { describe, it, expect } from "vitest";
import { Orchestrator } from "../orchestrator.js";
import { MockLLMClient } from "../llm-client.js";
import type { LLMMessage } from "../llm-client.js";

function createMockClient(): MockLLMClient {
  return new MockLLMClient((messages: LLMMessage[]) => {
    const lastMsg = messages[messages.length - 1].content;

    if (lastMsg.includes("Create a task plan") || lastMsg.includes("REVISED plan")) {
      return JSON.stringify({
        tasks: [
          { id: "t1", description: "Step one", dependencies: [], toolsNeeded: [], estimatedTokens: 100 },
          { id: "t2", description: "Step two", dependencies: ["t1"], toolsNeeded: [], estimatedTokens: 100 },
        ],
      });
    }

    if (lastMsg.includes("Synthesize these results")) {
      return JSON.stringify({
        output: "Done",
        goalSatisfied: true,
        completeness: 0.95,
        conflicts: [],
        missingElements: [],
        summary: "All done",
      });
    }

    if (lastMsg.includes("## Task:") || lastMsg.includes("[RESULT]")) {
      return '[RESULT]\n{"output": "completed", "artifacts": {}}\n[/RESULT]';
    }

    return '{"output": "default"}';
  });
}

describe("Orchestrator", () => {
  it("runs the full pipeline and returns success", async () => {
    const orch = new Orchestrator(createMockClient(), { tokenBudget: 50_000 });
    const result = await orch.run("Test goal");

    expect(result.success).toBe(true);
    expect(result.plan.tasks.length).toBe(2);
    expect(result.synthesis?.goalSatisfied).toBe(true);
    expect(result.totalIterations).toBe(1);
    expect(result.replanHistory).toHaveLength(0);
  });

  it("tracks token usage across the run", async () => {
    const orch = new Orchestrator(createMockClient(), { tokenBudget: 50_000 });
    const result = await orch.run("Token tracking test");

    expect(result.context.tokenBudget.used).toBeGreaterThan(0);
    expect(result.context.tokenBudget.remaining).toBeLessThan(50_000);
  });

  it("records events during execution", async () => {
    const events: string[] = [];
    const orch = new Orchestrator(createMockClient(), { tokenBudget: 50_000 });
    orch.events.onAll((e) => events.push(e.type));

    await orch.run("Event test");

    expect(events).toContain("run:started");
    expect(events).toContain("plan:created");
    expect(events).toContain("task:started");
    expect(events).toContain("task:completed");
    expect(events).toContain("synthesis:started");
    expect(events).toContain("synthesis:completed");
    expect(events).toContain("run:completed");
  });
});
