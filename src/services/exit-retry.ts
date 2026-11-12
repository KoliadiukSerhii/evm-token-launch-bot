export const MIN_EXIT_RETRY_MS = 5_000;
export const MAX_EXIT_RETRY_MS = 5 * 60_000;

/** First wait is 5s. Each later wait doubles, capped at 5 minutes. */
export function takeRetryDelay(previous: number | undefined): {
  wait: number;
  next: number;
} {
  const wait = previous ?? MIN_EXIT_RETRY_MS;
  return { wait, next: Math.min(wait * 2, MAX_EXIT_RETRY_MS) };
}
