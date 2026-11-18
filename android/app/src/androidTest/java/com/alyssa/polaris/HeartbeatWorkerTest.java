package com.alyssa.polaris;

import static org.junit.Assert.*;
import android.content.Context;
import android.os.SystemClock;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.work.*;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;

/** Actual WorkManager jobs, using a synthetic host and no private model/configuration data. */
@RunWith(AndroidJUnit4.class)
public class HeartbeatWorkerTest {
    private Context context;
    private WorkManager manager;
    @Before public void prepare() throws Exception {
        context = ApplicationProvider.getApplicationContext(); manager = WorkManager.getInstance(context);
        manager.cancelAllWorkByTag(HeartbeatWork.TAG).getResult().get(10, TimeUnit.SECONDS);
        HeartbeatWork.prefs(context).edit().clear().commit();
        synchronized (HeartbeatWork.LOCK) { HeartbeatWork.host.clear(); HeartbeatWork.owner = ""; HeartbeatWork.sessions.clear(); }
    }
    @After public void cleanup() throws Exception {
        HeartbeatWork.setEnabled(context, false);
        manager.cancelAllWorkByTag(HeartbeatWork.TAG).getResult().get(10, TimeUnit.SECONDS);
        HeartbeatWork.prefs(context).edit().clear().commit();
        synchronized (HeartbeatWork.LOCK) { HeartbeatWork.host.clear(); HeartbeatWork.owner = ""; }
    }
    private void schedule(String id, long at) throws Exception {
        JSONArray items = new JSONArray().put(new JSONObject().put("ruleId", id).put("scheduledFor", at));
        HeartbeatWork.sync(context, items); HeartbeatWork.setEnabled(context, true);
    }
    private void awaitOutcome(String expected) throws Exception {
        long end = SystemClock.elapsedRealtime() + 20_000;
        while (SystemClock.elapsedRealtime() < end) {
            if (expected.equals(HeartbeatWork.prefs(context).getString("lastOutcome", ""))) return;
            SystemClock.sleep(50);
        }
        fail("Expected worker outcome " + expected + ", got " + HeartbeatWork.prefs(context).getString("lastOutcome", ""));
    }
    @Test public void nativeJobWaitsForRuntimeAcknowledgementAndDoesNotNeedAnActivity() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        HeartbeatWork.Host host = new HeartbeatWork.Host() {
            @Override public void dispatch(String event, String sessionId, String ruleId, long at) {
                if (!"wake".equals(event)) return;
                calls.incrementAndGet();
                assertEquals("synthetic-shared-run", ruleId);
                assertEquals("running", HeartbeatWork.prefs(context).getString("lastOutcome", ""));
                HeartbeatWork.finish(this, sessionId, "completed");
            }
        };
        HeartbeatWork.bind("synthetic-host", host, true);
        schedule("synthetic-shared-run", System.currentTimeMillis() - 1_000);
        awaitOutcome("completed"); assertEquals(1, calls.get());
        assertTrue(HeartbeatWork.prefs(context).getLong("lastStartedAt", 0) > 0);
        assertTrue(HeartbeatWork.prefs(context).getLong("lastFinishedAt", 0) > 0);
        assertFalse(HeartbeatWork.prefs(context).getAll().containsKey("apiKey"));
    }
    @Test public void missingRuntimeLeavesAppointmentForAppOpenInsteadOfInventingSuccess() throws Exception {
        long at = System.currentTimeMillis() - 1_000;
        schedule("synthetic-no-runtime", at); awaitOutcome("runtime-unavailable");
        assertTrue(HeartbeatWork.current(context, "synthetic-no-runtime", at));
        assertEquals(0, HeartbeatWork.prefs(context).getLong("lastStartedAt", 0));
    }
    static class CapturedCall extends PluginCall {
        JSObject result; boolean resolved; String rejected;
        CapturedCall(String method, JSObject data) { super(null, "PolarisHeartbeatWorker", "synthetic-" + method, method, data); }
        @Override public void resolve() { resolved = true; }
        @Override public void resolve(JSObject value) { result = value; resolved = true; }
        @Override public void reject(String message) { rejected = message; }
    }
    @Test public void realPluginRequiresBothListenersAndDoesNotCallAnEmptyHostConnected() throws Exception {
        PolarisHeartbeatWorkerPlugin plugin = new PolarisHeartbeatWorkerPlugin() {
            @Override public Context getContext() { return context; }
        };
        JSObject request = new JSObject(); request.put("owner", "synthetic-plugin-owner"); request.put("ready", true);
        CapturedCall missing = new CapturedCall("runtimeReady", request); plugin.runtimeReady(missing);
        assertNotNull(missing.rejected); assertNull(HeartbeatWork.host.get());
        JSObject wake = new JSObject(); wake.put("eventName", "wake"); plugin.addListener(new CapturedCall("wake", wake));
        CapturedCall onlyOne = new CapturedCall("runtimeReady", request); plugin.runtimeReady(onlyOne); assertNotNull(onlyOne.rejected);
        JSObject stop = new JSObject(); stop.put("eventName", "stop"); plugin.addListener(new CapturedCall("stop", stop));
        CapturedCall ready = new CapturedCall("runtimeReady", request); plugin.runtimeReady(ready); assertTrue(ready.resolved);
        CapturedCall connected = new CapturedCall("status", new JSObject()); plugin.status(connected);
        assertTrue(connected.result.getBoolean("runtimeReady"));
        plugin.removeAllListeners();
        CapturedCall empty = new CapturedCall("status", new JSObject()); plugin.status(empty);
        assertFalse(empty.result.getBoolean("runtimeReady"));
        HeartbeatWork.detach(plugin);
    }
    @Test public void missingRegistrationInSameProcessIsDiagnosedWithoutClaimingProcessDeath() throws Exception {
        HeartbeatWork.noteRegistration(context);
        schedule("synthetic-registration-lost", System.currentTimeMillis() - 1_000);
        awaitOutcome("runtime-unavailable");
        assertEquals("registration-lost", HeartbeatWork.prefs(context).getString("lastMissingReason", ""));
    }
    @Test public void changedProcessTokenIsRecordedAtFailureAndNotOverwrittenByLaterRegistration() throws Exception {
        HeartbeatWork.prefs(context).edit().putString("lastBoundProcess", "synthetic-previous-process").commit();
        schedule("synthetic-process-change", System.currentTimeMillis() - 1_000);
        awaitOutcome("runtime-unavailable");
        assertEquals("process-restarted", HeartbeatWork.prefs(context).getString("lastMissingReason", ""));
        HeartbeatWork.noteRegistration(context);
        assertEquals("process-restarted", HeartbeatWork.prefs(context).getString("lastMissingReason", ""));
    }
    @Test public void disablingBackgroundStopsTheSameActiveSession() throws Exception {
        AtomicInteger stops = new AtomicInteger();
        HeartbeatWork.Host host = (event, id, ruleId, at) -> { if ("stop".equals(event)) stops.incrementAndGet(); };
        HeartbeatWork.bind("synthetic-stop-host", host, true);
        schedule("synthetic-stop", System.currentTimeMillis() - 1_000); awaitOutcome("running");
        HeartbeatWork.setEnabled(context, false); awaitOutcome("aborted");
        long end = SystemClock.elapsedRealtime() + 5_000;
        while (stops.get() == 0 && SystemClock.elapsedRealtime() < end) SystemClock.sleep(20);
        assertTrue(stops.get() > 0); assertFalse(HeartbeatWork.prefs(context).getBoolean("enabled", true));
    }
    @Test public void changedAppointmentCancelsUnstartedNativeWork() throws Exception {
        long at = System.currentTimeMillis() + 60_000;
        schedule("synthetic-cancel", at);
        HeartbeatWork.sync(context, new JSONArray());
        long end = SystemClock.elapsedRealtime() + 10_000; boolean cancelled = false;
        while (SystemClock.elapsedRealtime() < end) {
            List<WorkInfo> jobs = manager.getWorkInfosForUniqueWork(HeartbeatWork.key("synthetic-cancel", at)).get(5, TimeUnit.SECONDS);
            if (!jobs.isEmpty() && jobs.get(0).getState() == WorkInfo.State.CANCELLED) {cancelled = true; break;}
            SystemClock.sleep(50);
        }
        assertTrue(cancelled); assertFalse(HeartbeatWork.current(context, "synthetic-cancel", at));
    }

    @Test public void nativeJobCanDispatchToUnattachedWebViewAndReceiveJavascriptCompletion() throws Exception {
        WebView[] webView = new WebView[1];
        CountDownLatch loaded = new CountDownLatch(1);
        HeartbeatWork.Host host = (event, id, ruleId, at) -> {
            if (!"wake".equals(event)) return;
            webView[0].onResume();
            webView[0].evaluateJavascript("Promise.resolve().then(function(){SyntheticHost.finish(" + JSONObject.quote(id) + ");})", null);
        };
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            webView[0] = new WebView(context);
            webView[0].getSettings().setJavaScriptEnabled(true);
            webView[0].addJavascriptInterface(new Object() {
                @JavascriptInterface public void finish(String id) { HeartbeatWork.finish(host, id, "completed"); }
            }, "SyntheticHost");
            webView[0].setWebViewClient(new WebViewClient() {
                @Override public void onPageFinished(WebView view, String url) { loaded.countDown(); }
            });
            webView[0].loadDataWithBaseURL("https://localhost/", "<html><body>Synthetic background test</body></html>", "text/html", "UTF-8", null);
        });
        try {
            assertTrue(loaded.await(10, TimeUnit.SECONDS));
            HeartbeatWork.bind("synthetic-webview-host", host, true);
            schedule("synthetic-webview", System.currentTimeMillis() - 1_000);
            awaitOutcome("completed");
            assertNull(webView[0].getParent());
        } finally {
            HeartbeatWork.detach(host);
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> webView[0].destroy());
        }
    }
}
