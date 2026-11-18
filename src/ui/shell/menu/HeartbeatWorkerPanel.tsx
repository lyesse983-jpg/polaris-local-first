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
    timeout: 'Execution window expired', 'runtime-unavailable': 'App runtime unavailable; open Polaris to continue'
  } : {
    never: '安卓任务尚未执行', running: '安卓任务执行中', completed: '本次运行结果已保存', failed: '本次运行失败',
    aborted: '本次运行已停止', busy: '会话忙碌，等待重试', stale: '预约已处理或已变更',
    timeout: '本次后台执行超时', 'runtime-unavailable': '应用运行环境已停止，请打开 Polaris 继续'
  };
  return <section className="menu-section heartbeat-worker-panel">
    <strong>{en ? 'Background execution experiment' : '后台执行实验'}</strong>
    <p className="menu-section-note">{en
      ? 'After opening Polaris, Android can wake its existing runtime while you use another app or lock the screen. Timing may be delayed. Cold starts after the process is killed are not supported yet.'
      : '打开过 Polaris 后，允许安卓在切换应用或锁屏时唤醒现有运行环境。可能延后执行；暂不支持进程结束后的独立启动。'}</p>
    <div className="heartbeat-worker-actions">
      <button type="button" role="switch" aria-checked={status?.enabled ?? false} disabled={!status || busy}
        onClick={onToggle}>
        {status?.enabled ? (en ? 'Background experiment: on' : '后台实验：已开启') : (en ? 'Enable background experiment' : '开启后台实验')}
      </button>
      <button type="button" onClick={onRefresh} disabled={busy}>{en ? 'Refresh status' : '刷新状态'}</button>
    </div>
    {status ? <p className="menu-section-note" role="status">
      {outcomes[status.lastOutcome] ?? (en ? 'Unknown status' : '状态未知')}
      {status.lastFinishedAt > 0 ? ` · ${new Date(status.lastFinishedAt).toLocaleTimeString(en ? 'en-US' : 'zh-CN', {hour: '2-digit', minute: '2-digit'})}` : ''}
    </p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
