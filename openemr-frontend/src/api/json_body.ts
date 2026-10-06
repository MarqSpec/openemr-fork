/** The body as JSON, or `undefined` when it is not JSON (an HTML error page, an empty body); an abort propagates. */
export async function readJson(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return undefined;
  }
}
