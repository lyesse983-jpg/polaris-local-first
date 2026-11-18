package com.alyssa.polaris;

import android.content.Context;
import android.os.SystemClock;
import java.util.concurrent.TimeUnit;

/** One native lease, shared by exact-alarm foreground windows and WorkManager fallback. */
final class HeartbeatSessionRunner {
    private volatile HeartbeatWork.Session active;
    private volatile boolean cancelled;
    String run(Context context, String ruleId, long at, String source) {
        HeartbeatWork.Session session;
        synchronized (HeartbeatWork.LOCK) {
            if (cancelled) return "aborted";
            if (ruleId == null || at > System.currentTimeMillis() || !HeartbeatWork.prefs(context).getBoolean("enabled", false)) return "stale";
            session = null;
            for (HeartbeatWork.Session current : HeartbeatWork.sessions.values()) {
                if (current.ruleId.equals(ruleId) && current.at == at) { session = current; break; }
            }
            if (session == null) {
                if (!HeartbeatWork.current(context, ruleId, at)) return "stale";
                if (!HeartbeatWork.sessions.isEmpty()) return "busy";
                HeartbeatWork.prefs(context).edit().putString("lastSource", source)
                    .remove("lastStartedInForeground").remove("lastFinishedInForeground").remove("lastReplySavedInForeground")
                    .putLong("lastScheduledFor", at).putString("lastStopReason", "none").putInt("lastWorkerStopReason", -256)
                    .putLong("lastReplySavedAt", 0).putLong("lastNotificationAt", 0).putString("lastNotificationStatus", "none").commit();
                HeartbeatWork.Host host = HeartbeatWork.host.get();
                if (host == null) { HeartbeatWork.recordMissingRuntime(context); return "runtime-unavailable"; }
                session = new HeartbeatWork.Session(context, ruleId, at, host);
                HeartbeatWork.sessions.put(session.id, session); session.ownerRunner = this;
                HeartbeatWork.prefs(context).edit().putBoolean("lastStartedInForeground", host.isForeground()).commit();
                HeartbeatWork.record(context, "running", true);
            }
            if (session.ownerRunner != this) {
                if (session.result.isDone()) return "already-running";
                if (!"foreground-service".equals(source)) return "already-running";
                // The protected window takes the lease; stopping a fallback Worker cannot cancel it.
                session.ownerRunner = this;
                HeartbeatWork.prefs(context).edit().putString("lastSource", source).commit();
            }
            active = session;
        }
        HeartbeatWork.Session current = session;
        if (cancelled) cancel();
        HeartbeatWork.MAIN.post(() -> {
            if (!current.result.isDone()) {
                try { current.target.prepare(); HeartbeatWork.deliver(current, "wake"); }
                catch (RuntimeException unavailable) { current.result.complete("runtime-unavailable"); }
            }
        });
        String outcome;
        try { outcome = current.result.get(Math.max(1, current.deadline - SystemClock.elapsedRealtime()), TimeUnit.MILLISECONDS); }
        catch (InterruptedException stopped) { cancel(); Thread.currentThread().interrupt(); outcome = "aborted"; }
        catch (Exception timeout) { cancel(); outcome = "timeout"; }
        synchronized (HeartbeatWork.LOCK) {
            if (current.ownerRunner == this) {
                HeartbeatWork.sessions.remove(current.id);
                if ("runtime-unavailable".equals(outcome)) HeartbeatWork.prefs(context).edit().putString("lastMissingReason", "dispatch-failed").commit();
                HeartbeatWork.prefs(context).edit().putBoolean("lastFinishedInForeground", current.target.isForeground()).commit();
                HeartbeatWork.record(context, outcome, false);
            }
        }
        active = null;
        return outcome;
    }
    void cancel() { cancel("native-cancelled"); }
    void cancel(String reason) { cancel(reason, -256); }
    void cancel(String reason, int workerStopReason) {
        cancelled = true;
        HeartbeatWork.Session session = active;
        synchronized (HeartbeatWork.LOCK) {
            if (session != null && session.ownerRunner == this && !session.result.isDone()) HeartbeatWork.stop(session, reason, workerStopReason);
        }
    }
}
