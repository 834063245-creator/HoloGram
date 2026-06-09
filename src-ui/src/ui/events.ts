// Event Bus — lightweight pub/sub for cross-component communication
// Used by: CheckPanel → Main → StarGraph (navigate:node)
//          Future: detail card → Agent (agent:send)
//          Future: graph → check (graph:selection-changed)

type Handler = (...args: any[]) => void;

class EventBus {
  private handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event);
    if (list) {
      list.push(handler);
    } else {
      this.handlers.set(event, [handler]);
    }
  }

  off(event: string, handler: Handler): void {
    const list = this.handlers.get(event);
    if (list) {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  emit(event: string, ...args: any[]): void {
    const list = this.handlers.get(event);
    if (list) {
      for (const h of list) {
        try { h(...args); } catch (e) { console.error(`[EventBus] ${event} handler error:`, e); }
      }
    }
  }
}

export const bus = new EventBus();

// Known event names:
//   navigate:node (nodeName: string) — focus a node in the star graph
