import { afterEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  failListener: false, native: true, callbacks: {} as Record<string, (event: any) => void>,
  progress: vi.fn(async () => undefined), sync: vi.fn(async () => undefined), finish: vi.fn(async () => undefined), ready: vi.fn(async () => undefined),
  status: vi.fn(async () => ({enabled: true, runtimeReady: true, lastOutcome: 'never', lastStartedAt: 0, lastFinishedAt: 0})),
  remove: vi.fn(async () => undefined)
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: {isNativePlatform: () => mock.native, getPlatform: () => 'android', isPluginAvailable: () => mock.native},
  registerPlugin: () => ({progress: mock.progress, sync: mock.sync, finish: mock.finish, runtimeReady: mock.ready, status: mock.status,
    setEnabled: vi.fn(async () => ({enabled: true})),
    addListener: vi.fn(async (name, callback) => {if (mock.failListener) {mock.failListener = false; throw new Error('synthetic listener failure');} mock.callbacks[name] = callback; return {remove: mock.remove};})})
}));
import { installNativeHeartbeatRuntime, readHeartbeatWorkerStatus, shouldDeferToNativeHeartbeatWorker, syncNativeHeartbeatAppointments } from './heartbeatWorker';
afterEach(() => {vi.clearAllMocks(); vi.unstubAllGlobals(); mock.callbacks = {}; mock.native = true; mock.failListener = false;
  mock.ready.mockReset().mockResolvedValue(undefined);
  mock.status.mockReset().mockImplementation(async () => ({enabled: true, runtimeReady: true, lastOutcome: 'never', lastStartedAt: 0, lastFinishedAt: 0}));
});

describe('Android worker to shared runtime bridge', () => {
  it('reports committed prose and notification handoff before completion without copying message content', async () => {
    const execute = vi.fn(async (request) => { request.onReplySaved(); request.onNotification('denied'); return 'completed' as const; });
    const cleanup = installNativeHeartbeatRuntime(execute);
    await vi.waitFor(() => expect(mock.ready).toHaveBeenCalledWith(expect.objectContaining({ready: true})));
    mock.callbacks.wake({sessionId: 'synthetic-progress', ruleId: 'synthetic-rule', scheduledFor: Date.now() - 1});
    await vi.waitFor(() => expect(mock.finish).toHaveBeenCalledWith({sessionId: 'synthetic-progress', outcome: 'completed'}));
    expect(mock.progress).toHaveBeenNthCalledWith(1, {sessionId: 'synthetic-progress', phase: 'reply-saved'});
    expect(mock.progress).toHaveBeenNthCalledWith(2, {sessionId: 'synthetic-progress', phase: 'reply-notification', delivery: 'denied'});
    expect(mock.progress.mock.invocationCallOrder[1]).toBeLessThan(mock.finish.mock.invocationCallOrder[0]); cleanup();
  });

  it('reconnects a lost live registration without rewriting the historical failure or starting a model', async () => {
    const execute = vi.fn(); const cleanup = installNativeHeartbeatRuntime(execute);
    await vi.waitFor(() => expect(mock.ready).toHaveBeenCalledWith(expect.objectContaining({ready: true})));
    let connected = false;
    mock.status.mockImplementation(async () => ({enabled: true, runtimeReady: connected, lastOutcome: 'runtime-unavailable', lastStartedAt: 0, lastFinishedAt: 42}));
    mock.ready.mockClear(); mock.ready.mockImplementationOnce(async () => {connected = true;});
    const [first, second] = await Promise.all([readHeartbeatWorkerStatus(), readHeartbeatWorkerStatus()]);
    expect(first).toMatchObject({runtimeReady: true, lastOutcome: 'runtime-unavailable', lastFinishedAt: 42});
    expect(second?.runtimeReady).toBe(true); expect(mock.ready).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled(); cleanup();
  });
  it('retries listener setup after a transient failure when status is refreshed', async () => {
    let connected = false; mock.failListener = true;
    mock.status.mockImplementation(async () => ({enabled: true, runtimeReady: connected, lastOutcome: 'never', lastStartedAt: 0, lastFinishedAt: 0}));
    const cleanup = installNativeHeartbeatRuntime(vi.fn());
    await vi.waitFor(() => expect(mock.ready).toHaveBeenCalledWith(expect.objectContaining({ready: false})));
    mock.ready.mockImplementationOnce(async () => {connected = true;});
    await vi.waitFor(async () => {
      const status = await readHeartbeatWorkerStatus(); expect(status?.runtimeReady).toBe(true); expect(status?.connectionIssue).toBe(false);
    });
    expect(mock.callbacks.wake).toBeTypeOf('function'); expect(mock.callbacks.stop).toBeTypeOf('function'); cleanup();
  });

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
