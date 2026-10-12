/** The console prepares its runtime on entering the workbench, not at login. */
export const deferredAgentHeaders = {
  'X-SuperDsh-Agent-Preparation': 'deferred',
} as const
