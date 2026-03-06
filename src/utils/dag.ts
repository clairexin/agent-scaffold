// ─────────────────────────────────────────────
// DAG Utilities — Dependency Resolution
// ─────────────────────────────────────────────

import { Task, TaskId, TaskStatus } from "../types/index.js";

/**
 * Topological sort of tasks into parallel execution groups.
 * Each group contains tasks whose dependencies are all in prior groups.
 */
export function topologicalSort(tasks: Task[]): TaskId[][] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const inDegree = new Map<TaskId, number>();
  const dependents = new Map<TaskId, TaskId[]>();

  // Initialize
  for (const task of tasks) {
    inDegree.set(task.id, task.dependencies.length);
    for (const dep of task.dependencies) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(task.id);
    }
  }

  const groups: TaskId[][] = [];
  let remaining = new Set(tasks.map((t) => t.id));

  while (remaining.size > 0) {
    // Find all tasks with zero in-degree
    const ready = [...remaining].filter((id) => (inDegree.get(id) ?? 0) === 0);

    if (ready.length === 0) {
      const cycle = [...remaining].join(", ");
      throw new Error(`Cycle detected in task dependencies: ${cycle}`);
    }

    groups.push(ready);

    // Remove ready tasks and update in-degrees
    for (const id of ready) {
      remaining.delete(id);
      for (const dep of dependents.get(id) ?? []) {
        inDegree.set(dep, (inDegree.get(dep) ?? 1) - 1);
      }
    }
  }

  return groups;
}

/**
 * Check if a task is ready to execute (all dependencies succeeded).
 */
export function isTaskReady(task: Task, tasks: Task[]): boolean {
  if (task.status !== TaskStatus.Pending) return false;
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  return task.dependencies.every(
    (depId) => taskMap.get(depId)?.status === TaskStatus.Success
  );
}

/**
 * Validate the task DAG: check for missing dependencies and cycles.
 */
export function validateDAG(tasks: Task[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set(tasks.map((t) => t.id));

  // Check for missing dependencies
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (!ids.has(dep)) {
        errors.push(`Task "${task.id}" depends on unknown task "${dep}"`);
      }
    }
  }

  // Check for cycles via topological sort
  if (errors.length === 0) {
    try {
      topologicalSort(tasks);
    } catch (e: any) {
      errors.push(e.message);
    }
  }

  return { valid: errors.length === 0, errors };
}
