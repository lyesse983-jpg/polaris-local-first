package com.alyssa.polaris;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import java.util.concurrent.*;
import org.json.*;

/** Visible, bounded data-transfer execution window. Never sticky, never opens an Activity on its own. */
public class HeartbeatForegroundService extends Service {
    static final String RUN = "polaris.heartbeat.RUN", STOP = "polaris.heartbeat.STOP";
    static final int NOTICE_ID = 1999000001;
    static final String CHANNEL = "polaris-heartbeat-execution-v1";
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final HeartbeatSessionRunner runner = new HeartbeatSessionRunner();
    private PowerManager.WakeLock wakeLock;
    private boolean running;
    private final Runnable deadline = () -> { runner.cancel(); stopSelf(); };

    static boolean awaitingExactAlarm(Context context, String id, long at) {
        if (id == null || at <= 0 || System.currentTimeMillis() > at + 60_000) return false;
        synchronized (HeartbeatWork.LOCK) { if (HeartbeatWork.activeKey(HeartbeatWork.key(id, at))) return false; }
        try {
            JSONArray records = new JSONArray(PolarisTriggerAlarmPlugin.preferences(context).getString(PolarisTriggerAlarmPlugin.SCHEDULES, "[]"));
            for (int i = 0; i < records.length(); i++) {
                JSONObject record = records.getJSONObject(i);
                if (id.equals(record.optString("ruleId")) && at == record.optLong("scheduledFor")) return true;
            }
        } catch (JSONException ignored) { }
        return false;
    }
    static boolean startFromAlarm(Context context, String id, long at) {
        if (!HeartbeatWork.current(context, id, at)) return false;
        try {
            Intent intent = new Intent(context, HeartbeatForegroundService.class).setAction(RUN)
                .putExtra("ruleId", id).putExtra("scheduledFor", at);
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent); else context.startService(intent);
            return true;
        } catch (RuntimeException restricted) {
            HeartbeatWork.prefs(context).edit().putString("lastWindowStatus", "start-blocked").commit(); return false;
        }
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || STOP.equals(intent.getAction())) { runner.cancel(); stopSelf(); return START_NOT_STICKY; }
        if (!RUN.equals(intent.getAction())) { if (!running) stopSelf(); return START_NOT_STICKY; }
        String id = intent.getStringExtra("ruleId"); long at = intent.getLongExtra("scheduledFor", -1);
        if (running) return START_NOT_STICKY;
        if (id == null || at > System.currentTimeMillis() || !HeartbeatWork.current(this, id, at)) { stopSelf(); return START_NOT_STICKY; }
        try {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel channel = new NotificationChannel(CHANNEL, "心跳执行状态", NotificationManager.IMPORTANCE_LOW);
                channel.setDescription("只在模型和工具运行期间显示，完成或停止后退出。"); manager.createNotificationChannel(channel);
            }
            PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, HeartbeatForegroundService.class).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            PendingIntent open = PendingIntent.getActivity(this, 1, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
            if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
            Notification notice = builder.setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("心跳正在运行")
                .setContentText("正在处理预约的模型与工具任务；完成后发送回复通知。")
                .setContentIntent(open).setOngoing(true).setCategory(Notification.CATEGORY_SERVICE)
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "停止本次", stop).build()).build();
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTICE_ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC); else startForeground(NOTICE_ID, notice);
            PowerManager power = getSystemService(PowerManager.class);
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":heartbeat-window");
            wakeLock.acquire(330_000);
        } catch (RuntimeException restricted) {
            HeartbeatWork.prefs(this).edit().putString("lastWindowStatus", "start-blocked").commit(); stopSelf(); return START_NOT_STICKY;
        }
        running = true;
        HeartbeatWork.prefs(this).edit().putString("lastWindowStatus", "running").putLong("lastWindowStartedAt", System.currentTimeMillis()).putLong("lastWindowFinishedAt", 0).commit();
        HeartbeatWork.MAIN.postDelayed(deadline, 330_000);
        executor.execute(() -> {
            try { runner.run(getApplicationContext(), id, at, "foreground-service"); }
            finally { HeartbeatWork.MAIN.post(this::stopSelf); }
        });
        return START_NOT_STICKY;
    }
    @Override public void onTimeout(int startId, int fgsType) { runner.cancel(); stopSelf(); }
    @Override public void onTaskRemoved(Intent intent) { runner.cancel(); stopSelf(); }
    @Override public void onDestroy() {
        runner.cancel(); HeartbeatWork.MAIN.removeCallbacks(deadline); executor.shutdownNow();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (running) HeartbeatWork.prefs(this).edit().putString("lastWindowStatus", "finished").putLong("lastWindowFinishedAt", System.currentTimeMillis()).commit();
        stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy();
    }
}
