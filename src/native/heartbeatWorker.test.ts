import { afterEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  native: true, callbacks: {} as Record<string, (event: any) => void>,
  sync: vi.fn(async () => undefined), finish: vi.fn(async () => undefined), ready: vi.fn(async () => undefined),
  status: vi.fn(async () => ({enabled: true, runtimeReady: true, lastOutcome: 'never', lastStartedAt: 0, lastFinishedAt: 0})),
  remove: vi.fn(async () => undefined)
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: {isNativePlatform: () => mock.native, getPlatform: () => 'android', isPluginAvailable: () => mock.native},
  registerPlugin: () => ({sync: mock.sync, finish: mock.finish, runtimeReady: mock.ready, status: mock.status,
    setEnabled: vi.fn(async () => ({enabled: true})),
    addListener: vi.fn(async (name, callback) => {mock.callbacks[name] = callback; return {remove: mock.remove};})})
}));
import { installNativeHeartbeatRuntime, readHeartbeatWorkerStatus, shouldDeferToNativeHeartbeatWorker, syncNativeHeartbeatAppointments } from './heartbeatWorker';
afterEach(() => {vi.clearAllMocks(); vi.unstubAllGlobals(); mock.callbacks = {}; mock.native = true;});

describe('Android worker to shared runtime bridge', () => {
  it('waits for shared execution to finish, rejects duplicate wakes and aborts the same session on stop', async () => {
    let finish!: (result: 'aborted') => void; let signal!: AbortSignal;
    const execute = vi.fn(request => {signal = request.signal; return new Promise<'aborted'>(done => {finish = done;});});
    const cleanup = installNativeHeartbeatRuntime(execute);
    await vi.waitFor(() => expect(mock.ready).toHaveBeenCalledWith(expect.objectContaining({ready: true})));
    const wake = {sessionId: 'synthetic-session', ruleId: 'synthetic-rule', scheduledFor: Date.now() - 1};
    mock.callbacks.wake(wake); mock.callbacks.wake(wake);
    expect(execute).toHaveBeenCalledOnce(); expect(mock.finish).not.toHaveBeenCalled();
    mock.callbacks.stop(wake); expect(signal.aborted).toBe(true); finish('aborted');
    await vi.waitFor(() => expect(mock.finish).toHaveBeenCalledWith({sessionId: wake.sessionId, outcome: 'aborted'}));
    cleanup(); expect(mock.ready).toHaveBeenLastCalledWith(expect.objectContaining({ready: false}));
  });
  it('projects only appointment identities/times, including silent work, without context or credentials', async () => {
    const rules = [
      {id: 'a', enabled: true, nextRunAt: 42, action: {delivery: 'silent', prompt: 'private synthetic prompt'}},
      {id: 'off', enabled: false, nextRunAt: 10}, {id: 'consumed', enabled: true, nextRunAt: null}
    ];
    await syncNativeHeartbeatAppointments(rules as never);
    expect(mock.sync).toHaveBeenCalledExactlyOnceWith({appointments: [{ruleId: 'a', scheduledFor: 42}]});
  });
  it('defers hidden-page timer execution only when the native experiment is enabled', async () => {
    vi.stubGlobal('document', {visibilityState: 'hidden'}); await readHeartbeatWorkerStatus();
    expect(shouldDeferToNativeHeartbeatWorker()).toBe(true);
    vi.stubGlobal('document', {visibilityState: 'visible'}); expect(shouldDeferToNativeHeartbeatWorker()).toBe(false);
    mock.native = false; expect(installNativeHeartbeatRuntime(vi.fn())).toBeTypeOf('function');
  });
});
