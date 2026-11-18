package com.alyssa.polaris;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/** Deferrable fallback; exact alarms get a short opportunity to start their protected window first. */
public class HeartbeatWorker extends Worker {
    private final HeartbeatSessionRunner runner = new HeartbeatSessionRunner();
    public HeartbeatWorker(@NonNull Context context, @NonNull WorkerParameters params) { super(context, params); }
    @NonNull @Override public Result doWork() {
        Context context = getApplicationContext();
        String id = getInputData().getString("ruleId"); long at = getInputData().getLong("scheduledFor", -1);
        if (!HeartbeatWork.prefs(context).getBoolean("enabled", false)) return Result.success();
        if (HeartbeatForegroundService.awaitingExactAlarm(context, id, at)) return Result.retry();
        if (isStopped()) return Result.success();
        String outcome = runner.run(context, id, at, "work-manager");
        return "busy".equals(outcome) && getRunAttemptCount() < 2 ? Result.retry() : Result.success();
    }
    @Override public void onStopped() { runner.cancel(); }
}
