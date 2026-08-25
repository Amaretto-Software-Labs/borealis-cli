export interface RequestDeadline {
  signal: AbortSignal;
  dispose(): void;
}

export function createRequestDeadline(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): RequestDeadline {
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException("Request timed out.", "TimeoutError")),
    timeoutMs,
  );
  timer.unref();
  return {
    signal: caller ? AbortSignal.any([caller, timeout.signal]) : timeout.signal,
    dispose: () => clearTimeout(timer),
  };
}
