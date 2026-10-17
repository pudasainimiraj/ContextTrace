import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiResult } from "./api.ts";
import type { ErrorView } from "./errors.ts";

export type Polled<T> = { data: T | null; error: ErrorView | null; status: number | null; updatedAt: number | null; loading: boolean; reload: () => void };

type PolledState<T> = Omit<Polled<T>, "reload">;

function empty<T>(): PolledState<T> {
  return { data: null, error: null, status: null, updatedAt: null, loading: true };
}

/**
 * Loads now and again every `intervalMs` (null: once), pausing while the tab is hidden and
 * loading at once when it shows again. A new `key` starts over; `reload()` loads at once.
 */
export function usePolling<T>(load: () => Promise<ApiResult<T>>, intervalMs: number | null, key: string): Polled<T> {
  const [state, setState] = useState<{ key: string } & PolledState<T>>(() => ({ key, ...empty<T>() }));
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (intervalMs !== null && active) timer = setTimeout(() => void run(), intervalMs);
    };
    async function run() {
      if (document.hidden) {
        schedule();
        return;
      }
      const result = await loadRef.current();
      if (!active) return;
      setState((s) => {
        const base = s.key === key ? s : { key, ...empty<T>() };
        return result.ok
          ? { ...base, data: result.value, error: null, status: result.status, updatedAt: Date.now(), loading: false }
          : { ...base, error: result.error, status: result.status, loading: false };
      });
      schedule();
    }
    const onVisible = () => {
      if (document.hidden) return;
      if (timer) clearTimeout(timer);
      void run();
    };
    void run();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, key, tick]);

  // A result that belongs to an earlier key is not shown for the new one.
  const current: PolledState<T> = state.key === key ? state : empty<T>();
  return { ...current, reload };
}

/** The current time, refreshed every `everyMs`, for relative times and "updated n s ago" tickers. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
