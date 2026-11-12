/** Node clamps setTimeout delays above this (~24.8 days). */
export const MAX_SET_TIMEOUT_MS = 2_147_483_647;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export interface ScheduledHandle {
  cancel(): void;
}

/** Fire `fn` at an absolute deadline, even if that is more than ~24.8 days away. */
export function scheduleAt(deadlineMs: number, fn: () => void): ScheduledHandle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const tick = (): void => {
    if (cancelled) return;
    const delay = deadlineMs - Date.now();
    if (delay <= 0) {
      fn();
      return;
    }
    timer = setTimeout(tick, Math.min(delay, MAX_SET_TIMEOUT_MS));
  };
  tick();

  return {
    cancel() {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
