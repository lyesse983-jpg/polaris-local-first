import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { PolarisTriggerRule } from '../types/domain';
import type { HeartbeatExecutionResult } from '../app/chat/heartbeatExecutor';
import { createUid } from '../engines/id';

type Wake = {sessionId: string; ruleId: string; scheduledFor: number};
export type HeartbeatWorkerStatus = {
  enabled: boolean; runtimeReady: boolean; lastOutcome: string;
  lastStartedAt: number; lastFinishedAt: number;
  lastMissingReason?: string; connectionIssue?: boolean;
};
type WorkerPlugin = {
  sync(options: {appointments: {ruleId: string; scheduledFor: number}[]}): Promise<void>;
  setEnabled(options: {enabled: boolean}): Promise<HeartbeatWorkerStatus>;
  status(): Promise<HeartbeatWorkerStatus>;
  runtimeReady(options: {owner: string; ready: boolean}): Promise<void>;
  finish(options: {sessionId: string; outcome: HeartbeatExecutionResult}): Promise<void>;
  addListener(event: 'wake' | 'stop', callback: (event: Wake) => void): Promise<PluginListenerHandle>;
};
let enabled = false;
let activeConnection: {owner: string; connect: () => Promise<void>; failed: () => boolean} | undefined;
const Worker = registerPlugin<WorkerPlugin>('PolarisHeartbeatWorker');
export function canUseHeartbeatWorker() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('PolarisHeartbeatWorker');
}
export async function syncNativeHeartbeatAppointments(rules: PolarisTriggerRule[]) {
  if (!canUseHeartbeatWorker()) return;
  await Worker.sync({appointments: rules.filter(rule => rule.enabled && rule.nextRunAt !== null)
    .map(rule => ({ruleId: rule.id, scheduledFor: rule.nextRunAt!}))});
}
export async function readHeartbeatWorkerStatus() {
  let status = canUseHeartbeatWorker() ? await Worker.status() : null;
  const connection = activeConnection;
  if (status && !status.runtimeReady && connection) {
    await connection.connect();
    status = await Worker.status();
  }
  enabled = status?.enabled ?? false;
  return status ? {...status, connectionIssue: activeConnection?.failed() ?? false} : null;
}
export function shouldDeferToNativeHeartbeatWorker() {
  return enabled && canUseHeartbeatWorker() && typeof document !== 'undefined' && document.visibilityState === 'hidden';
}
export async function setHeartbeatWorkerEnabled(enabled: boolean) {
  const status = await Worker.setEnabled({enabled});
  return await readHeartbeatWorkerStatus() ?? status;
}
export function installNativeHeartbeatRuntime(execute: (request: {ruleId: string; scheduledFor: number; signal: AbortSignal}) => Promise<HeartbeatExecutionResult>) {
  if (!canUseHeartbeatWorker()) return () => undefined;
  const owner = createUid('heartbeat-host');
  const sessions = new Map<string, AbortController>();
  let cancelled = false;
  const handles: PluginListenerHandle[] = [];
  let pending: Promise<void> | undefined;
  let failed = false;
  const connect = (): Promise<void> => {
    if (cancelled) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      try {
        if (handles.length === 0) {
          handles.push(await Worker.addListener('wake', event => {
            if (cancelled || typeof event.sessionId !== 'string' || !event.sessionId || typeof event.ruleId !== 'string'
              || !event.ruleId || !Number.isFinite(event.scheduledFor) || event.scheduledFor <= 0 || sessions.has(event.sessionId)) return;
            const controller = new AbortController(); sessions.set(event.sessionId, controller);
            void execute({ruleId: event.ruleId, scheduledFor: event.scheduledFor, signal: controller.signal})
              .catch(() => 'failed' as const).then(async outcome => {
                sessions.delete(event.sessionId);
                try { await Worker.finish({sessionId: event.sessionId, outcome}); } catch { /* Native timeout retains its own diagnosis. */ }
              });
          }));
          handles.push(await Worker.addListener('stop', event => sessions.get(event.sessionId)?.abort()));
        }
        if (!cancelled) {
          const status = await Worker.status(); enabled = status.enabled;
          await Worker.runtimeReady({owner, ready: true});
          failed = false;
        }
        if (cancelled) {
          await Worker.runtimeReady({owner, ready: false});
          await Promise.all(handles.splice(0).map(handle => handle.remove()));
        }
      } catch {
        failed = true;
        await Worker.runtimeReady({owner, ready: false}).catch(() => undefined);
        await Promise.all(handles.splice(0).map(handle => handle.remove()));
      }
    })().finally(() => { pending = undefined; });
    return pending;
  };
  activeConnection = {owner, connect, failed: () => failed};
  const restore = () => {
    if (!cancelled && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
      void readHeartbeatWorkerStatus().catch(() => undefined);
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('focus', restore);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', restore);
  void connect();
  return () => {
    cancelled = true; sessions.forEach(controller => controller.abort());
    if (activeConnection?.owner === owner) activeConnection = undefined;
    if (typeof window !== 'undefined') window.removeEventListener('focus', restore);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', restore);
    void Worker.runtimeReady({owner, ready: false}).catch(() => undefined);
    void Promise.all(handles.splice(0).map(handle => handle.remove()));
  };
}
