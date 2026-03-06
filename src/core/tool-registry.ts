// ─────────────────────────────────────────────
// Tool Registry — Executor Capabilities
// ─────────────────────────────────────────────

import { ToolDefinition, ToolName, RunContext } from "../types/index.js";

export class ToolRegistry {
  private tools: Map<ToolName, ToolDefinition> = new Map();

  /** Register a tool */
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] Overwriting existing tool: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Get a tool by name */
  get(name: ToolName): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Check if a tool exists */
  has(name: ToolName): boolean {
    return this.tools.has(name);
  }

  /** List all registered tools */
  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Get tool descriptions for LLM context */
  getToolDescriptions(): string {
    return this.list()
      .map((t) => `- ${t.name}: ${t.description}`)
      .join("\n");
  }

  /** Execute a tool by name */
  async execute(
    name: ToolName,
    params: Record<string, unknown>,
    ctx: RunContext
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool.execute(params, ctx);
  }
}

// ─── Built-in Tools ───────────────────────────

export function createBuiltinTools(): ToolDefinition[] {
  return [
    {
      name: "write_file",
      description: "Write content to a file at the given path",
      parameters: { path: "string", content: "string" },
      execute: async (params) => {
        const fs = await import("fs/promises");
        const path = await import("path");
        const filePath = params.path as string;
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, params.content as string, "utf-8");
        return { written: filePath };
      },
    },
    {
      name: "read_file",
      description: "Read contents of a file",
      parameters: { path: "string" },
      execute: async (params) => {
        const fs = await import("fs/promises");
        return { content: await fs.readFile(params.path as string, "utf-8") };
      },
    },
    {
      name: "shell",
      description: "Execute a shell command and return stdout/stderr",
      parameters: { command: "string", cwd: "string (optional)" },
      execute: async (params) => {
        const { exec } = await import("child_process");
        const { promisify } = await import("util");
        const execAsync = promisify(exec);
        const { stdout, stderr } = await execAsync(params.command as string, {
          cwd: (params.cwd as string) || process.cwd(),
          timeout: 30_000,
        });
        return { stdout: stdout.trim(), stderr: stderr.trim() };
      },
    },
    {
      name: "store_memory",
      description: "Store a key-value pair in the shared run memory",
      parameters: { key: "string", value: "any" },
      execute: async (params, ctx) => {
        ctx.memory[params.key as string] = params.value;
        return { stored: params.key };
      },
    },
    {
      name: "read_memory",
      description: "Read a value from the shared run memory",
      parameters: { key: "string" },
      execute: async (params, ctx) => {
        return { value: ctx.memory[params.key as string] ?? null };
      },
    },
  ];
}
