import { useCallback, useEffect, useRef } from "react";

export const CONTROL_THROTTLE_MS = 400;

/**
 * Throttle: fires immediately on the first call, then at most once per `ms`.
 * A trailing call is guaranteed if invocations arrive during the cooldown.
 */
export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  ms: number,
): T & { cancel(): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;
  let lastCall = 0;

  const wrapped = ((...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = ms - (now - lastCall);

    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastCall = now;
      fn(...args);
    } else {
      lastArgs = args;
      if (!timer) {
        timer = setTimeout(() => {
          lastCall = Date.now();
          timer = null;
          if (lastArgs) {
            fn(...lastArgs);
            lastArgs = null;
          }
        }, remaining);
      }
    }
  }) as T & { cancel(): void; flush(): void };

  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
  };

  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      if (lastArgs) {
        lastCall = Date.now();
        fn(...lastArgs);
        lastArgs = null;
      }
    }
  };

  return wrapped;
}

/**
 * Debounce: delays invocation until `ms` after the last call.
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  ms: number,
): T & { cancel(): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;

  const wrapped = ((...args: Parameters<T>) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (lastArgs) {
        fn(...lastArgs);
        lastArgs = null;
      }
    }, ms);
  }) as T & { cancel(): void; flush(): void };

  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
  };

  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      if (lastArgs) {
        fn(...lastArgs);
        lastArgs = null;
      }
    }
  };

  return wrapped;
}

/**
 * React hook: returns a stable throttled version of `fn`.
 * Always calls the latest closure; cleans up on unmount.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useThrottle<T extends (...args: any[]) => void>(
  fn: T,
  ms: number,
): T & { cancel(): void; flush(): void } {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const throttled = useCallback(
    throttle(
      ((...args: Parameters<T>) => fnRef.current(...args)) as unknown as T & ((...args: unknown[]) => void),
      ms,
    ) as unknown as T & { cancel(): void; flush(): void },
    [ms],
  );

  useEffect(() => () => throttled.cancel(), [throttled]);
  return throttled;
}

/**
 * React hook: returns a stable debounced version of `fn`.
 * Always calls the latest closure; cleans up on unmount.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useDebounce<T extends (...args: any[]) => void>(
  fn: T,
  ms: number,
): T & { cancel(): void; flush(): void } {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debounced = useCallback(
    debounce(
      ((...args: Parameters<T>) => fnRef.current(...args)) as unknown as T & ((...args: unknown[]) => void),
      ms,
    ) as unknown as T & { cancel(): void; flush(): void },
    [ms],
  );

  useEffect(() => () => debounced.cancel(), [debounced]);
  return debounced;
}
