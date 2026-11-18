import { useEffect, useState } from 'react';
import { canUseHeartbeatWorker, readHeartbeatWorkerStatus, setHeartbeatWorkerEnabled, type HeartbeatWorkerStatus } from '../../../native/heartbeatWorker';
import { useI18n } from '../../../i18n/useI18n';

export function HeartbeatWorkerPanel() {
  const {language} = useI18n(); const en = language === 'en-US';
  const [status, setStatus] = useState<HeartbeatWorkerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => {
    try { setStatus(await readHeartbeatWorkerStatus()); setError(''); }
    catch { setError(en ? 'Could not read background status.' : '暂时无法读取后台状态。'); }
  };
  useEffect(() => {
    if (!canUseHeartbeatWorker()) return;
    let cancelled = false;
    const update = () => { void readHeartbeatWorkerStatus().then(value => {if (!cancelled) setStatus(value);}).catch(() => undefined); };
    update(); window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {cancelled = true; window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update);};
  }, []);
  if (!canUseHeartbeatWorker()) return null;
  return <HeartbeatWorkerStatusView status={status} busy={busy} error={error} en={en}
    onRefresh={() => void refresh()}
    onToggle={() => { setBusy(true); void setHeartbeatWorkerEnabled(!status?.enabled).then(value => {setStatus(value); setError('');})
      .catch(() => setError(en ? 'Could not change background setting.' : '后台开关修改失败。')).finally(() => setBusy(false)); }} />;
}

