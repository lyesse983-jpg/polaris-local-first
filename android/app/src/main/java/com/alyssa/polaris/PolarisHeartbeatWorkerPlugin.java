package com.alyssa.polaris;

import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Arrays;
import org.json.JSONArray;

@CapacitorPlugin(name = "PolarisHeartbeatWorker")
public class PolarisHeartbeatWorkerPlugin extends Plugin implements HeartbeatWork.Host {
    private JSObject snapshot() {
        JSObject status = new JSObject();
        status.put("enabled", HeartbeatWork.prefs(getContext()).getBoolean("enabled", false));
        synchronized (HeartbeatWork.LOCK) { status.put("runtimeReady", HeartbeatWork.host.get() == this && hasListeners("wake") && hasListeners("stop")); }
        for (String field : new String[]{"lastSource", "lastWindowStatus", "lastNotificationStatus"}) status.put(field, HeartbeatWork.prefs(getContext()).getString(field, "none"));
        for (String field : new String[]{"lastWindowStartedAt", "lastWindowFinishedAt", "lastReplySavedAt", "lastNotificationAt"}) status.put(field, HeartbeatWork.prefs(getContext()).getLong(field, 0));
        for (String field : new String[]{"lastStartedInForeground", "lastFinishedInForeground"}) {
            if (HeartbeatWork.prefs(getContext()).contains(field)) status.put(field, HeartbeatWork.prefs(getContext()).getBoolean(field, true));
        }
        status.put("lastMissingReason", HeartbeatWork.prefs(getContext()).getString("lastMissingReason", "unknown"));
        status.put("lastOutcome", HeartbeatWork.prefs(getContext()).getString("lastOutcome", "never"));
        status.put("lastStartedAt", HeartbeatWork.prefs(getContext()).getLong("lastStartedAt", 0));
        status.put("lastFinishedAt", HeartbeatWork.prefs(getContext()).getLong("lastFinishedAt", 0));
        for (String key : Arrays.asList("lastSource", "lastNotificationStatus", "lastWindowStatus")) status.put(key, HeartbeatWork.prefs(getContext()).getString(key, "none"));
        for (String key : Arrays.asList("lastStartedInForeground", "lastFinishedInForeground", "lastReplySavedInForeground")) {
            if (HeartbeatWork.prefs(getContext()).contains(key)) status.put(key, HeartbeatWork.prefs(getContext()).getBoolean(key, false));
        }
        status.put("lastReplySavedAt", HeartbeatWork.prefs(getContext()).getLong("lastReplySavedAt", 0));
        status.put("lastNotificationAt", HeartbeatWork.prefs(getContext()).getLong("lastNotificationAt", 0));
        return status;
    }
    @PluginMethod public void status(PluginCall call) { call.resolve(snapshot()); }
    @PluginMethod public void setEnabled(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) { call.reject("缺少后台实验开关。"); return; }
        try { HeartbeatWork.setEnabled(getContext(), enabled); call.resolve(snapshot()); }
        catch (Exception error) { call.reject("无法保存后台实验设置。"); }
    }
    @PluginMethod public void sync(PluginCall call) {
        JSONArray appointments = call.getArray("appointments");
        if (appointments == null) { call.reject("缺少预约。"); return; }
        try { HeartbeatWork.sync(getContext(), appointments); call.resolve(); }
        catch (Exception error) { call.reject("后台预约同步失败。"); }
    }
    @PluginMethod public void runtimeReady(PluginCall call) {
        String owner = call.getString("owner");
        if (owner == null || owner.length() > 200) { call.reject("无效运行环境。"); return; }
        boolean ready = Boolean.TRUE.equals(call.getBoolean("ready"));
        if (ready && (!hasListeners("wake") || !hasListeners("stop"))) {
            call.reject("后台执行监听尚未就绪。"); return;
        }
        HeartbeatWork.bind(owner, this, ready);
        if (ready) HeartbeatWork.noteRegistration(getContext());
        call.resolve();
    }
    @PluginMethod public void finish(PluginCall call) {
        String id = call.getString("sessionId"), outcome = call.getString("outcome");
        if (id == null || !Arrays.asList("completed", "failed", "aborted", "busy", "stale").contains(outcome)) {
            call.reject("无效后台执行结果。"); return;
        }
        HeartbeatWork.finish(this, id, outcome); call.resolve();
    }
    @PluginMethod public void progress(PluginCall call) {
        String id = call.getString("sessionId"), phase = call.getString("phase");
        synchronized (HeartbeatWork.LOCK) {
            HeartbeatWork.Session session = HeartbeatWork.sessions.get(id);
            if (session == null || session.target != this || session.result.isDone()) { call.resolve(); return; }
            android.content.SharedPreferences.Editor edit = HeartbeatWork.prefs(getContext()).edit();
            if ("reply-saved".equals(phase)) edit.putLong("lastReplySavedAt", System.currentTimeMillis()).putBoolean("lastReplySavedInForeground", isForeground());
            else if ("reply-notification".equals(phase)) {
                String delivery = call.getString("delivery");
                if (!Arrays.asList("synced", "denied", "failed", "unavailable", "exact-denied").contains(delivery)) { call.reject("无效投递状态。"); return; }
                edit.putLong("lastNotificationAt", System.currentTimeMillis()).putString("lastNotificationStatus", delivery);
            } else { call.reject("无效执行阶段。"); return; }
            edit.commit();
        }
        call.resolve();
    }
    @Override public boolean isForeground() { return getBridge().getApp().isActive(); }
    @Override public void prepare() {
        if (getBridge().getWebView() != null) {
            getBridge().getWebView().onResume();
            getBridge().getWebView().resumeTimers();
        }
    }
    @Override public void dispatch(String event, String id, String ruleId, long at) {
        // onPause() does not kill JS, but explicitly resume this WebView before a native wake.
        if (getBridge().getWebView() != null) getBridge().getWebView().onResume();
        JSObject data = new JSObject(); data.put("sessionId", id); data.put("ruleId", ruleId); data.put("scheduledFor", at);
        notifyListeners(event, data, false);
    }
    @Override protected void handleOnDestroy() { HeartbeatWork.detach(this); }
}
