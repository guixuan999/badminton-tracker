(function () {
  "use strict";

  var DOW = ["一", "二", "三", "四", "五", "六", "日"];
  var CODE_KEY = "badminton_access_code";

  var state = {
    today: "",
    signed: {},
    locked: {},
    lockInfo: { locked_at: null, locked_count: 0 },
    payments: [],
    summary: { range_count: 0, total_count: 0, paid_sessions: 0, paid_amount: 0, remaining: 0 },
    preset: "thisWeek",
    start: "",
    end: "",
    attPreset: "sinceLastPay",
    attStart: "",
    attEnd: "",
    attDays: [],
    attLocked: {},
    payManage: false,
    pendingPay: null,
    pendingLock: false
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
      return res.json().then(function (data) {
        if (res.status === 409) { throw new Error("locked"); }
        return data;
      });
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
    return request("api/state?start=" + state.start + "&end=" + state.end).then(function (data) {
      state.today = data.today;
      state.signed = {};
      data.attendance.forEach(function (d) { state.signed[d] = true; });
      state.locked = {};
      (data.locked_days || []).forEach(function (d) { state.locked[d] = true; });
      state.lockInfo = data.lock_info || state.lockInfo;
      state.payments = data.payments || [];
      state.summary = data.summary || state.summary;
      render();
      if ($("att-details").open) { return loadAttendance(); }
    });
  }

  function toggleDay(dateStr) {
    if (state.locked[dateStr]) {
      toast("该记录已锁定，无法取消");
      return Promise.resolve();
    }
    return request("api/attendance/toggle", {
      method: "POST",
      body: JSON.stringify({ date: dateStr })
    }).then(function (data) {
      if (data.signed) { state.signed[dateStr] = true; toast("已报名 " + dateStr); }
      else { delete state.signed[dateStr]; toast("已取消 " + dateStr); }
      return load();
    }).catch(function (err) {
      if (err.message === "locked") { toast("该记录已锁定，无法取消"); return load(); }
      throw err;
    });
  }

  function dayCell(d, outside) {
    var s = iso(d);
    var cls = "day";
    if (state.signed[s]) { cls += " signed"; }
    if (state.locked[s]) { cls += " locked"; }
    if (s === state.today) { cls += " today"; }
    if (outside) { cls += " outside"; }
    var dot = state.signed[s] ? '<div class="dot"></div>' : "";
    var lock = state.locked[s] ? '<span class="lock-mark" title="已锁定"></span>' : "";
    return '<button class="' + cls + '" data-date="' + s + '">' + d.getDate() + lock + dot + "</button>";
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

  var ATT_PRESET_NAME = {
    sinceLastPay: "上次缴费以来",
    thisWeek: "本周",
    thisMonth: "本月",
    lastMonth: "上月",
    all: "全部",
    custom: "自定义"
  };

  function lastPayDate() {
    if (!state.payments.length) { return null; }
    return state.payments.reduce(function (acc, p) {
      return p.pay_date > acc ? p.pay_date : acc;
    }, state.payments[0].pay_date);
  }

  function computeAttRange() {
    var t = parseISO(state.today);
    var p = state.attPreset;
    var s, e;
    if (p === "all") {
      s = "1970-01-01"; e = "2999-12-31";
    } else if (p === "sinceLastPay") {
      var lp = lastPayDate();
      s = lp || iso(new Date(t.getFullYear(), t.getMonth(), 1));
      e = state.today;
    } else if (p === "thisWeek") {
      s = iso(weekStart(t)); e = iso(addDays(weekStart(t), 6));
    } else if (p === "thisMonth") {
      s = iso(new Date(t.getFullYear(), t.getMonth(), 1));
      e = iso(new Date(t.getFullYear(), t.getMonth() + 1, 0));
    } else if (p === "lastMonth") {
      s = iso(new Date(t.getFullYear(), t.getMonth() - 1, 1));
      e = iso(new Date(t.getFullYear(), t.getMonth(), 0));
    } else {
      s = $("att-start").value || state.today;
      e = $("att-end").value || state.today;
      if (s > e) { var tmp = s; s = e; e = tmp; }
    }
    state.attStart = s;
    state.attEnd = e;
  }

  function renderAttendanceList() {
    var open = $("att-details").open;
    $("att-custom").style.display = state.attPreset === "custom" && open ? "flex" : "none";
    var chips = document.querySelectorAll(".att-chip");
    for (var i = 0; i < chips.length; i++) {
      chips[i].className = "chip att-chip" +
        (chips[i].getAttribute("data-att") === state.attPreset ? " active" : "");
    }
    if (!open) { return; }

    var rangeText = state.attPreset === "sinceLastPay"
      ? "上次缴费（" + state.attStart + "）至今"
      : state.attPreset === "all" ? "全部记录" : state.attStart + " 至 " + state.attEnd;
    $("att-range-note").textContent = rangeText + " · 共 " + state.attDays.length + " 次" +
      (state.attPreset === "sinceLastPay" && !state.payments.length ? "（无缴费记录，暂按本月显示）" : "");
    $("att-hint").textContent = state.attDays.length + " 次";

    var el = $("attendance-list");
    if (!state.attDays.length) {
      el.innerHTML = '<li class="empty-tip">该时间范围内没有参训记录</li>';
    } else {
      el.innerHTML = state.attDays.map(function (d) {
        var tag = state.attLocked[d]
          ? '<span class="meta locked-tag"><span class="lock-mark"></span>已锁定</span>'
          : '<span class="meta">已参训</span>';
        return "<li><span>" + d + " " + weekdayCN(d) + "</span>" + tag + "</li>";
      }).join("");
    }
    renderLockBar();
  }

  function renderLockBar() {
    var info = state.lockInfo || { locked_at: null, locked_count: 0 };
    var st = $("lock-state");
    var actions = $("lock-actions");

    if (state.pendingLock) {
      st.textContent = "将锁定全部未锁定记录，之后界面无法取消。";
      actions.innerHTML =
        '<button class="btn-mini danger" data-lock-confirm>确认锁定</button>' +
        '<button class="btn-mini" data-lock-cancel>取消</button>';
      return;
    }
    if (info.locked_count) {
      st.textContent = "已锁定 " + info.locked_count + " 条" +
        (info.locked_at ? "（" + info.locked_at.slice(0, 10) + " 锁定）" : "");
    } else {
      st.textContent = "尚未锁定，历史记录仍可取消";
    }
    actions.innerHTML = '<button class="btn-mini" data-lock-start>锁定</button>';
  }

  function loadAttendance() {
    computeAttRange();
    return request("api/state?start=" + state.attStart + "&end=" + state.attEnd)
      .then(function (data) {
        state.attDays = (data.attendance || []).slice().sort().reverse();
        state.attLocked = {};
        (data.locked_days || []).forEach(function (d) { state.attLocked[d] = true; });
        state.lockInfo = data.lock_info || state.lockInfo;
        renderAttendanceList();
      })
      .catch(function () { /* 未授权时由 gate 处理 */ });
  }

  function renderPaymentList() {
    var pay = $("payment-list");
    if (!state.payments.length) {
      state.payManage = false;
      pay.innerHTML = '<li class="empty-tip">还没有缴费记录</li>';
      $("btn-pay-manage").style.display = "none";
      $("pay-manage-tip").style.display = "none";
      return;
    }
    pay.innerHTML = state.payments.map(function (p) {
      var action = '<button class="btn-mini danger" data-del-pay="' + p.id + '">删除</button>';
      if (state.pendingPay === p.id) {
        action = '<span class="inline-confirm">确认删除？' +
          '<button class="btn-mini danger" data-confirm-pay="' + p.id + '">删除</button>' +
          '<button class="btn-mini" data-cancel-del>取消</button></span>';
      } else if (!state.payManage) {
        action = "";
      }
      return '<li><span>' + p.pay_date + " · " + p.sessions + " 次" +
        (p.note ? ' · <span class="meta">' + escapeHTML(p.note) + "</span>" : "") +
        '</span><span><strong>' + money(p.amount) + "</strong> " + action + "</span></li>";
    }).join("");

    $("btn-pay-manage").textContent = state.payManage ? "完成" : "管理";
    $("btn-pay-manage").style.display = state.payments.length ? "" : "none";
    $("pay-manage-tip").style.display = state.payManage ? "block" : "none";
  }

  function openPayForm() {
    $("pay-form").style.display = "grid";
    $("btn-pay-toggle").textContent = "收起";
    if (!$("pay-date").value) { $("pay-date").value = state.today; }
    $("pay-amount").focus();
  }

  function closePayForm() {
    $("pay-form").style.display = "none";
    $("btn-pay-toggle").textContent = "添加";
    $("pay-amount").value = "";
    $("pay-sessions").value = "";
    $("pay-note").value = "";
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

    var chips = document.querySelectorAll(".chip:not(.att-chip)");
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

    renderPaymentList();
    renderAttendanceList();
  }

  function bindEvents() {
    var chips = document.querySelectorAll(".chip:not(.att-chip)");
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener("click", function () {
        state.preset = this.getAttribute("data-preset");
        computeRange(state.preset);
        load();
      });
    }

    var attChips = document.querySelectorAll(".att-chip");
    for (var j = 0; j < attChips.length; j++) {
      attChips[j].addEventListener("click", function () {
        state.attPreset = this.getAttribute("data-att");
        loadAttendance();
      });
    }

    $("att-details").addEventListener("toggle", function () {
      if (this.open) { loadAttendance(); }
      else { $("att-hint").textContent = "点击展开"; }
    });

    $("att-start").addEventListener("change", function () {
      if (state.attPreset === "custom") { loadAttendance(); }
    });
    $("att-end").addEventListener("change", function () {
      if (state.attPreset === "custom") { loadAttendance(); }
    });

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

    $("lock-bar").addEventListener("click", function (e) {
      if (e.target.closest("[data-lock-start]")) {
        state.pendingLock = true;
        renderLockBar();
        return;
      }
      if (e.target.closest("[data-lock-cancel]")) {
        state.pendingLock = false;
        renderLockBar();
        return;
      }
      if (e.target.closest("[data-lock-confirm]")) {
        state.pendingLock = false;
        request("api/attendance/lock", { method: "POST", body: "{}" })
          .then(function (data) {
            toast(data.locked_count
              ? "已锁定 " + data.locked_count + " 条记录"
              : "没有需要锁定的记录");
            return load();
          })
          .catch(function (err) {
            if (err.message !== "unauthorized") { toast("锁定失败"); }
          });
      }
    });

    $("btn-pay-toggle").addEventListener("click", function () {
      if ($("pay-form").style.display === "none") { openPayForm(); } else { closePayForm(); }
    });
    $("btn-pay-cancel").addEventListener("click", closePayForm);
    $("btn-pay-manage").addEventListener("click", function () {
      state.payManage = !state.payManage;
      state.pendingPay = null;
      renderPaymentList();
    });

    $("btn-pay-add").addEventListener("click", function () {
      var payload = {
        date: $("pay-date").value || state.today,
        amount: $("pay-amount").value,
        sessions: $("pay-sessions").value,
        note: $("pay-note").value
      };
      if (!payload.amount || !payload.sessions) { toast("请填写金额和次数"); return; }
      request("api/payment/add", { method: "POST", body: JSON.stringify(payload) })
        .then(function () {
          closePayForm();
          toast("已添加缴费记录");
          return load();
        })
        .catch(function (err) { if (err.message !== "unauthorized") { toast("添加失败"); } });
    });

    $("payment-list").addEventListener("click", function (e) {
      var del = e.target.closest("[data-del-pay]");
      if (del) {
        state.pendingPay = Number(del.getAttribute("data-del-pay"));
        renderPaymentList();
        return;
      }
      if (e.target.closest("[data-cancel-del]")) {
        state.pendingPay = null;
        renderPaymentList();
        return;
      }
      var ok = e.target.closest("[data-confirm-pay]");
      if (!ok) { return; }
      state.pendingPay = null;
      request("api/payment/delete", {
        method: "POST",
        body: JSON.stringify({ id: ok.getAttribute("data-confirm-pay") })
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
    request("api/state?start=" + (state.start || "1970-01-01") + "&end=" + (state.end || "2999-12-31"))
      .then(function (data) {
        $("gate").style.display = "none";
        $("app").style.display = "block";
        state.today = data.today;
        $("pay-date").value = data.today;
        $("start-date").value = state.today;
        $("end-date").value = state.today;
        $("att-start").value = state.today;
        $("att-end").value = state.today;
        computeRange(state.preset || "thisWeek");
        return load();
      })
      .catch(function () { /* unauthorized -> gate */ });
  }

  bindEvents();
  start();
})();
