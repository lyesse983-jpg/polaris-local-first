import { useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { createHeartbeatExecutor, type HeartbeatExecutionContext } from './heartbeatExecutor';
import { installNativeHeartbeatRuntime, shouldDeferToNativeHeartbeatWorker } from '../../native/heartbeatWorker';

type UseChatTriggerRuntimeArgs = HeartbeatExecutionContext & {startupReady: boolean};

export function useChatTriggerRuntime({
  startupReady,
  generationByConversationId,
  store,
  runReply,
  setCommandStatus
}: UseChatTriggerRuntimeArgs) {
  const contextRef = useRef({generationByConversationId, store, runReply, setCommandStatus});
  contextRef.current = {generationByConversationId, store, runReply, setCommandStatus};
  const executorRef = useRef<ReturnType<typeof createHeartbeatExecutor> | null>(null);
  if (!executorRef.current) executorRef.current = createHeartbeatExecutor(() => contextRef.current);
  const executor = executorRef.current;
  const [wakeTick, setWakeTick] = useState(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; executor.activate(); return () => { mounted.current = false; executor.dispose(); }; }, [executor]);
  useEffect(() => { executor.cancelIfInvalid(); }, [executor, store.chat.conversations, store.runtime.triggerRules]);
  useEffect(() => {
    if (!startupReady) return;
    return installNativeHeartbeatRuntime(async request => {
      const result = await executor.execute(request);
      if (mounted.current) setWakeTick(tick => tick + 1);
      return result;
    });
  }, [executor, startupReady]);

  useEffect(() => {
    if (!startupReady || typeof window === 'undefined') return;

    const wake = () => setWakeTick((current) => current + 1);
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') wake();
    };

    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    let cancelled = false;
    let removeResumeListener: (() => void) | null = null;

    if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('App')) {
      void CapacitorApp.addListener('resume', wake).then((listener) => {
        if (cancelled) {
          void listener.remove();
          return;
        }
        removeResumeListener = () => {
          void listener.remove();
        };
      });
    }

    return () => {
      cancelled = true;
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', wake);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      removeResumeListener?.();
    };
  }, [startupReady]);

  useEffect(() => {
    if (!startupReady) return;
    const nextRunAt = store.runtime.triggerRules
      .filter((rule) => rule.enabled && rule.nextRunAt !== null)
      .map((rule) => rule.nextRunAt!)
      .sort((left, right) => left - right)[0];
    if (!nextRunAt) return;

    const delay = Math.max(0, nextRunAt - Date.now());
    const timer = window.setTimeout(
      () => setWakeTick((current) => current + 1),
      Math.min(delay, 2_147_483_647)
    );
    return () => window.clearTimeout(timer);
  }, [startupReady, store.runtime.triggerRules]);

  useEffect(() => {
    if (!startupReady || shouldDeferToNativeHeartbeatWorker()) return;
    void executor.execute().then(result => {
      if (mounted.current && result !== 'busy' && result !== 'stale' && result !== 'aborted') setWakeTick(tick => tick + 1);
    });
  }, [executor, generationByConversationId, runReply, startupReady, store, wakeTick]);
}
