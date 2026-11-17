package com.alyssa.polaris;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Schedules system notifications only. It never calls a model or opens an Activity on an alarm. */
@CapacitorPlugin(name = "PolarisTriggerAlarm")
public class PolarisTriggerAlarmPlugin extends Plugin {
    static final Object STATE_LOCK = new Object();
    static final String PREFS = "polaris-trigger-alarms-v1";
    static final String SCHEDULES = "schedules";
    static final String TAP_TOKENS = "tap-tokens";
    static final String EXTRA_RULE_ID = "polarisRuleId";
    static final String EXTRA_SCHEDULED_FOR = "polarisScheduledFor";
    static final String EXTRA_TOKEN = "polarisTriggerToken";
    private static final String EVENT = "triggerAlarmReceived";
    private JSObject pendingLaunch;

    static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String alarmAction(Context context) {
        return context.getPackageName() + ".POLARIS_TRIGGER_ALARM";
    }

    static String tapAction(Context context) {
        return context.getPackageName() + ".POLARIS_TRIGGER_TAP";
    }

    static String tapKey(String ruleId, long scheduledFor) {
        return ruleId + ":" + scheduledFor;
    }

    static PendingIntent alarmPendingIntent(Context context, String ruleId, JSONObject record) {
        Intent intent = new Intent(context, PolarisTriggerAlarmReceiver.class)
            .setAction(alarmAction(context))
            .setData(new Uri.Builder().scheme("polaris-trigger").authority("alarm").appendPath(ruleId).build());
        if (record != null) {
            intent.putExtra(EXTRA_RULE_ID, ruleId);
            intent.putExtra(EXTRA_SCHEDULED_FOR, record.optLong("scheduledFor", -1));
            intent.putExtra(EXTRA_TOKEN, record.optString("token", ""));
        }
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private boolean exactAlarmAllowed() {
        AlarmManager manager = getContext().getSystemService(AlarmManager.class);
        return manager != null && (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.canScheduleExactAlarms());
    }

    private JSObject exactAlarmResult(boolean allowed) {
        JSObject result = new JSObject();
        result.put("exactAlarm", allowed ? "granted" : "denied");
        return result;
    }

    @Override
    public void load() {
        super.load();
        pendingLaunch = consumeIntent(getActivity().getIntent());
    }

    @PluginMethod
    public void checkExactAlarmSetting(PluginCall call) {
        call.resolve(exactAlarmResult(exactAlarmAllowed()));
    }

    @PluginMethod
    public void openExactAlarmSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || exactAlarmAllowed()) {
            call.resolve(exactAlarmResult(true));
            return;
        }
        Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
            .setData(Uri.parse("package:" + getContext().getPackageName()));
        try {
            startActivityForResult(call, intent, "exactAlarmSettingsResult");
        } catch (RuntimeException error) {
            call.reject("无法打开系统精确闹钟设置。");
        }
    }

    @ActivityCallback
    private void exactAlarmSettingsResult(PluginCall call, ActivityResult activityResult) {
        if (call != null) call.resolve(exactAlarmResult(exactAlarmAllowed()));
    }

    @PluginMethod
    public void sync(PluginCall call) {
        JSArray incoming = call.getArray("notifications");
        if (incoming == null || incoming.length() > 512) {
            call.reject("notifications 必须是最多 512 项的数组。");
            return;
        }
        AlarmManager manager = getContext().getSystemService(AlarmManager.class);
        if (manager == null) {
            call.reject("系统闹钟服务不可用。");
            return;
        }
        try {
            synchronized (STATE_LOCK) {
                SharedPreferences prefs = preferences(getContext());
                JSONArray previous = new JSONArray(prefs.getString(SCHEDULES, "[]"));
                Map<String, JSONObject> previousByRule = new HashMap<>();
                for (int i = 0; i < previous.length(); i++) {
                    JSONObject item = previous.getJSONObject(i);
                    previousByRule.put(item.getString("ruleId"), item);
                }
                JSONArray prepared = new JSONArray();
                Set<String> ids = new HashSet<>();
                long now = System.currentTimeMillis();
                for (int i = 0; i < incoming.length(); i++) {
                    JSONObject item = incoming.getJSONObject(i);
                    String ruleId = requiredText(item, "ruleId", 200);
                    if (!ids.add(ruleId)) throw new JSONException("重复规则。");
                    long id = item.getLong("id");
                    long scheduledFor = item.getLong("scheduledFor");
                    if (id < 1 || id > Integer.MAX_VALUE || scheduledFor <= now) {
                        throw new JSONException("无效通知 ID 或时间。");
                    }
                    JSONObject old = previousByRule.get(ruleId);
                    String token = old != null && old.optLong("scheduledFor") == scheduledFor
                        ? old.optString("token", UUID.randomUUID().toString())
                        : UUID.randomUUID().toString();
                    JSONObject record = new JSONObject();
                    record.put("id", id);
                    record.put("ruleId", ruleId);
                    record.put("title", requiredText(item, "title", 300));
                    record.put("body", requiredText(item, "body", 1000));
                    record.put("scheduledFor", scheduledFor);
                    record.put("token", token);
                    prepared.put(record);
                }
                boolean allowed = exactAlarmAllowed();
                JSONArray committed = allowed ? prepared : new JSONArray();
                // Persist the desired generation first. A late old broadcast cannot post a stale notification.
                if (!prefs.edit().putString(SCHEDULES, committed.toString()).commit()) {
                    call.reject("无法保存系统闹钟状态。");
                    return;
                }
                for (int i = 0; i < previous.length(); i++) {
                    JSONObject item = previous.getJSONObject(i);
                    PendingIntent pending = alarmPendingIntent(getContext(), item.getString("ruleId"), null);
                    manager.cancel(pending);
                    pending.cancel();
                }
                if (allowed) {
                    try {
                        for (int i = 0; i < committed.length(); i++) {
                            JSONObject record = committed.getJSONObject(i);
                            manager.setExactAndAllowWhileIdle(
                                AlarmManager.RTC_WAKEUP,
                                record.getLong("scheduledFor"),
                                alarmPendingIntent(getContext(), record.getString("ruleId"), record)
                            );
                        }
                    } catch (SecurityException revokedDuringSync) {
                        prefs.edit().putString(SCHEDULES, "[]").commit();
                        for (int i = 0; i < committed.length(); i++) {
                            JSONObject item = committed.getJSONObject(i);
                            PendingIntent pending = alarmPendingIntent(getContext(), item.getString("ruleId"), null);
                            manager.cancel(pending);
                            pending.cancel();
                        }
                        call.resolve(exactAlarmResult(false));
                        return;
                    }
                }
                call.resolve(exactAlarmResult(allowed));
            }
        } catch (JSONException | IllegalArgumentException error) {
            call.reject("系统闹钟数据无效，未完成同步。");
        }
    }

    private static String requiredText(JSONObject item, String key, int maximum) throws JSONException {
        Object raw = item.get(key);
        if (!(raw instanceof String)) throw new JSONException("无效文本。");
        String value = ((String) raw).trim();
        if (value.isEmpty() || value.length() > maximum) throw new JSONException("无效文本长度。");
        return value;
    }

    /** A tap is accepted only when a non-exported receiver previously published its private nonce. */
    private JSObject consumeIntent(Intent intent) {
        if (intent == null || !tapAction(getContext()).equals(intent.getAction())) return null;
        String ruleId = intent.getStringExtra(EXTRA_RULE_ID);
        String token = intent.getStringExtra(EXTRA_TOKEN);
        long scheduledFor = intent.getLongExtra(EXTRA_SCHEDULED_FOR, -1);
        if (ruleId == null || ruleId.isEmpty() || ruleId.length() > 200 || token == null || scheduledFor <= 0) return null;
        synchronized (STATE_LOCK) {
            try {
                SharedPreferences prefs = preferences(getContext());
                JSONObject tokens = new JSONObject(prefs.getString(TAP_TOKENS, "{}"));
                String key = tapKey(ruleId, scheduledFor);
                if (!token.equals(tokens.optString(key, ""))) return null;
                tokens.remove(key);
                if (!prefs.edit().putString(TAP_TOKENS, tokens.toString()).commit()) return null;
                JSObject result = new JSObject();
                result.put("ruleId", ruleId);
                result.put("scheduledFor", scheduledFor);
                return result;
            } catch (JSONException error) {
                return null;
            }
        }
    }

    @PluginMethod
    public synchronized void consumeLaunchTrigger(PluginCall call) {
        JSObject result = new JSObject();
        result.put("trigger", pendingLaunch == null ? JSONObject.NULL : pendingLaunch);
        pendingLaunch = null;
        call.resolve(result);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        JSObject trigger = consumeIntent(intent);
        if (trigger == null) return;
        synchronized (this) {
            if (hasListeners(EVENT)) {
                pendingLaunch = null;
                notifyListeners(EVENT, trigger);
            } else {
                pendingLaunch = trigger;
            }
        }
    }
}
