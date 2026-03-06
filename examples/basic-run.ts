// ─────────────────────────────────────────────
// Example Usage — Agent Platform
// ─────────────────────────────────────────────
//
// Run with: npx tsx examples/basic-run.ts
//
// For real usage, set one of these env vars (checked in priority order):
//   GEMINI_API_KEY      → Google Gemini (gemini-2.5-flash)
//   OPENAI_API_KEY      → OpenAI (gpt-4o-mini)
//   ANTHROPIC_API_KEY   → Anthropic Claude (claude-sonnet-4-20250514)
// This example uses the MockLLMClient when no key is present.

import {
  Orchestrator,
  MockLLMClient,
  createAutoClient,
  createLogger,
  type LLMClient,
  type LLMMessage,
} from "../src/index.js";

// ─── Choose your LLM client ──────────────────
// Priority: GEMINI_API_KEY → OPENAI_API_KEY → ANTHROPIC_API_KEY → Mock

function createClient(): LLMClient {
  if (process.env.GEMINI_API_KEY) {
    console.log("Using Gemini API (gemini-2.5-flash)");
    return createAutoClient();
  }

  if (process.env.OPENAI_API_KEY) {
    console.log("Using OpenAI API (gpt-4o-mini)");
    return createAutoClient();
  }

  if (process.env.ANTHROPIC_API_KEY) {
    console.log("Using Anthropic API (claude-sonnet-4-20250514)");
    return createAutoClient();
  }

  console.log("Using Mock LLM (set GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY for real runs)");
  return new MockLLMClient((messages: LLMMessage[]) => {
    const lastMsg = messages[messages.length - 1].content;

    // Mock planner response
    if (lastMsg.includes("Create a task plan") || lastMsg.includes("REVISED plan")) {
      return JSON.stringify({
        tasks: [
          {
            id: "t1",
            description: "Research the topic and gather key facts",
            dependencies: [],
            toolsNeeded: ["store_memory"],
            estimatedTokens: 500,
          },
          {
            id: "t2",
            description: "Create an outline based on research",
            dependencies: ["t1"],
            toolsNeeded: ["read_memory"],
            estimatedTokens: 300,
          },
          {
            id: "t3",
            description: "Write the final content from the outline",
            dependencies: ["t2"],
            toolsNeeded: ["write_file"],
            estimatedTokens: 800,
          },
        ],
      });
    }

    // Mock synthesizer response (check BEFORE executor since both contain "Task")
    if (lastMsg.includes("Synthesize these results")) {
      return JSON.stringify({
        output: "All tasks completed. Final synthesized result.",
        goalSatisfied: true,
        completeness: 0.95,
        conflicts: [],
        missingElements: [],
        summary: "Successfully decomposed and executed all tasks.",
      });
    }

    // Mock executor response
    if (lastMsg.includes("## Task:") || lastMsg.includes("[RESULT]")) {
      return `I've completed the task.\n[RESULT]\n{"output": "Task completed successfully with mock data", "artifacts": {"key": "value"}}\n[/RESULT]`;
    }

    return '{"output": "default mock response"}';
  });
}

// ─── Web Search Implementation ────────────────
// Uses Tavily (TAVILY_API_KEY) or falls back to DuckDuckGo Instant Answer API.

async function searchWeb(query: string): Promise<{ results: string[]; source: string }> {
  const tavilyKey = process.env.TAVILY_API_KEY;

  if (tavilyKey) {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: tavilyKey,
        query,
        search_depth: "basic",
        max_results: 5,
      }),
    });
    if (!resp.ok) throw new Error(`Tavily error (${resp.status}): ${await resp.text()}`);
    const data = await resp.json();
    const results = (data.results ?? []).map(
      (r: { title: string; url: string; content: string }) =>
        `[${r.title}](${r.url})\n${r.content}`
    );
    return { results, source: "tavily" };
  }

  // DuckDuckGo Instant Answer API — free, no key required
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const resp = await fetch(url, { headers: { "Accept-Language": "en-US" } });
  if (!resp.ok) throw new Error(`DuckDuckGo error (${resp.status})`);
  const data = await resp.json();

  const results: string[] = [];
  if (data.AbstractText) results.push(`${data.AbstractText} (${data.AbstractURL})`);
  for (const topic of (data.RelatedTopics ?? []).slice(0, 4)) {
    if (topic.Text) results.push(`${topic.Text}${topic.FirstURL ? ` (${topic.FirstURL})` : ""}`);
  }
  if (results.length === 0) results.push(`No instant answer found for: ${query}`);
  return { results, source: "duckduckgo" };
}

// ─── Main ─────────────────────────────────────

async function main() {
  const client = createClient();

  // Create orchestrator with config overrides
  const orchestrator = new Orchestrator(client, {
    maxConcurrency: 3,
    tokenBudget: 50_000,
    defaultMaxRetries: 1,
    taskTimeoutMs: 30_000,
  });

  // Register a custom tool
  orchestrator.tools.register({
    name: "search_web",
    description: "Search the web for information on a topic",
    parameters: { query: "string" },
    execute: async (params) => searchWeb(params.query as string),
  });

  // Attach logging
  const unsubscribe = orchestrator.events.onAll(createLogger(true));

  // Run the pipeline
  console.log("\n═══════════════════════════════════════");
  console.log("  Starting Agent Run");
  console.log("═══════════════════════════════════════\n");

  const result = await orchestrator.run(
    "Summarize the three main benefits of TypeScript in two sentences each"
  );

  console.log("\n═══════════════════════════════════════");
  console.log("  Run Complete");
  console.log("═══════════════════════════════════════\n");

  console.log(`Run ID:       ${result.runId}`);
  console.log(`Success:      ${result.success}`);
  console.log(`Duration:     ${result.durationMs}ms`);
  console.log(`Tasks:        ${result.plan.tasks.length}`);
  console.log(`Tokens used:  ${result.context.tokenBudget.used}`);

  if (result.synthesis) {
    console.log(`\nSynthesis:`);
    console.log(`  Goal met:      ${result.synthesis.goalSatisfied}`);
    console.log(`  Completeness:  ${(result.synthesis.completeness * 100).toFixed(0)}%`);
    console.log(`  Summary:       ${result.synthesis.summary}`);
    if (result.synthesis.conflicts.length > 0) {
      console.log(`  Conflicts:     ${result.synthesis.conflicts.join(", ")}`);
    }
    if (result.synthesis.missingElements.length > 0) {
      console.log(`  Missing:       ${result.synthesis.missingElements.join(", ")}`);
    }
  }

  console.log(`\nIterations:   ${result.totalIterations}`);
  if (result.replanHistory.length > 0) {
    console.log(`Replans:`);
    for (const rp of result.replanHistory) {
      console.log(`  #${rp.iteration}: ${rp.reason} -> completeness=${rp.synthesis.completeness}`);
    }
  }

  // Cleanup
  unsubscribe();
}

main().catch(console.error);
