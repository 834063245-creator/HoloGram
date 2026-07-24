/**
 * withTimeout — race a promise against a deadline.
 * On timeout, calls onTimeout (if provided) and rejects.
 * The original promise is NOT cancelled (no cancellation in JS promises),
 * but the caller can use AbortController for actual cancellation.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`timeout after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeoutP]).finally(() => clearTimeout(timer!));
}
