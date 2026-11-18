package com.alyssa.polaris;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.util.concurrent.TimeUnit;

/** A bounded WorkManager execution window for the already-initialized shared Capacitor runtime. */
public class HeartbeatWorker extends Worker {
    private volatile HeartbeatWork.Session session;
    public HeartbeatWorker(@NonNull Context context, @NonNull WorkerParameters params) { super(context, params); }
    @NonNull @Override public Result doWork() {
        Context context = getApplicationContext();
        String ruleId = getInputData().getString("ruleId"); long at = getInputData().getLong("scheduledFor", -1);
        synchronized (HeartbeatWork.LOCK) {
            if (ruleId == null || at > System.currentTimeMillis() || !HeartbeatWork.current(context, ruleId, at)) return Result.success();
            HeartbeatWork.Host host = HeartbeatWork.host.get();
            if (host == null) {
                HeartbeatWork.recordMissingRuntime(context);
                // Never start a hidden Activity or synthesize a reply. Existing app-open fallback retains the rule.
                return Result.success();
            }
            if (!HeartbeatWork.sessions.isEmpty()) return getRunAttemptCount() < 2 ? Result.retry() : Result.success();
            session = new HeartbeatWork.Session(ruleId, at, host);
            HeartbeatWork.sessions.put(session.id, session);
            HeartbeatWork.record(context, "running", true);
        }
        HeartbeatWork.Session current = session;
        HeartbeatWork.MAIN.post(() -> {
            if (!current.result.isDone()) HeartbeatWork.deliver(current, "wake");
        });
        String outcome;
        try { outcome = current.result.get(5 * 60 + 15, TimeUnit.SECONDS); }
        catch (Exception timeoutOrStop) { HeartbeatWork.stop(current); outcome = isStopped() ? "aborted" : "timeout"; }
        synchronized (HeartbeatWork.LOCK) { HeartbeatWork.sessions.remove(current.id); }
        if ("runtime-unavailable".equals(outcome)) HeartbeatWork.prefs(context).edit().putString("lastMissingReason", "dispatch-failed").commit();
        HeartbeatWork.record(context, outcome, false);
        return "busy".equals(outcome) && getRunAttemptCount() < 2 ? Result.retry() : Result.success();
    }
    @Override public void onStopped() {
        HeartbeatWork.Session current = session;
        if (current != null) HeartbeatWork.stop(current);
    }
}
