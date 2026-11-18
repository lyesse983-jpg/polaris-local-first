import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { PolarisTriggerRule } from '../types/domain';
import type { HeartbeatExecutionResult } from '../app/chat/heartbeatExecutor';
import { createUid } from '../engines/id';

type Wake = {sessionId: string; ruleId: string; scheduledFor: number};
export type HeartbeatWorkerStatus = {
  enabled: boolean; runtimeReady: boolean; lastOutcome: string;
  lastStartedAt: number; lastFinishedAt: number;
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
  const status = canUseHeartbeatWorker() ? await Worker.status() : null;
  enabled = status?.enabled ?? false; return status;
}
export function shouldDeferToNativeHeartbeatWorker() {
  return enabled && canUseHeartbeatWorker() && typeof document !== 'undefined' && document.visibilityState === 'hidden';
}
export async function setHeartbeatWorkerEnabled(enabled: boolean) {
  const status = await Worker.setEnabled({enabled});
  await readHeartbeatWorkerStatus(); return status;
}
export function installNativeHeartbeatRuntime(execute: (request: {ruleId: string; scheduledFor: number; signal: AbortSignal}) => Promise<HeartbeatExecutionResult>) {
  if (!canUseHeartbeatWorker()) return () => undefined;
  const owner = createUid('heartbeat-host');
  const sessions = new Map<string, AbortController>();
  let cancelled = false;
  const handles: PluginListenerHandle[] = [];
  void (async () => {
    try {
      const wake = await Worker.addListener('wake', event => {
        if (cancelled || typeof event.sessionId !== 'string' || !event.sessionId || typeof event.ruleId !== 'string'
          || !event.ruleId || !Number.isFinite(event.scheduledFor) || event.scheduledFor <= 0 || sessions.has(event.sessionId)) return;
        const controller = new AbortController(); sessions.set(event.sessionId, controller);
        void execute({ruleId: event.ruleId, scheduledFor: event.scheduledFor, signal: controller.signal})
          .catch(() => 'failed' as const).then(async outcome => {
            sessions.delete(event.sessionId);
            try { await Worker.finish({sessionId: event.sessionId, outcome}); } catch { /* Worker timeout retains its own diagnosis. */ }
          });
      });
      handles.push(wake);
      const stop = await Worker.addListener('stop', event => sessions.get(event.sessionId)?.abort());
      handles.push(stop);
      if (!cancelled) { await readHeartbeatWorkerStatus(); await Worker.runtimeReady({owner, ready: true}); }
      if (cancelled) {
        await Worker.runtimeReady({owner, ready: false});
        await Promise.all(handles.splice(0).map(handle => handle.remove()));
      }
    } catch {
      await Worker.runtimeReady({owner, ready: false}).catch(() => undefined);
      await Promise.all(handles.splice(0).map(handle => handle.remove()));
    }
  })();
  return () => {
    cancelled = true; sessions.forEach(controller => controller.abort());
    void Worker.runtimeReady({owner, ready: false}).catch(() => undefined);
    void Promise.all(handles.splice(0).map(handle => handle.remove()));
  };
}
