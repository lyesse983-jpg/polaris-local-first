package com.alyssa.polaris;

import static org.junit.Assert.*;
import android.app.*;
import android.content.*;
import android.os.*;
import android.webkit.*;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.work.WorkManager;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;

/** Foreground execution window under a stopped real Activity; only synthetic JavaScript/data. */
@RunWith(AndroidJUnit4.class)
public class HeartbeatForegroundServiceTest {
    private Context context;
    private ActivityScenario<MainActivity> scenario;
    private MainActivity activity;
    private WebView view;
    private HeartbeatWork.Host host;
    private final AtomicBoolean completedInBackground = new AtomicBoolean();
    @Before public void prepare() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        WorkManager.getInstance(context).cancelAllWorkByTag(HeartbeatWork.TAG).getResult().get(10, TimeUnit.SECONDS);
        HeartbeatWork.prefs(context).edit().clear().commit();
        PolarisTriggerAlarmPlugin.preferences(context).edit().clear().commit();
        synchronized (HeartbeatWork.LOCK) { HeartbeatWork.host.clear(); HeartbeatWork.sessions.clear(); HeartbeatWork.owner = ""; }
        if (Build.VERSION.SDK_INT >= 33) InstrumentationRegistry.getInstrumentation().getUiAutomation()
            .grantRuntimePermission(context.getPackageName(), "android.permission.POST_NOTIFICATIONS");
        // Emulator-only grant for the genuine exact-alarm exemption; production still requires user authorization.
        ParcelFileDescriptor fd = InstrumentationRegistry.getInstrumentation().getUiAutomation()
            .executeShellCommand("appops set " + context.getPackageName() + " SCHEDULE_EXACT_ALARM allow");
        try (java.io.InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(fd)) { while (input.read() != -1) { } }
    }
    @After public void cleanup() throws Exception {
        context.stopService(new Intent(context, HeartbeatForegroundService.class));
        HeartbeatWork.setEnabled(context, false);
        if (host != null) HeartbeatWork.detach(host);
        if (scenario != null) scenario.close();
        WorkManager.getInstance(context).cancelAllWorkByTag(HeartbeatWork.TAG).getResult().get(10, TimeUnit.SECONDS);
        HeartbeatWork.prefs(context).edit().clear().commit();
        PolarisTriggerAlarmPlugin.preferences(context).edit().clear().commit();
    }
    private void await(BooleanSupplier condition) throws Exception {
        long until = SystemClock.elapsedRealtime() + 25_000;
        while (SystemClock.elapsedRealtime() < until) { if (condition.getAsBoolean()) return; SystemClock.sleep(50); }
        fail("Timed out waiting for synthetic execution: " + HeartbeatWork.prefs(context).getString("lastOutcome", "none"));
    }
    private void openFixture(boolean hold) throws Exception {
        scenario = ActivityScenario.launch(MainActivity.class);
        await(() -> HeartbeatWork.host.get() != null);
        CountDownLatch loaded = new CountDownLatch(1);
        scenario.onActivity(current -> {
            activity = current; view = current.getBridge().getWebView();
            view.addJavascriptInterface(new Object() {
                @JavascriptInterface public void finish(String id) {
                    completedInBackground.set(!activity.getBridge().getApp().isActive());
                    HeartbeatWork.finish(host, id, "completed");
                }
            }, "SyntheticExecution");
            view.setWebViewClient(new WebViewClient() {
                @Override public void onPageFinished(WebView v, String url) { loaded.countDown(); }
            });
            view.loadDataWithBaseURL("https://localhost/", "<html><body>Synthetic stopped-Activity test</body></html>", "text/html", "UTF-8", null);
        });
        assertTrue(loaded.await(15, TimeUnit.SECONDS));
        host = new HeartbeatWork.Host() {
            @Override public void prepare() { view.onResume(); view.resumeTimers(); }
            @Override public boolean isForeground() { return activity.getBridge().getApp().isActive(); }
            @Override public void dispatch(String event, String id, String ruleId, long at) {
                if ("wake".equals(event) && !hold) view.evaluateJavascript("setTimeout(function(){SyntheticExecution.finish(" + JSONObject.quote(id) + ");},300)", null);
            }
        };
        HeartbeatWork.bind("synthetic-stopped-activity", host, true);
    }
    private void project(String id, long at) throws Exception {
        HeartbeatWork.sync(context, new JSONArray().put(new JSONObject().put("ruleId", id).put("scheduledFor", at)));
        HeartbeatWork.setEnabled(context, true);
    }
    @Test public void exactAlarmStartsForegroundWindowAndFinishesWhileRealActivityRemainsStopped() throws Exception {
        openFixture(false); scenario.moveToState(Lifecycle.State.CREATED);
        assertFalse(activity.getBridge().getApp().isActive());
        long at = System.currentTimeMillis() + 1_500;
        String id = "synthetic-window-alarm", token = "synthetic-window-nonce";
        JSONObject record = new JSONObject().put("ruleId", id).put("scheduledFor", at).put("token", token)
            .put("id", 139921).put("title", "Synthetic alarm").put("body", "Synthetic appointment");
        PolarisTriggerAlarmPlugin.preferences(context).edit().putString(PolarisTriggerAlarmPlugin.SCHEDULES, new JSONArray().put(record).toString()).commit();
        project(id, at);
        Intent broadcast = new Intent(context, PolarisTriggerAlarmReceiver.class).setAction(PolarisTriggerAlarmPlugin.alarmAction(context))
            .putExtra(PolarisTriggerAlarmPlugin.EXTRA_RULE_ID, id).putExtra(PolarisTriggerAlarmPlugin.EXTRA_TOKEN, token)
            .putExtra(PolarisTriggerAlarmPlugin.EXTRA_SCHEDULED_FOR, at);
        PendingIntent pending = PendingIntent.getBroadcast(context, 139921, broadcast, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        assertTrue(alarms.canScheduleExactAlarms());
        alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        await(() -> "completed".equals(HeartbeatWork.prefs(context).getString("lastOutcome", "")));
        await(() -> "finished".equals(HeartbeatWork.prefs(context).getString("lastWindowStatus", "")));
        assertTrue(completedInBackground.get());
        assertEquals("foreground-service", HeartbeatWork.prefs(context).getString("lastSource", ""));
        assertFalse(HeartbeatWork.prefs(context).getBoolean("lastStartedInForeground", true));
        assertFalse(HeartbeatWork.prefs(context).getBoolean("lastFinishedInForeground", true));
        assertFalse(activity.getBridge().getApp().isActive());
        context.getSystemService(NotificationManager.class).cancel(id, 139921);
    }
    @Test public void notificationStopActionAbortsTheProtectedSessionAndRemovesRunningNotice() throws Exception {
        openFixture(true);
        long at = System.currentTimeMillis() - 1;
        project("synthetic-window-stop", at);
        assertTrue(HeartbeatForegroundService.startFromAlarm(context, "synthetic-window-stop", at));
        await(() -> "running".equals(HeartbeatWork.prefs(context).getString("lastWindowStatus", "")));
        scenario.moveToState(Lifecycle.State.CREATED);
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        Notification[] notice = new Notification[1];
        await(() -> {
            for (android.service.notification.StatusBarNotification item : manager.getActiveNotifications()) {
                if (item.getId() == HeartbeatForegroundService.NOTICE_ID) { notice[0] = item.getNotification(); return true; }
            }
            return false;
        });
        notice[0].actions[0].actionIntent.send();
        await(() -> "aborted".equals(HeartbeatWork.prefs(context).getString("lastOutcome", "")));
        await(() -> "finished".equals(HeartbeatWork.prefs(context).getString("lastWindowStatus", "")));
        await(() -> {
            for (android.service.notification.StatusBarNotification item : manager.getActiveNotifications()) if (item.getId() == HeartbeatForegroundService.NOTICE_ID) return false;
            return true;
        });
    }
    @Test public void invalidAlarmNonceCannotStartAnExecutionWindow() throws Exception {
        long at = System.currentTimeMillis() - 1;
        project("synthetic-invalid-window", at);
        JSONObject record = new JSONObject().put("ruleId", "synthetic-invalid-window").put("scheduledFor", at).put("token", "expected")
            .put("id", 139922).put("title", "Synthetic").put("body", "Synthetic");
        PolarisTriggerAlarmPlugin.preferences(context).edit().putString(PolarisTriggerAlarmPlugin.SCHEDULES, new JSONArray().put(record).toString()).commit();
        Intent wrong = new Intent(context, PolarisTriggerAlarmReceiver.class).setAction(PolarisTriggerAlarmPlugin.alarmAction(context))
            .putExtra(PolarisTriggerAlarmPlugin.EXTRA_RULE_ID, "synthetic-invalid-window").putExtra(PolarisTriggerAlarmPlugin.EXTRA_TOKEN, "wrong")
            .putExtra(PolarisTriggerAlarmPlugin.EXTRA_SCHEDULED_FOR, at);
        new PolarisTriggerAlarmReceiver().onReceive(context, wrong);
        assertFalse(HeartbeatWork.prefs(context).contains("lastWindowStartedAt"));
    }
}
