/**
 * `describe` options for a suite that mounts the whole dashboard or walks a flow across several screens. Those specs
 * cost one to two seconds of CPU each even made as cheap as they go, and the shared CI runner has stretched a spec
 * seven to ten times under load, past Vitest's 5 s default with no defect. Every other suite keeps that
 * default, so a cheap spec that turns slow still fails.
 */
export const HEAVY_SUITE = {timeout: 20_000} as const;

/**
 * How long a Testing Library wait (`findBy…`, `waitFor`) polls before it gives up, set by the setup file for every
 * wait that names no timeout. Testing Library's own 1 s default is about what a wait costs on an idle machine
 * stretched three or four times, and the loaded runner stretched a correct wait past it. Four seconds
 * leaves room for that and still ends before a default spec's 5 s, so a state that never arrives fails as the wait
 * that named it, with the DOM printed, not as "Test timed out".
 */
export const ASYNC_UTIL_TIMEOUT = 4_000;
