// ─────────────────────────────────────────────
// Event Emitter — Observability & Hooks
// ─────────────────────────────────────────────

import { FrameworkEvent, EventHandler } from "../types/index.js";

export class EventBus {
  private handlers: Map<string, EventHandler[]> = new Map();
  private globalHandlers: EventHandler[] = [];

  /** Subscribe to a specific event type */
  on(eventType: FrameworkEvent["type"], handler: EventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType)!.push(handler);

    // Return unsubscribe function
    return () => {
      const list = this.handlers.get(eventType);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    };
  }

  /** Subscribe to all events (for logging / tracing) */
  onAll(handler: EventHandler): () => void {
    this.globalHandlers.push(handler);
    return () => {
      const idx = this.globalHandlers.indexOf(handler);
      if (idx >= 0) this.globalHandlers.splice(idx, 1);
    };
  }

  /** Emit an event */
  emit(event: FrameworkEvent): void {
    // Global handlers first
    for (const handler of this.globalHandlers) {
      try {
        handler(event);
      } catch (e) {
        console.error(`[EventBus] Global handler error:`, e);
      }
    }

    // Type-specific handlers
    const handlers = this.handlers.get(event.type) ?? [];
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (e) {
        console.error(`[EventBus] Handler error for ${event.type}:`, e);
      }
    }
  }
}

/** Pre-built logger handler for observability */
export function createLogger(verbose = false): EventHandler {
  return (event: FrameworkEvent) => {
    const ts = new Date().toISOString();
    const base = `[${ts}] ${event.type} | run=${event.runId}`;

    switch (event.type) {
      case "task:started":
        console.log(`${base} task=${event.taskId} | ${event.description}`);
        break;
      case "task:ready":
        console.log(`${base} task=${event.taskId}`);
        break;
      case "task:completed":
        console.log(`${base} task=${event.taskId} duration=${event.result.durationMs}ms`);
        if (verbose) console.log(`  output:`, JSON.stringify(event.result.output).slice(0, 200));
        break;
      case "task:failed":
        console.error(`${base} task=${event.taskId} error=${event.error}`);
        break;
      case "task:retry":
        console.warn(`${base} task=${event.taskId} attempt=${event.attempt}`);
        break;
      default:
        console.log(base);
    }
  };
}
