// The TanStack Query key factory for the token handler's own routes. reference: CONVENTIONS.md (one key factory
// per API surface)

export const authKeys = {
  all: ['auth'] as const,
  session: () => [...authKeys.all, 'session'] as const,
  /** The idle countdown's own re-read of API-42, which nothing observes (review). */
  sessionCheck: () => [...authKeys.all, 'session-check'] as const,
  keepAlive: () => [...authKeys.all, 'keep-alive'] as const,
};
