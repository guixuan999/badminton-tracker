(function () {
  "use strict";

  var DOW = ["一", "二", "三", "四", "五", "六", "日"];
  var CODE_KEY = "badminton_access_code";

  var state = {
    today: "",
    signed: {},
    payments: [],
    summary: { range_count: 0, total_count: 0, paid_sessions: 0, paid_amount: 0, remaining: 0 },
    preset: "thisWeek",
    start: "",
    end: ""
  };

  var $ = function (id) { return document.getElementById(id); };

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parseISO(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function weekStart(d) { var x = new Date(d.getTime()); var w = (x.getDay() + 6) % 7; return addDays(x, -w); }
  function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }
  function weekdayCN(s) { return "周" + DOW[(parseISO(s).getDay() + 6) % 7]; }
  function money(n) { return "¥" + Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 2 }); }

  function headers(json) {
    var h = {};
    if (json) { h["Content-Type"] = "application/json"; }
    var code = localStorage.getItem(CODE_KEY);
    if (code) { h["X-Access-Code"] = code; }
    return h;
  }

  function request(url, options) {
    var opts = options || {};
    opts.headers = headers(opts.body ? true : false);
    return fetch(url, opts).then(function (res) {
      if (res.status === 401) { showGate(); throw new Error("unauthorized"); }
      return res.json();
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.className = "toast show";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = "toast"; }, 1600);
  }

  function showGate() {
    $("app").style.display = "none";
    $("gate").style.display = "block";
  }

  function computeRange(preset) {
    var t = parseISO(state.today);
    var s, e;
    if (preset === "lastWeek") {
      s = addDays(weekStart(t), -7); e = addDays(s, 6);
    } else if (preset === "thisMonth") {
      s = new Date(t.getFullYear(), t.getMonth(), 1);
      e = new Date(t.getFullYear(), t.getMonth() + 1, 0);
    } else if (preset === "lastMonth") {
      s = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      e = new Date(t.getFullYear(), t.getMonth(), 0);
    } else if (preset === "custom") {
      s = parseISO($("start-date").value || state.start);
      e = parseISO($("end-date").value || state.end);
      if (s > e) { var tmp = s; s = e; e = tmp; }
    } else {
      s = weekStart(t); e = addDays(s, 6);
    }
    state.start = iso(s);
    state.end = iso(e);
  }

  function load() {
    return request("/api/state?start=" + state.start + "&end=" + state.end).then(function (data) {
      state.today = data.today;
      state.signed = {};
      data.attendance.forEach(function (d) { state.signed[d] = true; });
      state.payments = data.payments || [];
      state.summary = data.summary || state.summary;
      render();
    });
  }

  function toggleDay(dateStr) {
    return request("/api/attendance/toggle", {
      method: "POST",
      body: JSON.stringify({ date: dateStr })
    }).then(function (data) {
      if (data.signed) { state.signed[dateStr] = true; toast("已报名 " + dateStr); }
      else { delete state.signed[dateStr]; toast("已取消 " + dateStr); }
      return load();
    });
  }

  function dayCell(d, outside) {
    var s = iso(d);
    var cls = "day";
    if (state.signed[s]) { cls += " signed"; }
    if (s === state.today) { cls += " today"; }
    if (outside) { cls += " outside"; }
    var dot = state.signed[s] ? '<div class="dot"></div>' : "";
    return '<button class="' + cls + '" data-date="' + s + '">' + d.getDate() + dot + "</button>";
  }

  function renderWeekChunks() {
    var html = "";
    var cursor = weekStart(parseISO(state.start));
    var last = parseISO(state.end);
    while (cursor <= last) {
      var cells = "";
      for (var i = 0; i < 7; i++) {
        var d = addDays(cursor, i);
        var outside = iso(d) < state.start || iso(d) > state.end;
        cells += dayCell(d, outside);
      }
      var head = '<div class="dow">' + DOW.join('</div><div class="dow">') + "</div>";
      html += '<div class="grid7">' + head + cells + "</div>";
      cursor = addDays(cursor, 7);
    }
    return html;
  }

  function renderMonthGrids() {
    var html = "";
    var cursor = parseISO(state.start);
    var endD = parseISO(state.end);
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    while (cursor <= endD) {
      var y = cursor.getFullYear(), m = cursor.getMonth();
      var first = new Date(y, m, 1);
      var offset = (first.getDay() + 6) % 7;
      var lastDay = new Date(y, m + 1, 0).getDate();
      var cells = "";
      for (var i = 0; i < offset; i++) { cells += '<div class="day empty"></div>'; }
      for (var day = 1; day <= lastDay; day++) {
        var d = new Date(y, m, day);
        cells += dayCell(d, false);
      }
      html += '<div class="month-block"><div class="month-title">' + y + "年" + (m + 1) + '月</div>' +
        '<div class="grid7"><div class="dow">' + DOW.join('</div><div class="dow">') + "</div>" + cells + "</div></div>";
      cursor = new Date(y, m + 1, 1);
    }
    return html;
  }

  function renderCalendar() {
    var span = daysBetween(state.start, state.end);
    $("calendar").innerHTML = span > 20 ? renderMonthGrids() : renderWeekChunks();
  }

  function renderLists() {
    var days = Object.keys(state.signed).filter(function (d) {
      return d >= state.start && d <= state.end;
    }).sort().reverse();

    var att = $("attendance-list");
    if (!days.length) {
      att.innerHTML = '<li class="empty-tip">该时间范围内没有参训记录</li>';
    } else {
      att.innerHTML = days.map(function (d) {
        return '<li><span>' + d + " " + weekdayCN(d) + "</span>" +
          '<button class="btn-mini danger" data-del-date="' + d + '">取消报名</button></li>';
      }).join("");
    }

    var pay = $("payment-list");
    if (!state.payments.length) {
      pay.innerHTML = '<li class="empty-tip">还没有缴费记录</li>';
    } else {
      pay.innerHTML = state.payments.map(function (p) {
        return '<li><span>' + p.pay_date + " · " + p.sessions + " 次" +
          (p.note ? ' · <span class="meta">' + escapeHTML(p.note) + "</span>" : "") +
          '</span><span><strong>' + money(p.amount) + "</strong> " +
          '<button class="btn-mini danger" data-del-pay="' + p.id + '">删除</button></span></li>';
      }).join("");
    }
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function render() {
    var label = state.start + " 至 " + state.end;
    var presetName = { thisWeek: "本周", lastWeek: "上周", thisMonth: "本月", lastMonth: "上月", custom: "自定义" };
    $("range-label").textContent = label + "（" + presetName[state.preset] + "）";
    $("today-label").textContent = state.today + " " + weekdayCN(state.today);

    var chips = document.querySelectorAll(".chip");
    for (var i = 0; i < chips.length; i++) {
      chips[i].className = "chip" + (chips[i].getAttribute("data-preset") === state.preset ? " active" : "");
    }
    $("custom-range").style.display = state.preset === "custom" ? "flex" : "none";

    renderCalendar();

    var btn = $("btn-today-sign");
    if (state.signed[state.today]) {
      btn.textContent = "取消今天的报名";
      btn.className = "btn-primary cancel";
      $("today-state").textContent = "今天已报名，实际没去的话在这里取消即可。";
    } else {
      btn.textContent = "今天报名";
      btn.className = "btn-primary";
      $("today-state").textContent = "接龙报名后点一下，未报名时按钮为绿色。";
    }

    $("stat-range").textContent = state.summary.range_count;
    $("stat-total").textContent = state.summary.total_count;
    var rem = state.summary.remaining;
    var remEl = $("stat-remain");
    remEl.textContent = rem;
    remEl.className = "v" + (rem <= 3 ? " warn" : "");

    renderLists();
  }

  function bindEvents() {
    var chips = document.querySelectorAll(".chip");
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener("click", function () {
        state.preset = this.getAttribute("data-preset");
        computeRange(state.preset);
        load();
      });
    }

    $("btn-today").addEventListener("click", function () {
      state.preset = "thisWeek";
      computeRange("thisWeek");
      load();
    });

    $("start-date").addEventListener("change", function () {
      if (state.preset === "custom") { computeRange("custom"); load(); }
    });
    $("end-date").addEventListener("change", function () {
      if (state.preset === "custom") { computeRange("custom"); load(); }
    });

    $("calendar").addEventListener("click", function (e) {
      var btn = e.target.closest(".day[data-date]");
      if (btn) { toggleDay(btn.getAttribute("data-date")); }
    });

    $("btn-today-sign").addEventListener("click", function () {
      toggleDay(state.today);
    });

    $("attendance-list").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-del-date]");
      if (btn) { toggleDay(btn.getAttribute("data-del-date")); }
    });

    $("btn-pay-add").addEventListener("click", function () {
      var payload = {
        date: $("pay-date").value || state.today,
        amount: $("pay-amount").value,
        sessions: $("pay-sessions").value,
        note: $("pay-note").value
      };
      if (!payload.amount || !payload.sessions) { toast("请填写金额和次数"); return; }
      request("/api/payment/add", { method: "POST", body: JSON.stringify(payload) })
        .then(function () {
          $("pay-amount").value = "";
          $("pay-sessions").value = "";
          $("pay-note").value = "";
          toast("已添加缴费记录");
          return load();
        })
        .catch(function (err) { if (err.message !== "unauthorized") { toast("添加失败"); } });
    });

    $("payment-list").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-del-pay]");
      if (!btn) { return; }
      if (!confirm("确定删除这条缴费记录？")) { return; }
      request("/api/payment/delete", {
        method: "POST",
        body: JSON.stringify({ id: btn.getAttribute("data-del-pay") })
      }).then(function () { toast("已删除"); return load(); });
    });

    $("gate-ok").addEventListener("click", function () {
      var code = $("gate-input").value.trim();
      if (!code) { return; }
      localStorage.setItem(CODE_KEY, code);
      start();
    });
    $("gate-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { $("gate-ok").click(); }
    });
  }

  function start() {
    request("/api/state?start=" + (state.start || "1970-01-01") + "&end=" + (state.end || "2999-12-31"))
      .then(function (data) {
        $("gate").style.display = "none";
        $("app").style.display = "block";
        state.today = data.today;
        $("pay-date").value = data.today;
        $("start-date").value = state.today;
        $("end-date").value = state.today;
        computeRange(state.preset || "thisWeek");
        return load();
      })
      .catch(function () { /* unauthorized -> gate */ });
  }

  bindEvents();
  start();
})();
