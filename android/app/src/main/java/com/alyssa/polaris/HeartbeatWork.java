package com.alyssa.polaris;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import androidx.work.*;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

/** Native scheduling and bounded hand-off only. Chat, credentials and model calls stay in the existing runtime. */
final class HeartbeatWork {
    static final String PREFS = "polaris-heartbeat-worker-v1";
    static final String PROCESS_TOKEN = UUID.randomUUID().toString();
    static final String TAG = "polaris-heartbeat-worker";
    static final Object LOCK = new Object();
    static final Handler MAIN = new Handler(Looper.getMainLooper());
    interface Host { void dispatch(String event, String sessionId, String ruleId, long at); }
    static WeakReference<Host> host = new WeakReference<>(null);
    static String owner = "";
    static final Map<String, Session> sessions = new HashMap<>();
    static final class Session {
        final String id = UUID.randomUUID().toString();
        final String ruleId;
        final long at;
        final Host target;
        final CompletableFuture<String> result = new CompletableFuture<>();
        Session(String ruleId, long at, Host target) { this.ruleId = ruleId; this.at = at; this.target = target; }
    }
    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    static String key(String ruleId, long at) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest((ruleId + ":" + at).getBytes(StandardCharsets.UTF_8));
            StringBuilder value = new StringBuilder(TAG + "-");
            for (byte b : hash) value.append(String.format(Locale.ROOT, "%02x", b & 255));
            return value.toString();
        } catch (Exception impossible) { throw new IllegalStateException(impossible); }
    }
    static JSONArray appointments(Context c) {
        try { return new JSONArray(prefs(c).getString("appointments", "[]")); }
        catch (JSONException invalid) { return new JSONArray(); }
    }
    static boolean current(Context c, String ruleId, long at) {
        if (!prefs(c).getBoolean("enabled", false)) return false;
        JSONArray items = appointments(c);
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item != null && ruleId.equals(item.optString("ruleId")) && at == item.optLong("scheduledFor")) return true;
        }
        return false;
    }
    static boolean activeKey(String key) {
        for (Session session : sessions.values()) if (key(session.ruleId, session.at).equals(key)) return true;
        return false;
    }
    static void sync(Context c, JSONArray incoming) throws JSONException {
        synchronized (LOCK) {
            if (incoming.length() > 512) throw new JSONException("Too many appointments");
            Set<String> wanted = new HashSet<>();
            for (int i = 0; i < incoming.length(); i++) {
                JSONObject item = incoming.getJSONObject(i);
                String id = item.getString("ruleId"); long at = item.getLong("scheduledFor");
                if (id.trim().isEmpty() || id.length() > 200 || at <= 0 || !wanted.add(key(id, at))) throw new JSONException("Invalid appointment");
            }
            JSONArray previous = appointments(c);
            if (!prefs(c).edit().putString("appointments", incoming.toString()).commit()) throw new IllegalStateException("Schedule save failed");
            WorkManager manager = WorkManager.getInstance(c);
            for (int i = 0; i < previous.length(); i++) {
                JSONObject old = previous.getJSONObject(i);
                String key = key(old.getString("ruleId"), old.getLong("scheduledFor"));
                // Claiming a rule removes its appointment. Do not cancel its active model call here.
                if (!wanted.contains(key) && !activeKey(key)) manager.cancelUniqueWork(key);
            }
            if (prefs(c).getBoolean("enabled", false)) {
                for (int i = 0; i < incoming.length(); i++) {
                    JSONObject item = incoming.getJSONObject(i);
                    enqueue(c, item.getString("ruleId"), item.getLong("scheduledFor"));
                }
            }
        }
    }
    static void enqueue(Context c, String id, long at) {
        Data data = new Data.Builder().putString("ruleId", id).putLong("scheduledFor", at).build();
        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(HeartbeatWorker.class).setInputData(data)
            .setInitialDelay(Math.max(0, at - System.currentTimeMillis()), TimeUnit.MILLISECONDS)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).addTag(TAG).build();
        WorkManager.getInstance(c).enqueueUniqueWork(key(id, at), ExistingWorkPolicy.KEEP, work);
    }
    static void setEnabled(Context c, boolean enabled) throws JSONException {
        synchronized (LOCK) {
            if (!prefs(c).edit().putBoolean("enabled", enabled).commit()) throw new IllegalStateException("Setting save failed");
            if (!enabled) {
                for (Session session : sessions.values()) stop(session);
                WorkManager.getInstance(c).cancelAllWorkByTag(TAG);
            } else sync(c, appointments(c));
        }
    }
    static void bind(String token, Host target, boolean ready) {
        synchronized (LOCK) {
            if (ready) { owner = token; host = new WeakReference<>(target); }
            else if (owner.equals(token) && host.get() == target) detach(target);
        }
    }
    static void detach(Host target) {
        synchronized (LOCK) {
            if (host.get() != target) return;
            host.clear(); owner = "";
            for (Session session : sessions.values()) if (session.target == target) stop(session);
        }
    }
    static void finish(Host target, String id, String outcome) {
        synchronized (LOCK) {
            Session session = sessions.get(id);
            if (session != null && session.target == target) session.result.complete(outcome);
        }
    }
    static void deliver(Session session, String event) {
        try { session.target.dispatch(event, session.id, session.ruleId, session.at); }
        catch (RuntimeException unavailable) { session.result.complete("runtime-unavailable"); }
    }
    static void stop(Session session) {
        MAIN.post(() -> deliver(session, "stop"));
        session.result.complete("aborted");
    }
    static void noteRegistration(Context context) {
        prefs(context).edit().putString("lastBoundProcess", PROCESS_TOKEN).commit();
    }
    static void recordMissingRuntime(Context context) {
        String previous = prefs(context).getString("lastBoundProcess", "");
        String reason = previous.isEmpty() ? "no-registration-record"
            : previous.equals(PROCESS_TOKEN) ? "registration-lost" : "process-restarted";
        prefs(context).edit().putString("lastMissingReason", reason).commit();
        record(context, "runtime-unavailable", false);
    }
    static void record(Context c, String outcome, boolean start) {
        SharedPreferences.Editor edit = prefs(c).edit().putString("lastOutcome", outcome);
        if (start) edit.putLong("lastStartedAt", System.currentTimeMillis()).putLong("lastFinishedAt", 0);
        else edit.putLong("lastFinishedAt", System.currentTimeMillis());
        edit.commit();
    }
}
