'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export const REFRESH_INTERVAL_MS = 60_000;

/**
 * Re-renders the server component every minute so prices move without a reload.
 * router.refresh() re-runs the page on the server and merges the result, keeping
 * scroll position and any open <details> expanders.
 *
 * Paused while the tab is hidden: a background tab would otherwise hit the database
 * every minute for a page nobody is looking at. On return, a refresh that came due
 * while hidden runs at once instead of waiting out a fresh interval.
 */
export function AutoRefresh({ intervalMs = REFRESH_INTERVAL_MS }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    let last = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;

    const refresh = () => {
      last = Date.now();
      router.refresh();
    };
    const start = () => {
      if (timer === undefined) timer = setInterval(refresh, intervalMs);
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stop();
        return;
      }
      if (Date.now() - last >= intervalMs) refresh();
      start();
    };

    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router, intervalMs]);

  return null;
}
