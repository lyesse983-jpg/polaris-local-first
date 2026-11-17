package com.alyssa.polaris;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Receives an exact alarm and shows a notification. Model execution resumes only inside Polaris. */
public class PolarisTriggerAlarmReceiver extends BroadcastReceiver {
    private static final String CHANNEL_ID = "polaris-triggers";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !PolarisTriggerAlarmPlugin.alarmAction(context).equals(intent.getAction())) return;
        String ruleId = intent.getStringExtra(PolarisTriggerAlarmPlugin.EXTRA_RULE_ID);
        String token = intent.getStringExtra(PolarisTriggerAlarmPlugin.EXTRA_TOKEN);
        long scheduledFor = intent.getLongExtra(PolarisTriggerAlarmPlugin.EXTRA_SCHEDULED_FOR, -1);
        if (ruleId == null || token == null || scheduledFor <= 0) return;
        synchronized (PolarisTriggerAlarmPlugin.STATE_LOCK) {
            try {
                SharedPreferences prefs = PolarisTriggerAlarmPlugin.preferences(context);
                JSONArray schedules = new JSONArray(prefs.getString(PolarisTriggerAlarmPlugin.SCHEDULES, "[]"));
                JSONObject record = null;
                for (int i = 0; i < schedules.length(); i++) {
                    JSONObject candidate = schedules.getJSONObject(i);
                    if (ruleId.equals(candidate.optString("ruleId"))
                        && scheduledFor == candidate.optLong("scheduledFor")
                        && token.equals(candidate.optString("token"))) {
                        record = candidate;
                        break;
                    }
                }
                if (record == null || scheduledFor > System.currentTimeMillis() + 1_000) return;
                NotificationManager manager = context.getSystemService(NotificationManager.class);
                if (manager == null || !manager.areNotificationsEnabled()) return;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                    && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "主动消息", NotificationManager.IMPORTANCE_HIGH);
                    channel.setDescription("协作者预约的唤醒提醒。点击后在 Polaris 中继续运行。");
                    manager.createNotificationChannel(channel);
                }
                JSONObject tokens = new JSONObject(prefs.getString(PolarisTriggerAlarmPlugin.TAP_TOKENS, "{}"));
                // This is a bounded set of notification launch nonces, not chat or persona data.
                if (tokens.length() >= 128) tokens = new JSONObject();
                tokens.put(PolarisTriggerAlarmPlugin.tapKey(ruleId, scheduledFor), token);
                if (!prefs.edit().putString(PolarisTriggerAlarmPlugin.TAP_TOKENS, tokens.toString()).commit()) return;
                Intent launch = new Intent(context, MainActivity.class)
                    .setAction(PolarisTriggerAlarmPlugin.tapAction(context))
                    .setData(new Uri.Builder().scheme("polaris-trigger").authority("tap").appendPath(ruleId).appendPath(Long.toString(scheduledFor)).build())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra(PolarisTriggerAlarmPlugin.EXTRA_RULE_ID, ruleId)
                    .putExtra(PolarisTriggerAlarmPlugin.EXTRA_SCHEDULED_FOR, scheduledFor)
                    .putExtra(PolarisTriggerAlarmPlugin.EXTRA_TOKEN, token);
                PendingIntent tap = PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(context, CHANNEL_ID)
                    : new Notification.Builder(context);
                Notification notification = builder
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentTitle(record.getString("title"))
                    .setContentText(record.getString("body"))
                    .setStyle(new Notification.BigTextStyle().bigText(record.getString("body")))
                    .setContentIntent(tap)
                    .setAutoCancel(true)
                    .setCategory(Notification.CATEGORY_REMINDER)
                    .build();
                manager.notify(ruleId, record.getInt("id"), notification);
            } catch (JSONException | RuntimeException invalidState) {
                // An invalid or cancelled native projection must never synthesize a notification.
            }
        }
    }
}
