package com.alyssa.polaris;

import android.app.*;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.work.*;
import java.util.concurrent.TimeUnit;

/** Exact alarms get first chance; the fallback also protects the model/tool execution. */
public class HeartbeatWorker extends Worker {
    static final int NOTICE_ID = 1999000002;
    private final HeartbeatSessionRunner runner = new HeartbeatSessionRunner();
    public HeartbeatWorker(@NonNull Context context, @NonNull WorkerParameters params) { super(context, params); }
    private ForegroundInfo foregroundInfo() {
        Context context = getApplicationContext();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel(
            HeartbeatForegroundService.CHANNEL, "心跳执行状态", NotificationManager.IMPORTANCE_LOW));
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(context, HeartbeatForegroundService.CHANNEL) : new Notification.Builder(context);
        if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        PendingIntent open = PendingIntent.getActivity(context, 2, new Intent(context, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notice = builder.setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("心跳正在运行")
            .setContentText("正在处理预约的模型与工具任务；完成后发送回复通知。")
            .setContentIntent(open).setOngoing(true).setCategory(Notification.CATEGORY_SERVICE)
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "停止本次",
                WorkManager.getInstance(context).createCancelPendingIntent(getId())).build()).build();
        return Build.VERSION.SDK_INT >= 29 ? new ForegroundInfo(NOTICE_ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            : new ForegroundInfo(NOTICE_ID, notice);
    }
    @NonNull @Override public Result doWork() {
        Context context = getApplicationContext();
        String id = getInputData().getString("ruleId"); long at = getInputData().getLong("scheduledFor", -1);
        if (id == null || !HeartbeatWork.current(context, id, at)) return Result.success();
        if (HeartbeatForegroundService.awaitingExactAlarm(context, id, at)) return Result.retry();
        if (isStopped()) return Result.success();
        // No model/tool call until WorkManager has acknowledged its foreground lease.
        boolean protectedWindow = false;
        try {
            setForegroundAsync(foregroundInfo()).get(15, TimeUnit.SECONDS);
            protectedWindow = true;
            HeartbeatWork.prefs(context).edit().putString("lastWindowStatus", "running").commit();
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt(); return Result.success();
        } catch (Exception blocked) {
            HeartbeatWork.prefs(context).edit().putString("lastWindowStatus", "start-blocked").commit();
        }
        if (isStopped()) return Result.success();
        try {
            String outcome = runner.run(context, id, at, protectedWindow ? "work-manager-foreground" : "work-manager");
            return "busy".equals(outcome) && getRunAttemptCount() < 2 ? Result.retry() : Result.success();
        } finally {
            if (protectedWindow) HeartbeatWork.prefs(context).edit().putString("lastWindowStatus", "finished").commit();
        }
    }
    @Override public void onStopped() {
        runner.cancel("work-manager-stopped", getStopReason());
    }
}
