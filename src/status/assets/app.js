(function () {
  "use strict";

  // ── Constants ─────────────────────────────────────────────
  var H24 = 24 * 60 * 60 * 1000;
  var STORE_KEY = "zenproxy.status.history.v1";

  var STATES = {
    anonymous:   { label: "Operational",      cls: "green",  pill: "pill-green"  },
    keyed:       { label: "Degraded",          cls: "blue",   pill: "pill-blue"   },
    keyed_failed:{ label: "Major Outage",      cls: "red",    pill: "pill-red"    },
    unknown:     { label: "Unknown",           cls: "unknown",pill: "pill-unknown"}
  };

  var OVERALL = {
    anonymous:    { title: "All Systems Operational",  sub: "All models are running in anonymous mode." },
    keyed:        { title: "Partial System Degradation", sub: "Some models have switched to API key mode (anonymous unavailable)." },
    keyed_failed: { title: "Major System Outage",       sub: "Some models have lost all connectivity." },
    unknown:      { title: "Awaiting Data…",            sub: "Waiting for the proxy to report model statuses." }
  };

  var REASONS = {
    "anonymous_failures": "Anonymous consecutive failures",
    "server_error":       "Upstream 5xx retry exhausted",
    "keyed_error":        "API key call failed",
    "probe_recovered":    "Anonymous probe recovered",
    "reconciled":         "Reconciled with proxy",
    "initial":            "Monitoring started",
    "circuit open":       "Circuit breaker opened"
  };

  // ── Helpers ───────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function nowMs() { return Date.now(); }

  function ago(ms) {
    if (!ms) return "—";
    var d = Math.max(0, nowMs() - ms);
    var s = Math.floor(d / 1000);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h";
    return Math.floor(h / 24) + "d";
  }

  function timeShort(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    var ss = String(d.getSeconds()).padStart(2, "0");
    return hh + ":" + mm + ":" + ss;
  }

  function dateKey(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function reasonText(ev) {
    if (!ev || !ev.reason) return "";
    var r = REASONS[ev.reason] || ev.reason;
    return ev.detail ? r + " · " + ev.detail : r;
  }

  // ── Local history (localStorage, keeps last 24h) ──────────
  function loadHistory() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      var cutoff = nowMs() - H24;
      return arr.filter(function (e) { return e && e.at && e.at >= cutoff; });
    } catch (e) { return []; }
  }

  function saveHistory(evs) {
    try {
      var cutoff = nowMs() - H24;
      var kept = (evs || []).filter(function (e) { return e && e.at && e.at >= cutoff; });
      // Cap the payload to avoid unbounded localStorage growth.
      if (kept.length > 1000) kept = kept.slice(kept.length - 1000);
      localStorage.setItem(STORE_KEY, JSON.stringify(kept));
    } catch (e) { /* storage full / unavailable: ignore */ }
  }

  function mergeEvents(a, b) {
    var seen = {};
    var out = [];
    a.concat(b).forEach(function (e) {
      if (!e || !e.at) return;
      var key = e.model + "@" + e.at + "#" + (e.reason || "") + "#" + (e.to || "");
      if (seen[key]) return;
      seen[key] = 1;
      out.push(e);
    });
    out.sort(function (x, y) { return x.at - y.at; });
    return out;
  }

  // Persist the incoming snapshot into localStorage so the page keeps the
  // last 24h of status history even across reloads / server restarts.
  function persistSnapshot(snap) {
    var evs = (snap && snap.timeline) || [];
    var stored = loadHistory();
    saveHistory(mergeEvents(stored, evs));
  }

  // ── Uptime bar ────────────────────────────────────────────
  // Render the last 24h as 48 half-hour segments (default), or the whole
  // available timeline spread across the same number of segments.
  function uptimeBar(model, timeline, nowMsVal, spanMs, segs) {
    var evs = (timeline || []).filter(function (e) {
      return e.model === model && STATES[e.to];
    }).sort(function (a, b) { return a.at - b.at; });
    if (!evs.length) {
      return '<div class="uptime-bar">' + Array(segs).fill('<i></i>').join("") + '</div>';
    }
    var end = nowMsVal;
    var start = Math.min(evs[0].at, end - spanMs);
    var total = Math.max(1, end - start);
    var segDur = total / segs;
    var bars = [];
    for (var s = 0; s < segs; s++) {
      var t0 = start + s * segDur;
      var t1 = t0 + segDur;
      var state = "unknown";
      for (var j = 0; j < evs.length; j++) {
        if (evs[j].at <= t0) state = evs[j].to;
      }
      var cls = state === "anonymous" ? "g" : state === "keyed" ? "b" : state === "keyed_failed" ? "r" : "";
      bars.push('<i class="' + cls + '" title="' + timeShort(t0) + "→" + timeShort(t1) + ' ' + (STATES[state] ? STATES[state].label : state) + '"></i>');
    }
    return '<div class="uptime-bar">' + bars.join("") + '</div>';
  }

  // ── Rendering ─────────────────────────────────────────────
  var state = { window: H24, history: [] };

  function setActiveWindow(ms) {
    state.window = ms;
    var btns = document.querySelectorAll(".window-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("active", Number(btns[i].dataset.ms) === ms);
    }
    try { localStorage.setItem("zenproxy.status.window", String(ms)); } catch (e) {}
  }

  function windowLabel(ms) {
    if (ms === H24) return "Last 24 hours";
    return "All history";
  }

  function render(snap) {
    // Track a local 24h history overlay: merge server timeline with whatever
    // we already stored so the bar keeps showing the last 24h even when the
    // server only reports a short window.
    var serverEvs = (snap && snap.timeline) || [];
    state.history = mergeEvents(state.history, serverEvs);
    var cutoff = nowMs() - H24;
    state.history = state.history.filter(function (e) { return e.at >= cutoff; });
    var timeline = state.history;

    var overall = STATES[snap.overall] ? snap.overall : "unknown";
    var ov = OVERALL[overall] || OVERALL.unknown;
    var stClass = "status-" + (STATES[overall].cls || "unknown");

    // Banner
    var banner = el("statusBanner");
    banner.className = "status-banner " + stClass;
    el("bannerTitle").textContent = ov.title;
    el("bannerSub").textContent = ov.sub;

    // Meta
    el("lastSync").textContent = "Last sync: " + (snap.last_reconcile ? new Date(snap.last_reconcile).toLocaleString() : "—") + " · Interval " + snap.interval + "s · Window: " + windowLabel(state.window);

    // Components
    var models = (snap && snap.models) || [];
    var grid = el("models");
    if (!models.length) {
      grid.innerHTML = '<div class="component-row component-empty"><span class="component-name muted">No model data yet — waiting for proxy report or /debug/modes</span></div>';
    } else {
      var spanMs = state.window;
      var segs = state.window === H24 ? 48 : 24;
      grid.innerHTML = models.map(function (m) {
        var st = STATES[m.state] || STATES.unknown;
        var bar = uptimeBar(m.model, timeline, nowMs(), spanMs, segs);
        var detail = "Duration " + ago(m.since) + " · Switches " + m.switches;
        var reason = reasonText(m.last_event);
        if (reason) detail += " · " + reason;
        return '<div class="component-row">' +
          '<span class="component-name">' + esc(m.model) + '</span>' +
          '<div class="component-right">' +
            '<span class="status-pill ' + st.pill + '"><span class="dot"></span>' + st.label + '</span>' +
          '</div>' +
          bar +
          '<div class="component-detail"><span>' + esc(detail) + '</span></div>' +
        '</div>';
      }).join("");
    }

    // Incidents / timeline
    var section = el("incidentsSection");
    section.classList.toggle("hidden", timeline.length === 0);
    if (timeline.length) {
      // Group by date
      var groups = {};
      var order = [];
      timeline.slice(-80).reverse().forEach(function (ev) {
        var dk = dateKey(ev.at);
        if (!groups[dk]) { groups[dk] = []; order.push(dk); }
        groups[dk].push(ev);
      });
      var html = "";
      order.forEach(function (dk) {
        html += '<div class="incidents-day-header">' + dk + '</div>';
        groups[dk].forEach(function (ev) {
          var from = STATES[ev.from] || { label: "?", pill: "pill-unknown" };
          var to = STATES[ev.to] || { label: "?", pill: "pill-unknown" };
          html += '<div class="incident-row">' +
            '<span class="incident-time">' + timeShort(ev.at) + '</span>' +
            '<span class="incident-model">' + esc(ev.model) + '</span>' +
            '<span class="status-pill ' + from.pill + '"><span class="dot"></span>' + from.label + '</span>' +
            '<span class="incident-arrow">→</span>' +
            '<span class="status-pill ' + to.pill + '"><span class="dot"></span>' + to.label + '</span>' +
            '<span class="incident-reason">' + esc(reasonText(ev)) + '</span>' +
          '</div>';
        });
      });
      el("timeline").innerHTML = html;
    }
  }

  function savedWindow() {
    try {
      var raw = localStorage.getItem("zenproxy.status.window");
      if (raw === "0") return 0;
      if (raw === String(H24)) return H24;
    } catch (e) {}
    return null;
  }

  function applyWindowControls() {
    var wrap = el("windowControls");
    if (!wrap || wrap.dataset.bound) return;
    wrap.dataset.bound = "1";
    wrap.innerHTML =
      '<button class="window-btn" data-ms="' + H24 + '">Last 24 hours</button>' +
      '<button class="window-btn" data-ms="0">All history</button>';
    var btns = wrap.querySelectorAll(".window-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        setActiveWindow(Number(this.dataset.ms));
        render(lastSnap);
      });
    }
    var saved = savedWindow();
    if (saved !== null) state.window = saved;
    setActiveWindow(state.window);
  }

  var lastSnap = null;
  function poll() {
    fetch("/api/status", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
      .then(function (snap) {
        lastSnap = snap;
        persistSnapshot(snap);
        render(snap);
      })
      .catch(function (err) {
        el("bannerTitle").textContent = "Connection Error";
        el("bannerSub").textContent = err.message;
        el("statusBanner").className = "status-banner status-red";
      });
  }

  // Boot: pick up any 24h history already stored locally so a reload shows
  // the last 24h immediately, before the first fetch returns.
  var bootWin = savedWindow();
  if (bootWin !== null) state.window = bootWin;
  state.history = loadHistory();
  render({ overall: "unknown", models: [], timeline: state.history, interval: 0, last_reconcile: 0 });
  applyWindowControls();
  poll();
  setInterval(poll, 5000);
})();