export function HeartbeatWorkerStatusView({status, busy, error, en, onRefresh, onToggle}: {
  status: HeartbeatWorkerStatus | null; busy: boolean; error: string; en: boolean;
  onRefresh: () => void; onToggle: () => void;
}) {
  const outcomes: Record<string, string> = en ? {
    never: 'Not run by Android yet', running: 'Android task is running', completed: 'Reply run saved', failed: 'Run failed',
    aborted: 'Run stopped', busy: 'Conversation busy; waiting', stale: 'Appointment already handled or changed',
    timeout: 'Execution window expired', 'runtime-unavailable': 'No registered runtime was available at that attempt'
  } : {
    never: '安卓任务尚未执行', running: '安卓任务执行中', completed: '本次运行结果已保存', failed: '本次运行失败',
    aborted: '本次运行已停止', busy: '会话忙碌，等待重试', stale: '预约已处理或已变更',
    timeout: '本次后台执行超时', 'runtime-unavailable': '当时未找到已注册的执行入口'
  };
  return <section className="menu-section heartbeat-worker-panel">
    <strong>{en ? 'Background execution experiment' : '后台执行实验'}</strong>
    <p className="menu-section-note">{en
      ? 'With exact-alarm access, an appointment can open a short foreground execution window. A running notification appears only during model/tool work. Timing may be delayed; an existing app runtime is still required.'
      : '开启精确闹钟后，预约到点时尝试启动短时保护窗口；模型和工具执行期间会显示运行通知，完成后退出。系统可能延后执行；仍需现有应用运行环境。'}</p>
    <div className="heartbeat-worker-actions">
      <button type="button" role="switch" aria-checked={status?.enabled ?? false} disabled={!status || busy}
        onClick={onToggle}>
        {status?.enabled ? (en ? 'Background experiment: on' : '后台实验：已开启') : (en ? 'Enable background experiment' : '开启后台实验')}
      </button>
      <button type="button" onClick={onRefresh} disabled={busy}>{en ? 'Refresh status' : '刷新状态'}</button>
    </div>
    {status ? <div className="menu-section-note" role="status">
      <p>{en ? 'Current execution entry: ' : '当前执行入口：'}{status.runtimeReady ? (en ? 'connected' : '已连接') : (en ? 'not connected' : '未连接')}</p>
      {status.connectionIssue ? <p>{en ? 'Connection setup failed; refresh to retry.' : '入口注册失败，可刷新状态重试。'}</p> : null}
      <p>{en ? 'Last Android task: ' : '上次安卓任务：'}{outcomes[status.lastOutcome] ?? (en ? 'Unknown status' : '状态未知')}
        {status.lastFinishedAt > 0 ? ` · ${new Date(status.lastFinishedAt).toLocaleTimeString(en ? 'en-US' : 'zh-CN', {hour: '2-digit', minute: '2-digit'})}` : ''}</p>
      {(status.lastScheduledFor ?? 0) > 0 ? <p>{en ? 'Appointment time: ' : '本次预约时间：'}{new Date(status.lastScheduledFor!).toLocaleString(en ? 'en-US' : 'zh-CN')}</p> : null}
      {status.lastStopReason && status.lastStopReason !== 'none' ? <p>{en ? 'Stop source: ' : '中止来源：'}{({
        'work-manager-stopped': en ? 'Android stopped the worker' : '安卓停止了任务',
        'runtime-detached': en ? 'Runtime disconnected' : '运行入口断开',
        'background-disabled': en ? 'Background experiment disabled' : '后台实验被关闭',
        'native-cancelled': en ? 'Native execution cancelled' : '原生执行被取消'
      } as Record<string, string>)[status.lastStopReason] ?? status.lastStopReason}
      {status.lastStopReason === 'work-manager-stopped' ? ` (${status.lastWorkerStopReason ?? -256})` : ''}</p> : null}
      {status.lastStopReason === 'work-manager-stopped' && typeof status.lastWorkerStopReason === 'number' ? <p>{en ? 'Android stop code: ' : '安卓中止代码：'}{status.lastWorkerStopReason}</p> : null}
      {status.lastSource && status.lastSource !== 'none' ? <p>{en ? 'Execution path: ' : '执行通道：'}{['foreground-service', 'work-manager-foreground'].includes(status.lastSource) ? (en ? 'protected execution window' : '短时保护运行') : (en ? 'regular background task' : '普通后台任务')}</p> : null}
      {typeof status.lastStartedInForeground === 'boolean' && typeof status.lastFinishedInForeground === 'boolean' ? <p>
        {en ? 'App visibility: ' : '运行界面：'}{status.lastStartedInForeground ? (en ? 'foreground' : '前台') : (en ? 'background' : '后台')} → {status.lastFinishedInForeground ? (en ? 'foreground' : '前台') : (en ? 'background' : '后台')}
      </p> : null}
      {(status.lastReplySavedAt ?? 0) > 0 ? <p>{en ? 'Reply saved: ' : '正文保存：'}{new Date(status.lastReplySavedAt!).toLocaleTimeString(en ? 'en-US' : 'zh-CN')} · {status.lastReplySavedInForeground ? (en ? 'foreground' : '前台') : (en ? 'background' : '后台')}</p> : null}
      {status.lastNotificationStatus && status.lastNotificationStatus !== 'none' ? <p>{en ? 'System notification: ' : '系统通知：'}{status.lastNotificationStatus === 'synced' ? (en ? 'submitted to Android' : '已交给安卓系统') : status.lastNotificationStatus === 'denied' ? (en ? 'permission not granted' : '通知权限未开启') : (en ? 'not submitted' : '未能交给系统')}</p> : null}
      {status.lastWindowStatus && status.lastWindowStatus !== 'none' ? <p>{en ? 'Latest execution window: ' : '最近保护窗口：'}{status.lastWindowStatus === 'running' ? (en ? 'running' : '运行中') : status.lastWindowStatus === 'finished' ? (en ? 'ended' : '已结束') : (en ? 'Android did not allow startup' : '系统未允许启动')}</p> : null}
      {status.lastOutcome === 'runtime-unavailable' ? <p>{en ? 'Recorded cause: ' : '当次诊断：'}{({
        'process-restarted': en ? 'The process changed since its last registration' : '相较上次注册，应用进程已重建',
        'registration-lost': en ? 'Registration was lost in the same process' : '同一进程内的入口注册已丢失',
        'no-registration-record': en ? 'No prior registration record' : '尚无入口注册记录',
        'dispatch-failed': en ? 'Dispatch to the registered runtime failed' : '向已注册入口分发失败'
      } as Record<string, string>)[status.lastMissingReason ?? 'unknown'] ?? (en ? 'Older result has no detailed diagnosis' : '旧记录没有详细诊断')}</p> : null}
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
