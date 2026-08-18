(function () {
  "use strict";

  /* ── State mapping ── */
  var STATES = {
    anonymous:    { label: "Operational",      cls: "green",  statusCls: "status-green",  pill: "pill-green",  faIcon: "✓" },
    keyed:        { label: "Keyed",             cls: "blue",   statusCls: "status-blue",   pill: "pill-blue",   faIcon: "●" },
    keyed_failed: { label: "Major Outage",      cls: "red",    statusCls: "status-red",    pill: "pill-red",    faIcon: "✕" },
    unknown:      { label: "Unknown",           cls: "gray",   statusCls: "status-gray",   pill: "pill-gray",   faIcon: "○" }
  };

  var OVERALL = {
    anonymous:    { cssClass: "status-none",     title: "All Systems Operational",       sub: "All models are running in anonymous mode." },
    keyed:        { cssClass: "status-minor",     title: "Degraded Performance",          sub: "Some models have switched to API key mode." },
    keyed_failed: { cssClass: "status-critical",  title: "Major System Outage",           sub: "Some models have lost all connectivity." },
    unknown:      { cssClass: "status-unknown",   title: "Awaiting Data…",               sub: "Waiting for the proxy to report model statuses." }
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

  var SVG_DAYS = 90;
  var RECT_W = 3;
  var RECT_PAD = 2;

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function ago(ms) {
    if (!ms) return "—";
    var d = Math.max(0, Date.now() - ms);
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
    return hh + ":" + mm;
  }

  function dateKey(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return months[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
  }

  function reasonText(ev) {
    if (!ev || !ev.reason) return "";
    var r = REASONS[ev.reason] || ev.reason;
    return ev.detail ? r + " · " + ev.detail : r;
  }

  /* ── SVG Uptime Bar (Statuspage.io style) ── */
  function uptimeBarSvg(model, timeline, nowMs) {
    var evs = (timeline || []).filter(function (e) {
      return e.model === model && STATES[e.to];
    }).sort(function (a, b) { return a.at - b.at; });

    var bars = [];
    if (!evs.length) {
      for (var i = 0; i < SVG_DAYS; i++) {
        bars.push('<rect height="34" width="' + RECT_W + '" x="' + (i * (RECT_W + RECT_PAD)) + '" y="0" fill="#e0e0e0" opacity="0.5"/>');
      }
    } else {
      var start = evs[0].at;
      var total = Math.max(1, nowMs - start);
      var segDur = total / SVG_DAYS;

      for (var s = 0; s < SVG_DAYS; s++) {
        var t0 = start + s * segDur;
        var state = "unknown";
        for (var j = 0; j < evs.length; j++) {
          if (evs[j].at <= t0) state = evs[j].to;
        }
        var fill;
        switch (state) {
          case "anonymous":    fill = "#10a37f"; break;
          case "keyed":        fill = "#207ab6"; break;
          case "keyed_failed": fill = "#de2f1b"; break;
          default:             fill = "#e0e0e0"; break;
        }
        var op = fill === "#e0e0e0" ? ' opacity="0.5"' : "";
        bars.push('<rect height="34" width="' + RECT_W + '" x="' + (s * (RECT_W + RECT_PAD)) + '" y="0" fill="' + fill + '"' + op + '/>');
      }
    }

    var svgW = SVG_DAYS * (RECT_W + RECT_PAD) - RECT_PAD;
    return '<svg class="uptime-svg" viewBox="0 0 ' + svgW + ' 34" preserveAspectRatio="none" height="34">' +
      bars.join("") + '</svg>';
  }

  function calcUptimePercent(model, timeline, nowMs) {
    var evs = (timeline || []).filter(function (e) {
      return e.model === model && STATES[e.to];
    }).sort(function (a, b) { return a.at - b.at; });
    if (!evs.length) return "—";

    var start = evs[0].at;
    var total = Math.max(1, nowMs - start);
    var greenMs = 0;
    for (var i = 0; i < evs.length; i++) {
      var evStart = evs[i].at;
      var evEnd = (i + 1 < evs.length) ? evs[i + 1].at : nowMs;
      if (evs[i].to === "anonymous") {
        greenMs += Math.max(0, evEnd - evStart);
      }
    }
    return (greenMs / total * 100).toFixed(2);
  }

  /* ── Render ── */
  function render(snap) {
    var overall = STATES[snap.overall] ? snap.overall : "unknown";
    var ov = OVERALL[overall] || OVERALL.unknown;

    /* Banner */
    var banner = el("statusBanner");
    banner.className = "page-status " + ov.cssClass;
    el("bannerTitle").textContent = ov.title;
    el("lastSync").textContent = snap.last_reconcile
      ? "Last sync: " + new Date(snap.last_reconcile).toLocaleString()
      : "—";

    /* Components */
    var models = snap.models || [];
    var grid = el("models");
    if (!models.length) {
      grid.innerHTML = '<div class="component-container border-color">' +
        '<div class="component-inner-container status-gray showcased">' +
        '<span class="name muted">No model data yet</span>' +
        '<span class="component-status muted">Waiting for proxy report…</span>' +
        '</div></div>';
    } else {
      var html = "";
      for (var i = 0; i < models.length; i++) {
        var m = models[i];
        var st = STATES[m.state] || STATES.unknown;
        var bar = uptimeBarSvg(m.model, snap.timeline, Date.now());
        var pct = calcUptimePercent(m.model, snap.timeline, Date.now());
        var detail = "Duration " + ago(m.since) + " · Switches " + m.switches;
        var reason = reasonText(m.last_event);
        if (reason) detail += " · " + reason;

        html += '<div class="component-container border-color">' +
          '<div class="component-inner-container ' + st.statusCls + ' showcased">' +
          '<span class="name">' + esc(m.model) + '</span>' +
          '<span class="component-status"><span class="icon-indicator">' + st.faIcon + '</span>' + st.label + '</span>' +
          '<div class="uptime-row">' +
          bar +
          '<span class="uptime-percent">' + (pct === "—" ? "—" : pct + "%") + '</span>' +
          '</div>' +
          '<div class="detail-row"><span>' + esc(detail) + '</span></div>' +
          '</div></div>';
      }
      grid.innerHTML = html;
    }

    /* Incidents / Timeline */
    var timeline = snap.timeline || [];
    var section = el("incidentsSection");
    var content = el("incidentsContent");

    if (!timeline.length) {
      section.classList.remove("hidden");
      content.innerHTML = '<div class="status-day"><div class="date">No activity yet</div>' +
        '<div class="no-incidents"><p>No model state changes recorded.</p></div></div>';
    } else {
      section.classList.remove("hidden");
      var groups = {};
      var order = [];
      var recent = timeline.slice(-80).reverse();
      for (var j = 0; j < recent.length; j++) {
        var dk = dateKey(recent[j].at);
        if (!groups[dk]) { groups[dk] = []; order.push(dk); }
        groups[dk].push(recent[j]);
      }

      var incHtml = "";
      for (var k = 0; k < order.length; k++) {
        var date = order[k];
        incHtml += '<div class="status-day"><div class="date border-color font-large">' + esc(date) + '</div>';
        var evs = groups[date];
        for (var e = 0; e < evs.length; e++) {
          var ev = evs[e];
          var fromSt = STATES[ev.from] || null;
          var toSt = STATES[ev.to] || STATES.unknown;
          var fromLabel = fromSt ? fromSt.label : "initial";
          var impactCls = ev.to === "keyed_failed" ? "impact-critical" : ev.to === "keyed" ? "impact-minor" : "impact-maintenance";

          incHtml += '<div class="incident-container">' +
            '<div class="incident-title ' + impactCls + '">' +
            esc(ev.model) + ': ' + esc(fromLabel) + ' → ' + esc(toSt.label) +
            '</div>' +
            '<div class="update ' + (ev.reason === "probe_recovered" ? "resolved" : "investigating") + '">' +
            '<span>' + esc(reasonText(ev)) + '</span>' +
            '<small>' + timeShort(ev.at) + '</small>' +
            '</div></div>';
        }
        incHtml += '</div>';
      }
      content.innerHTML = incHtml;
    }
  }

  /* ── Poll ── */
  function poll() {
    fetch("/api/status", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
      .then(render)
      .catch(function (err) {
        el("bannerTitle").textContent = "Connection Error";
        el("lastSync").textContent = err.message;
        el("statusBanner").className = "page-status status-critical";
      });
  }

  poll();
  setInterval(poll, 5000);
})();
