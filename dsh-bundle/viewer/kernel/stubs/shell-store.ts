// Minimal stub for HoloGram app/shell-store — only the graph modules' contract.
let statusText = ''
export const useShellStore = {
  getState: () => ({
    get statusText() { return statusText },
    setStatusText: (s: string) => { statusText = s },
    setViolations: () => {},
    setGraphStats: (_s: unknown) => {},
    violations: 0,
  }),
}
