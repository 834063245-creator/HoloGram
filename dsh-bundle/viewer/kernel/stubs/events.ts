// Minimal typed pub/sub stub for HoloGram src-ui/ui/events (bus).
// Only the events the graph modules use are carried; all others are no-ops.
type Handler = (...args: never[]) => void
const channels = new Map<string, Set<Handler>>()
export const bus = {
  on(ev: string, h: Handler): void {
    let s = channels.get(ev); if (!s) { s = new Set(); channels.set(ev, s) }
    s.add(h)
  },
  off(ev: string, h: Handler): void { channels.get(ev)?.delete(h) },
  emit(ev: string, payload?: unknown): void {
    for (const h of channels.get(ev) ?? []) (h as (p?: unknown) => void)(payload)
  },
}
// graph:node-clicked payload type used by graph-interaction
export interface NodeClickedPayload {
  index: number
  nodeId: string
  name: string
  x: number; y: number; z: number
  shiftKey: boolean
}
