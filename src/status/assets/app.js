(function () {
  "use strict";

  // ── Constants ─────────────────────────────────────────────
  // The server (Checker) owns the full 24h timeline; the client renders it
  // as-is. No per-device state is kept: localStorage copies diverged across
  // devices (each browser saw a different slice of history), so they were
  // removed — every device now renders the exact same server snapshot.
  var H24 = 24 * 60 * 60 * 1000;

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

  // ── Uptime bar ────────────────────────────────────────────
  // Render the retention window (server-reported, default 24h) as 48
  // segments. Anchored to the server window so every device draws the same
  // bar from the same timeline.
  function uptimeBar(model, timeline, nowMsVal, spanMs) {
    var segs = 48;
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
      // State before any event in the window is unknown; walk events up to
      // this segment.
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
  function render(snap) {
    // Render strictly from the server snapshot: identical on every device.
    var timeline = (snap && snap.timeline) || [];
    var spanMs = (snap && snap.window_ms) > 0 ? snap.window_ms : H24;

    var overall = STATES[snap.overall] ? snap.overall : "unknown";
    var ov = OVERALL[overall] || OVERALL.unknown;
    var stClass = "status-" + (STATES[overall].cls || "unknown");

    // Banner
    var banner = el("statusBanner");
    banner.className = "status-banner " + stClass;
    el("bannerTitle").textContent = ov.title;
    el("bannerSub").textContent = ov.sub;

    // Meta
    el("lastSync").textContent = "Last sync: " + (snap.last_reconcile ? new Date(snap.last_reconcile).toLocaleString() : "—") + " · Interval " + snap.interval + "s";

    // Components
    var models = (snap && snap.models) || [];
    var grid = el("models");
    if (!models.length) {
      grid.innerHTML = '<div class="component-row component-empty"><span class="component-name muted">No model data yet — waiting for proxy report or /debug/modes</span></div>';
    } else {
      grid.innerHTML = models.map(function (m) {
        var st = STATES[m.state] || STATES.unknown;
        var bar = uptimeBar(m.model, timeline, nowMs(), spanMs);
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
      timeline.slice(-200).reverse().forEach(function (ev) { // DOM cap on very long timelines
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

  function poll() {
    fetch("/api/status", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
      .then(render)
      .catch(function (err) {
        el("bannerTitle").textContent = "Connection Error";
        el("bannerSub").textContent = err.message;
        el("statusBanner").className = "status-banner status-red";
      });
  }

  poll();
  setInterval(poll, 5000);
})();
