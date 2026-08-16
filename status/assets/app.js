(function () {
  "use strict";

  // state -> {label, pillClass, tooltip}
  var STATES = {
    anonymous: { label: "匿名", cls: "green", sub: "匿名模式运行中" },
    keyed: { label: "已切 Key", cls: "blue", sub: "已切换 API Key（匿名失败）" },
    keyed_failed: { label: "故障", cls: "red", sub: "API Key 也失败（全部失败）" },
    unknown: { label: "未知", cls: "unknown", sub: "暂无状态" }
  };

  var OVERALL = {
    green: { title: "运行正常", sub: "所有模型处于匿名模式，调用正常" },
    blue: { title: "部分降级", sub: "部分模型已切换到 API Key（匿名调用失败）" },
    red: { title: "故障", sub: "存在全部调用失败的模型（API Key 也失败）" },
    unknown: { title: "等待数据…", sub: "正在等待反代上报模型状态" }
  };

  var REASONS = {
    "anonymous_failures": "匿名请求连续失败",
    "server_error": "上游 5xx 重试耗尽",
    "keyed_error": "API Key 调用结果变化",
    "probe_recovered": "匿名探测恢复",
    "reconciled": "与代理校准",
    "initial": "开始监控",
    "circuit open": "熔断打开"
  };

  var el = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function timeText(ms) {
    if (!ms) return "—";
    return new Date(ms).toLocaleString();
  }

  function ago(ms) {
    if (!ms) return "—";
    var d = Math.max(0, Date.now() - ms);
    var s = Math.floor(d / 1000);
    if (s < 60) return s + " 秒";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " 分钟";
    var h = Math.floor(m / 60);
    if (h < 24) return h + " 小时";
    return Math.floor(h / 24) + " 天";
  }

  function reasonText(ev) {
    if (!ev || !ev.reason) return "";
    var r = REASONS[ev.reason] || ev.reason;
    return ev.detail ? r + " · " + ev.detail : r;
  }

  function barsFor(model, timeline) {
    var states = [];
    (timeline || []).forEach(function (ev) {
      if (ev.model !== model || !STATES[ev.to]) return;
      var last = states[states.length - 1];
      if (last === ev.to) return; // dedupe consecutive same states
      states.push(ev.to);
    });
    if (!states.length && STATES[model]) {
      states = ["unknown"];
    }
    return states.slice(-60).map(function (s) {
      return "<i class=\"" + (STATES[s] ? STATES[s].cls : "unknown") + "\" " +
        "title=\"" + (STATES[s] ? STATES[s].label : s) + "\"></i>";
    }).join("");
  }

  function render(snap) {
    var overall = snap.overall || "unknown";
    var ov = OVERALL[overall] || OVERALL.unknown;
    var banner = el("banner");
    banner.className = "banner " + overall;
    el("bannerTitle").textContent = ov.title;
    el("bannerSub").textContent = ov.sub;

    el("lastSync").textContent = "校准：" + timeText(snap.last_reconcile) + " · 间隔 " + snap.interval + "s";
    el("lastEvent").textContent = "最近切换：" + timeText(snap.last_event_at);

    var models = snap.models || [];
    var grid = el("models");
    if (!models.length) {
      grid.innerHTML = "<div class=\"empty muted\">暂无模型状态</div>";
    } else {
      grid.innerHTML = models.map(function (m) {
        var st = STATES[m.state] || STATES.unknown;
        var bars = barsFor(m.model, snap.timeline);
        return "<article class=\"card\">" +
          "<div class=\"head\">" +
          "<span class=\"name\">" + esc(m.model) + "</span>" +
          "<span class=\"pill " + st.cls + "\" title=\"" + st.sub + "\"><i></i>" + st.label + "</span>" +
          "</div>" +
          "<dl class=\"facts\">" +
          "<div><dt>当前状态</dt><dd>" + st.sub + "</dd></div>" +
          "<div><dt>持续时长</dt><dd>" + ago(m.since) + "</dd></div>" +
          "<div><dt>累计切换</dt><dd>" + m.switches + " 次</dd></div>" +
          "<div><dt>最近原因</dt><dd>" + esc(reasonText(m.last_event) || "—") + "</dd></div>" +
          "</dl>" +
          "<div class=\"bars\">" + bars + "</div>" +
          "</article>";
      }).join("");
    }

    var timeline = snap.timeline || [];
    el("timelineWrap").classList.toggle("hidden", timeline.length === 0);
    el("timeline").innerHTML = timeline.slice(-50).reverse().map(function (ev) {
      var from = STATES[ev.from] || { label: "未知", cls: "unknown" };
      var to = STATES[ev.to] || { label: "未知", cls: "unknown" };
      return "<li><time>" + timeText(ev.at) + "</time>" +
        "<span class=\"i-model\">" + esc(ev.model) + "</span>" +
        "<span class=\"pill " + from.cls + "\">" + from.label + "</span>" +
        "<span class=\"arrow\">→</span>" +
        "<span class=\"pill " + to.cls + "\">" + to.label + "</span>" +
        "<span class=\"muted\">" + esc(reasonText(ev)) + "</span></li>";
    }).join("");
  }

  function poll() {
    fetch("/api/status", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
      .then(render)
      .catch(function (err) {
        el("bannerTitle").textContent = "无法获取状态";
        el("bannerSub").textContent = err.message;
      });
  }

  poll();
  setInterval(poll, 5000);
})();
