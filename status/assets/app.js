(function () {
  "use strict";

  var STATES = {
    green: { label: "正常", sub: "匿名调用成功" },
    blue: { label: "降级", sub: "仅 API Key 调用成功" },
    red: { label: "故障", sub: "全部调用失败" },
    unknown: { label: "检测中", sub: "等待首轮探测结果" }
  };

  var el = function (id) { return document.getElementById(id); };

  function timeText(ms) {
    if (!ms) return "—";
    return new Date(ms).toLocaleString();
  }

  function uptime(history) {
    if (!history || !history.length) return null;
    var green = history.filter(function (s) { return s === "green"; }).length;
    return (100 * green / history.length).toFixed(1) + "%";
  }

  function renderBars(history) {
    var tail = (history || []).slice(-60);
    return tail.map(function (s) {
      return "<i class=\"" + s + "\" title=\"" + (STATES[s] ? STATES[s].label : s) + "\"></i>";
    }).join("");
  }

  function probeHTML(label, p, offMsg) {
    if (!p) return "";
    var cls = "off", value = offMsg || "未检测";
    if (p.ok) { cls = "ok"; value = "成功 · " + p.latency_ms + " ms"; }
    else if (p.status) { cls = "bad"; value = "失败 · HTTP " + p.status + " · " + p.latency_ms + " ms"; }
    else if (p.error) { cls = "bad"; value = "失败 · " + p.error; }
    return "<div class=\"probe\">" +
      "<div class=\"label\">" + label + "</div>" +
      "<div class=\"value " + cls + "\">" + value + "</div>" +
      (p.error && !p.ok ? "<div class=\"err\" title=\"" + esc(p.error) + "\">" + esc(p.error) + "</div>" : "") +
      "</div>";
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function render(snap) {
    var state = snap.overall || "unknown";
    var banner = el("banner");
    banner.className = "banner " + state;
    el("bannerTitle").textContent = STATES[state].label;
    el("bannerSub").textContent = STATES[state].sub;
    el("lastCheck").textContent = "上次检测：" + timeText(snap.checked_at);
    el("interval").textContent = "检测间隔：" + snap.interval + "s" + (snap.keyed ? "" : " · 未配置 STATUS_API_KEY，仅匿名探测");

    var grid = el("models");
    var models = snap.models || [];
    if (!models.length) {
      grid.innerHTML = "<div class=\"empty muted\">没有可监控的模型</div>";
    } else {
      grid.innerHTML = models.map(function (m) {
        var up = uptime(snap.history && snap.history[m.model]);
        return "<article class=\"card\">" +
          "<div class=\"head\">" +
          "<span class=\"name\">" + esc(m.model) + "</span>" +
          "<span class=\"pill " + m.state + "\"><i></i>" + STATES[m.state].label + "</span>" +
          "</div>" +
          "<div class=\"probes\">" +
          probeHTML("匿名调用（经代理）", m.anonymous) +
          probeHTML("API Key 调用", m.keyed, snap.keyed ? "" : "未配置 API Key") +
          "</div>" +
          (up ? "<div class=\"uptime\">匿名成功率：" + up + "（最近 " + (snap.history[m.model] || []).length + " 轮）</div>" : "") +
          "<div class=\"bars\">" + renderBars(snap.history && snap.history[m.model]) + "</div>" +
          "</article>";
      }).join("");
    }

    var incidents = snap.incidents || [];
    el("incidentsWrap").classList.toggle("hidden", incidents.length === 0);
    el("incidents").innerHTML = incidents.slice(-30).reverse().map(function (inc) {
      return "<li><time>" + timeText(inc.time) + "</time>" +
        "<span class=\"i-model\">" + esc(inc.model) + "</span>" +
        "<span class=\"pill " + inc.from + "\">" + STATES[inc.from].label + "</span>" +
        "<span class=\"arrow\">→</span>" +
        "<span class=\"pill " + inc.to + "\">" + STATES[inc.to].label + "</span>" +
        "<span class=\"muted\">" + esc(inc.detail || "") + "</span></li>";
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
