// The TanStack Query key factory for the token handler's runtime config. reference: CONVENTIONS.md (one key factory
// per API surface)

export const configKeys = {
  all: ['config'] as const,
  runtime: () => [...configKeys.all, 'runtime'] as const,
};
