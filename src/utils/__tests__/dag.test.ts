import { describe, it, expect } from "vitest";
import { topologicalSort, validateDAG, isTaskReady } from "../dag.js";
import { TaskStatus } from "../../types/index.js";
import type { Task } from "../../types/index.js";

function makeTask(id: string, deps: string[] = []): Task {
  return {
    id,
    description: `Task ${id}`,
    dependencies: deps,
    toolsNeeded: [],
    status: TaskStatus.Pending,
    retryCount: 0,
    maxRetries: 2,
  };
}

describe("topologicalSort", () => {
  it("sorts independent tasks into one group", () => {
    const tasks = [makeTask("a"), makeTask("b"), makeTask("c")];
    const groups = topologicalSort(tasks);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toContain("a");
    expect(groups[0]).toContain("b");
    expect(groups[0]).toContain("c");
  });

  it("sorts a linear chain into sequential groups", () => {
    const tasks = [makeTask("a"), makeTask("b", ["a"]), makeTask("c", ["b"])];
    const groups = topologicalSort(tasks);
    expect(groups).toEqual([["a"], ["b"], ["c"]]);
  });

  it("handles diamond dependencies", () => {
    const tasks = [
      makeTask("a"),
      makeTask("b", ["a"]),
      makeTask("c", ["a"]),
      makeTask("d", ["b", "c"]),
    ];
    const groups = topologicalSort(tasks);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual(["a"]);
    expect(groups[1]).toContain("b");
    expect(groups[1]).toContain("c");
    expect(groups[2]).toEqual(["d"]);
  });

  it("throws on cycles", () => {
    const tasks = [makeTask("a", ["b"]), makeTask("b", ["a"])];
    expect(() => topologicalSort(tasks)).toThrow(/[Cc]ycle/);
  });
});

describe("validateDAG", () => {
  it("detects missing dependencies", () => {
    const tasks = [makeTask("a", ["nonexistent"])];
    const result = validateDAG(tasks);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("nonexistent");
  });

  it("passes for a valid DAG", () => {
    const tasks = [makeTask("a"), makeTask("b", ["a"])];
    expect(validateDAG(tasks).valid).toBe(true);
  });

  it("detects cycles", () => {
    const tasks = [makeTask("a", ["c"]), makeTask("b", ["a"]), makeTask("c", ["b"])];
    const result = validateDAG(tasks);
    expect(result.valid).toBe(false);
  });
});

describe("isTaskReady", () => {
  it("returns true when all deps succeeded", () => {
    const a = makeTask("a");
    a.status = TaskStatus.Success;
    const b = makeTask("b", ["a"]);
    expect(isTaskReady(b, [a, b])).toBe(true);
  });

  it("returns false when a dep is still pending", () => {
    const a = makeTask("a");
    const b = makeTask("b", ["a"]);
    expect(isTaskReady(b, [a, b])).toBe(false);
  });

  it("returns false if task is not pending", () => {
    const a = makeTask("a");
    a.status = TaskStatus.Success;
    const b = makeTask("b", ["a"]);
    b.status = TaskStatus.Running;
    expect(isTaskReady(b, [a, b])).toBe(false);
  });
});
