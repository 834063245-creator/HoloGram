// Stub for HoloGram src-ui/ui/app-shell — graph-tooltip calls navigateToFile / queryAgent.
// In the standalone viewer these are no-ops (DRY action stubs).
export const shell = {
  navigateToFile(_path: string, _line?: number): void {},
  queryAgent(_q: string): void {},
}
