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
        synchronized (HeartbeatWork.LOCK) { status.put("runtimeReady", HeartbeatWork.host.get() != null); }
        status.put("lastOutcome", HeartbeatWork.prefs(getContext()).getString("lastOutcome", "never"));
        status.put("lastStartedAt", HeartbeatWork.prefs(getContext()).getLong("lastStartedAt", 0));
        status.put("lastFinishedAt", HeartbeatWork.prefs(getContext()).getLong("lastFinishedAt", 0));
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
        HeartbeatWork.bind(owner, this, Boolean.TRUE.equals(call.getBoolean("ready"))); call.resolve();
    }
    @PluginMethod public void finish(PluginCall call) {
        String id = call.getString("sessionId"), outcome = call.getString("outcome");
        if (id == null || !Arrays.asList("completed", "failed", "aborted", "busy", "stale").contains(outcome)) {
            call.reject("无效后台执行结果。"); return;
        }
        HeartbeatWork.finish(this, id, outcome); call.resolve();
    }
    @Override public void dispatch(String event, String id, String ruleId, long at) {
        // onPause() does not kill JS, but explicitly resume this WebView before a native wake.
        if (getBridge().getWebView() != null) getBridge().getWebView().onResume();
        JSObject data = new JSObject(); data.put("sessionId", id); data.put("ruleId", ruleId); data.put("scheduledFor", at);
        notifyListeners(event, data, false);
    }
    @Override protected void handleOnDestroy() { HeartbeatWork.detach(this); }
}
