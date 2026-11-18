import { throwIfAborted } from './chatAbortError';

/** A reply may stop waiting without cancelling a shared MCP catalog refresh. */
export async function awaitReplyPreparation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  // Attach the handler even if already aborted, so a shared failure is still observed.
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        onAbort = () => {
          try { throwIfAborted(signal); } catch (error) { reject(error); }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      })
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
