(function () {
  "use strict";

  var CODE_KEY = "badminton_access_code";
  var DOW = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  // 画质档位。edge 是最长边像素（按手机看的清晰度定的），
  // vbps/abps 是目标码率 —— 决定体积的主要是它，不是分辨率
  var QUALITY = {
    low:  { edge: 854,  vbps: 800000,  abps: 64000, label: "省流 480p" },
    mid:  { edge: 960,  vbps: 1200000, abps: 64000, label: "标准 540p" },
    high: { edge: 1280, vbps: 2000000, abps: 96000, label: "清晰 720p" }
  };

  var state = {
    videos: [],
    days: [],
    stats: { count: 0, size: 0, duration: 0, saved: 0, watched: 0 },
    manage: false,
    editing: null,
    linkFor: null,
    collapsed: {},
    tlReady: false,
    maxUploadMb: 2048,
    unlockRequired: true,
    unlockHint: "",
    queue: [],
    uploading: false,
    dialog: null,
    current: null,
    progressTimer: null,
    lastSent: 0
  };

  var $ = function (id) { return document.getElementById(id); };

  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function escapeHTML(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) { return n + " B"; }
    if (n < 1024 * 1024) { return (n / 1024).toFixed(0) + " KB"; }
    if (n < 1024 * 1024 * 1024) { return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB"; }
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function fmtDur(sec) {
    var s = Math.max(0, Math.round(Number(sec) || 0));
    var m = Math.floor(s / 60);
    var h = Math.floor(m / 60);
    if (h > 0) { return h + ":" + pad(m % 60) + ":" + pad(s % 60); }
    return m + ":" + pad(s % 60);
  }

  /** 累计时长的显示。mm:ss 是「视频时长」的写法，用在合计上会像钟点，
      所以合计一律写成「34 分钟」「1 小时 12 分」。 */
  function fmtTotal(sec) {
    var s = Math.max(0, Math.round(Number(sec) || 0));
    if (s < 60) { return s + " 秒"; }
    var m = Math.round(s / 60);
    if (m < 60) { return m + " 分钟"; }
    return Math.floor(m / 60) + " 小时 " + (m % 60) + " 分";
  }

  function fmtDay(day) {
    if (!day) { return "未标注日期"; }
    var p = day.split("-");
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var label = (+p[1]) + "月" + (+p[2]) + "日 " + DOW[d.getDay()];
    var diff = Math.round((today - d) / 86400000);
    if (diff === 0) { return "今天 · " + label; }
    if (diff === 1) { return "昨天 · " + label; }
    if (d.getFullYear() !== today.getFullYear()) { return d.getFullYear() + "年" + label; }
    return label;
  }

  /** 时间线的日期行：年月日写全，避免跨年时看不出是哪一年 */
  function fmtDayFull(day) {
    if (!day) { return "未标注日期"; }
    var p = day.split("-");
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var label = (+p[0]) + "年" + (+p[1]) + "月" + (+p[2]) + "日 " + DOW[d.getDay()];
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var diff = Math.round((today - d) / 86400000);
    if (diff === 0) { return "今天 · " + label; }
    if (diff === 1) { return "昨天 · " + label; }
    return label;
  }

  function headers(json) {
    var h = {};
    if (json) { h["Content-Type"] = "application/json"; }
    var code = localStorage.getItem(CODE_KEY);
    if (code) { h["X-Access-Code"] = code; }
    return h;
  }

  function request(url, options) {
    var opts = options || {};
    opts.headers = headers(!!opts.body);
    return fetch(url, opts).then(function (res) {
      if (res.status === 401) { showGate(); throw new Error("unauthorized"); }
      return res.json().then(function (data) {
        if (res.status === 403 && data && data.error === "bad_token") { throw new Error("bad_token"); }
        if (!res.ok && data && data.error) { var e = new Error(data.error); e.detail = data.error; throw e; }
        return data;
      });
    });
  }

  var toastTimer = null;
  /** 复制文本。clipboard API 在非 HTTPS 下不可用，退回 execCommand。 */
  function copyText(text) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? "直链已复制到剪贴板" : "复制失败：" + text);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast("直链已复制到剪贴板");
      }).catch(fallback);
    } else {
      fallback();
    }
  }

  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.className = "toast show";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = "toast"; }, 2000);
  }

  function showGate() {
    $("app").style.display = "none";
    $("gate").style.display = "block";
  }

  function findVideo(id) {
    for (var i = 0; i < state.videos.length; i++) {
      if (state.videos[i].id === id) { return state.videos[i]; }
    }
    return null;
  }

  // ---------- 数据 ----------

  function load() {
    return request("api/videos").then(function (d) {
      state.videos = d.videos || [];
      state.days = d.days || [];
      state.stats = d.stats || state.stats;
      state.maxUploadMb = d.max_upload_mb || 2048;
      state.unlockRequired = d.unlock_required !== false;
      state.unlockHint = d.unlock_hint || "";
      render();
    });
  }

  // ---------- 渲染 ----------

  function render() {
    renderStats();
    renderTimeline();
  }

  function renderStats() {
    var s = state.stats;
    if (state.manage) {
      $("vstats").textContent = "管理中 · 共 " + s.count + " 个";
    } else {
      var txt = s.count + " 个视频 · 累计 " + fmtTotal(s.duration) + " · " + fmtSize(s.size);
      if (s.saved > 1024 * 1024) { txt += " · 压缩省下 " + fmtSize(s.saved); }
      $("vstats").textContent = txt;
    }
    $("btn-manage").textContent = state.manage ? "完成" : "管理";
    $("btn-resync").style.display = state.manage ? "" : "none";
  }

  /** 按 年 → 月 → 日 三层分组。服务端已按 shot_at 倒序返回，顺着切即可，不用再排一遍。 */
  function groupVideos() {
    var years = [], ymap = {};
    state.videos.forEach(function (v) {
      var day = v.day || "";
      var y = day.slice(0, 4) || "0000";
      var m = day.slice(0, 7) || "0000-00";
      var Y = ymap[y];
      if (!Y) {
        Y = ymap[y] = { key: y, list: [], months: [], mmap: {} };
        years.push(Y);
      }
      var M = Y.mmap[m];
      if (!M) {
        M = Y.mmap[m] = { key: m, month: m.slice(5, 7), list: [], days: [], dmap: {} };
        Y.months.push(M);
      }
      var D = M.dmap[day];
      if (!D) { D = M.dmap[day] = { day: day, items: [] }; M.days.push(D); }
      D.items.push(v);
      M.list.push(v);
      Y.list.push(v);
    });
    return years;
  }

  function sumOf(list) {
    var dur = 0, size = 0;
    list.forEach(function (v) { dur += v.duration || 0; size += v.size || 0; });
    return list.length + " 个 · " + fmtTotal(dur) + " · " + fmtSize(size);
  }

  function renderTimeline() {
    var el = $("timeline");
    var empty = $("vempty");

    if (!state.videos.length) {
      el.innerHTML = "";
      empty.textContent = "还没有视频。点上方「上传」，把贵大王的训练视频传上来。";
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";

    var years = groupVideos();

    // 头一次渲染只摊开最新数据所在的年和月，其余一律收起。
    // 按天平铺的话，练上一年就是上百个分组，滚动条能拖到手酸。
    if (!state.tlReady) {
      years.forEach(function (Y, yi) {
        if (yi > 0) { state.collapsed[Y.key] = true; }
        Y.months.forEach(function (M, mi) {
          if (yi > 0 || mi > 0) { state.collapsed[M.key] = true; }
        });
      });
      state.tlReady = true;
    }

    el.innerHTML = years.map(function (Y) {
      var yOpen = !state.collapsed[Y.key];
      var html = '<section class="tl-year">' +
        '<button type="button" class="tl-row tl-yrow" data-tly="' + Y.key + '">' +
          '<span class="tl-caret">' + (yOpen ? "▾" : "▸") + "</span>" +
          '<span class="tl-name">' + escapeHTML(Y.key) + " 年</span>" +
          '<span class="tl-sum">' + sumOf(Y.list) + "</span>" +
        "</button>";
      if (!yOpen) { return html + "</section>"; }

      html += Y.months.map(function (M) {
        var mOpen = !state.collapsed[M.key];
        var h = '<section class="tl-month">' +
          '<button type="button" class="tl-row tl-mrow" data-tlm="' + M.key + '">' +
            '<span class="tl-caret">' + (mOpen ? "▾" : "▸") + "</span>" +
            '<span class="tl-name">' + (+M.month) + " 月</span>" +
            '<span class="tl-sum">' + sumOf(M.list) + "</span>" +
          "</button>";
        if (!mOpen) { return h + "</section>"; }
        h += '<div class="tl-mbody">' + M.days.map(function (D) {
          return '<div class="tl-day">' +
            '<div class="tl-head">' +
              '<span class="tl-date">' + escapeHTML(fmtDayFull(D.day)) + "</span>" +
              '<span class="tl-sum">' + sumOf(D.items) + "</span>" +
            "</div>" +
            '<div class="vgrid">' + D.items.map(cardHTML).join("") + "</div>" +
          "</div>";
        }).join("") + "</div>";
        return h + "</section>";
      }).join("");

      return html + "</section>";
    }).join("");
  }

  /** 某个年份下有数据的所有月份键 —— 折叠整年时要把它们一并标上 */
  function monthsOfYear(year) {
    var set = {};
    state.videos.forEach(function (v) {
      var day = v.day || "";
      if (day.slice(0, 4) === year) { set[day.slice(0, 7)] = true; }
    });
    return Object.keys(set);
  }

  function toggleYear(year) {
    // 折起整年时把名下的月一并折起，省得展开一年还要挨个月点一遍
    var fold = !state.collapsed[year];
    state.collapsed[year] = fold;
    monthsOfYear(year).forEach(function (mk) { state.collapsed[mk] = fold; });
    render();
  }

  function toggleMonth(key) {
    state.collapsed[key] = !state.collapsed[key];
    render();
  }

  function cardLabel(v) {
    return (v.note || "").trim() || (v.title || "").trim() || "训练视频";
  }

  function cardHTML(v) {
    if (state.editing === v.id) { return editHTML(v); }

    var cover = v.cover_url
      ? '<img src="' + escapeHTML(v.cover_url) + '" alt="" loading="lazy">'
      : '<span class="ph"></span>';
    var pct = v.duration > 0 ? Math.min(100, Math.round(v.progress / v.duration * 100)) : 0;
    var prog = (pct > 0 && pct < 100) ? '<div class="vprog"><i style="width:' + pct + '%"></i></div>' : "";

    var sub = fmtSize(v.size);
    if (v.saved > 0 && v.raw_size > 0) {
      sub += ' · <span class="cut">↓' + Math.round(v.saved / v.raw_size * 100) + "%</span>";
    }
    var adm = state.manage
      ? '<div class="vadm"><button class="btn-mini" data-edit="' + v.id + '">编辑</button>' +
        '<button class="btn-mini" data-link="' + v.id + '">直链</button>' +
        '<button class="btn-mini danger" data-del="' + v.id + '">删除</button></div>'
      : "";
    // 点「直链」就在卡片里摊开地址：只塞进剪贴板的话，手机上根本看不见拿到了什么
    var linkRow = (state.manage && state.linkFor === v.id)
      ? '<div class="vlink"><input type="text" readonly value="' + escapeHTML(absUrl(v)) + '">' +
        '<button class="btn-mini" data-copy="' + v.id + '">复制</button></div>'
      : "";

    return '<div class="vcard" data-play="' + v.id + '">' +
      '<div class="vcover">' + cover +
        (v.time ? '<span class="vtime">' + escapeHTML(v.time) + "</span>" : "") +
        (v.watched ? '<span class="vdone">已看</span>' : "") +
        (v.duration > 0 ? '<span class="vdur">' + fmtDur(v.duration) + "</span>" : "") +
      "</div>" + prog +
      '<div class="vbody"><div class="vtitle">' + escapeHTML(cardLabel(v)) + "</div>" +
        '<div class="vsub">' + sub + "</div>" +
      "</div>" + adm + linkRow + "</div>";
  }

  /** 视频地址是相对路径，拼成完整地址才好在别处直接用 */
  function absUrl(v) {
    try { return new URL(v.url, location.href).href; } catch (e) { return v.url; }
  }

  function editHTML(v) {
    return '<div class="vcard editing" data-edit-card="' + v.id + '">' +
      '<div class="vedit">' +
        '<div class="vfull"><label class="field">备注</label><input type="text" data-f="note" value="' +
          escapeHTML(v.note || "") + '" placeholder="如 反手发球练习"></div>' +
        '<div><label class="field">拍摄日期</label><input type="date" data-f="day" value="' +
          escapeHTML((v.shot_at || "").slice(0, 10)) + '"></div>' +
        '<div><label class="field">时间</label><input type="time" data-f="time" value="' +
          escapeHTML((v.shot_at || "").slice(11, 16)) + '"></div>' +
        '<div class="vfull row" style="margin-top:2px">' +
          '<button class="btn-mini" data-save="' + v.id + '">保存</button>' +
          '<button class="btn-mini" data-cover="' + v.id + '">换封面</button>' +
          '<button class="btn-mini" data-cancel-edit>取消</button>' +
          '<input type="file" accept="image/*" hidden data-cover-file="' + v.id + '">' +
        "</div>" +
      "</div></div>";
  }

  // ---------- 播放 ----------

  function play(id) {
    var v = findVideo(id);
    if (!v) { return; }
    state.current = v;
    state.lastSent = 0;
    $("player-title").textContent = cardLabel(v) + " · " + (v.shot_at || "").slice(0, 16);
    var bits = [fmtSize(v.size)];
    if (v.saved > 0 && v.raw_size > 0) {
      bits.push("原片 " + fmtSize(v.raw_size) + "，压掉 " + Math.round(v.saved / v.raw_size * 100) + "%");
    }
    $("player-foot").textContent = bits.join(" · ");

    var el = $("player");
    el.src = v.url;
    // 断点续播：有进度且没看完就从上次位置接着放
    if (v.progress > 3 && (!v.duration || v.progress < v.duration - 10)) {
      el.addEventListener("loadedmetadata", function resume() {
        el.removeEventListener("loadedmetadata", resume);
        try { el.currentTime = v.progress; } catch (e) { /* 有的格式不支持 seek */ }
      });
    }
    $("player-mask").style.display = "flex";
    var p = el.play();
    if (p && p.catch) { p.catch(function () { /* 自动播放被拦不影响，用户点播放键即可 */ }); }
    startProgressTimer();
  }

  function closePlayer() {
    pushProgress(true);
    stopProgressTimer();
    var el = $("player");
    try { el.pause(); } catch (e) { /* ignore */ }
    el.removeAttribute("src");
    el.load();
    $("player-mask").style.display = "none";
    state.current = null;
    load();
  }

  function startProgressTimer() {
    stopProgressTimer();
    state.progressTimer = setInterval(function () { pushProgress(false); }, 5000);
  }

  function stopProgressTimer() {
    if (state.progressTimer) { clearInterval(state.progressTimer); state.progressTimer = null; }
  }

  function pushProgress(force) {
    var v = state.current;
    var el = $("player");
    if (!v || !el) { return; }
    if (!force && el.paused) { return; }
    var pos = Math.floor(el.currentTime || 0);
    var dur = Math.floor(el.duration || v.duration || 0);
    if (!pos) { return; }
    if (!force && Math.abs(pos - state.lastSent) < 3) { return; }
    state.lastSent = pos;
    v.progress = pos;
    if (dur) { v.duration = dur; }
    request("api/videos/progress", {
      method: "POST",
      body: JSON.stringify({ id: v.id, pos: pos, duration: dur })
    }).catch(function () { /* 进度丢了不打扰用户，下次还在 */ });
  }

  // ---------- 压缩 ----------

  var MIME = null;

  function pickMime() {
    if (MIME !== null) { return MIME; }
    MIME = "";
    if (!window.MediaRecorder) { return MIME; }
    // 优先 MP4/H.264 —— iPhone、安卓、桌面通吃。
    // WebM 只有安卓和桌面能播，iPhone 上大概率打不开，所以放在后面当退路。
    var cands = [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4;codecs=avc1.4D401F,mp4a.40.2",
      "video/mp4;codecs=avc1",
      "video/mp4",
      "video/webm;codecs=vp8,opus",
      "video/webm"
    ];
    for (var i = 0; i < cands.length; i++) {
      try { if (MediaRecorder.isTypeSupported(cands[i])) { MIME = cands[i]; break; } } catch (e) { /* next */ }
    }
    return MIME;
  }

  function extForMime(mime) {
    return mime.indexOf("video/mp4") === 0 ? ".mp4" : ".webm";
  }

  /**
   * 取视频时长。正常文件 loadedmetadata 时就有；
   * 但 MediaRecorder 录出来的 WebM（以及部分碎片化文件）没写时长元数据，
   * duration 会是 Infinity —— 这时 seek 到一个极大值能逼浏览器把真实时长算出来。
   */
  function resolveDuration(video, cb) {
    var d = video.duration;
    if (isFinite(d) && d > 0) { cb(d); return; }
    var done = false;
    var timer = setTimeout(function () {
      if (done) { return; }
      done = true;
      video.ontimeupdate = null;
      cb(0);
    }, 5000);
    video.ontimeupdate = function () {
      if (done) { return; }
      done = true;
      clearTimeout(timer);
      video.ontimeupdate = null;
      var real = video.duration;
      cb(isFinite(real) && real > 0 ? real : 0);
    };
    try { video.currentTime = 1e7; }
    catch (e) { clearTimeout(timer); done = true; video.ontimeupdate = null; cb(0); }
  }

  /** 只读元数据 + 抓一帧当封面。不整段解码，很快。 */
  function probeVideo(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var video = document.createElement("video");
      var settled = false;
      var timer = setTimeout(function () { finish(reject, new Error("读取视频超时")); }, 30000);

      function finish(fn, arg) {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        video.removeAttribute("src");
        fn(arg);
      }

      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.onerror = function () { finish(reject, new Error("浏览器解不了这个视频格式")); };
      video.onloadedmetadata = function () {
        var w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) { return finish(reject, new Error("读不到画面尺寸")); }

        resolveDuration(video, function (dur) {
          video.onseeked = function () {
            var shot = null;
            try {
              var tw = Math.min(640, w);
              var c = document.createElement("canvas");
              c.width = tw;
              c.height = Math.round(h * tw / w);
              c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
              shot = c;
            } catch (e) { shot = null; }
            if (!shot) { return finish(resolve, { duration: dur, width: w, height: h, cover: null }); }
            shot.toBlob(function (b) {
              finish(resolve, { duration: dur, width: w, height: h, cover: b || null });
            }, "image/jpeg", 0.82);
          };
          // 取第 2 秒（或时长的 10%）那一帧，避开片头黑场
          var at = dur > 0 ? Math.min(2, Math.max(0.1, dur * 0.1)) : 0.1;
          try { video.currentTime = at; }
          catch (e) { finish(resolve, { duration: dur, width: w, height: h, cover: null }); }
        });
      };
      video.src = url;
    });
  }

  /**
   * 用 MediaRecorder 把视频重编码成小尺寸。
   *
   * 做法是「边播边录」：把 video 的画面逐帧画到缩小后的 canvas，
   * canvas.captureStream() 出画面轨，再从 video 接一条音轨，一起喂给 MediaRecorder。
   *
   * ⚠️ 所以它是**实时**的 —— 5 分钟的视频就要压 5 分钟，这是 MediaRecorder 的
   *    固有特性（按墙上时间打时间戳），换不出更快的办法。
   *    真要快就得用 WebCodecs + 自己写 MP4 封装，那是另一个量级的工作量，不值当。
   */
  function compressVideo(file, quality, onProgress) {
    var mime = pickMime();
    return new Promise(function (resolve, reject) {
      if (!mime) { return reject(new Error("这台浏览器不支持在本地压缩视频")); }

      var url = URL.createObjectURL(file);
      var video = document.createElement("video");
      var chunks = [];
      var rec = null, audioCtx = null, stopDraw = null, guard = null;
      var settled = false;

      function cleanup() {
        if (guard) { clearTimeout(guard); guard = null; }
        if (stopDraw) { try { stopDraw(); } catch (e) { /* ignore */ } stopDraw = null; }
        try { if (rec && rec.state !== "inactive") { rec.stop(); } } catch (e) { /* ignore */ }
        try { if (audioCtx && audioCtx.state !== "closed") { audioCtx.close(); } } catch (e) { /* ignore */ }
        try { video.pause(); } catch (e) { /* ignore */ }
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        video.removeAttribute("src");
      }
      function fail(msg) { if (settled) { return; } settled = true; cleanup(); reject(new Error(msg)); }
      function ok(val) { if (settled) { return; } settled = true; cleanup(); resolve(val); }

      video.onerror = function () { fail("这台设备的浏览器解不了这个视频"); };
      video.playsInline = true;
      video.preload = "auto";

      video.onloadedmetadata = function () {
        var vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) { return fail("读不到画面尺寸"); }

        resolveDuration(video, function (dur) {
          if (!(dur > 0)) { return fail("读不到视频时长"); }
          // duration 是 Infinity 的文件会走 seek 探测那一支，探完播放头已经跑到末尾了，
          // 必须先退回开头再录，否则一按播放就立刻结束
          if (video.currentTime > 0.05) {
            video.onseeked = function () { video.onseeked = null; begin(dur); };
            try { video.currentTime = 0; } catch (e) { begin(dur); }
          } else {
            begin(dur);
          }
        });
      };

      function begin(dur) {
        var vw = video.videoWidth, vh = video.videoHeight;
        var scale = Math.min(1, quality.edge / Math.max(vw, vh));
        // H.264 要求宽高是偶数，否则部分播放器会花屏
        var w = Math.max(2, Math.round(vw * scale / 2) * 2);
        var h = Math.max(2, Math.round(vh * scale / 2) * 2);

        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d", { alpha: false });

        var stream = canvas.captureStream(30);
        var hasAudio = false;
        try {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (AC) {
            audioCtx = new AC();
            if (audioCtx.state === "suspended") { audioCtx.resume(); }
            var src = audioCtx.createMediaElementSource(video);
            var dest = audioCtx.createMediaStreamDestination();
            // 只接到 MediaStreamDestination，不接 audioContext.destination ——
            // 否则压缩的这几分钟里手机/电脑会一直外放
            src.connect(dest);
            var at = dest.stream.getAudioTracks();
            for (var i = 0; i < at.length; i++) { stream.addTrack(at[i]); }
            hasAudio = at.length > 0;
          }
        } catch (e) { audioCtx = null; hasAudio = false; }

        var opts = { mimeType: mime, videoBitsPerSecond: quality.vbps };
        if (hasAudio) { opts.audioBitsPerSecond = quality.abps; }
        try { rec = new MediaRecorder(stream, opts); }
        catch (e) { return fail("这台设备不支持按这个参数压缩"); }

        rec.ondataavailable = function (e) { if (e.data && e.data.size) { chunks.push(e.data); } };
        rec.onerror = function () { fail("压缩过程中出错"); };

        function drawOnce() { try { ctx.drawImage(video, 0, 0, w, h); } catch (e) { /* ignore */ } }

        (function startDraw() {
          if (video.requestVideoFrameCallback) {
            // 按视频真实出帧节奏画，比 rAF 更贴
            var id = 0;
            var cb = function () { drawOnce(); id = video.requestVideoFrameCallback(cb); };
            id = video.requestVideoFrameCallback(cb);
            stopDraw = function () { if (id) { video.cancelVideoFrameCallback(id); } };
          } else {
            var rid = requestAnimationFrame(function loop() { drawOnce(); rid = requestAnimationFrame(loop); });
            stopDraw = function () { cancelAnimationFrame(rid); };
          }
        })();

        video.ontimeupdate = function () {
          if (onProgress && dur) { onProgress(Math.min(1, video.currentTime / dur), video.currentTime, dur); }
        };
        video.onended = function () {
          drawOnce();
          // 多留一点，让尾帧和音频尾巴都进到录制里
          setTimeout(function () { try { rec.stop(); } catch (e) { /* ignore */ } }, 300);
        };
        rec.onstop = function () {
          var type = mime.indexOf("video/mp4") === 0 ? "video/mp4" : "video/webm";
          var blob = new Blob(chunks, { type: type });
          if (!blob.size) { return fail("压缩结果为空"); }
          ok({ blob: blob, width: w, height: h, duration: dur, audio: hasAudio, mime: mime });
        };

        rec.start(500);
        var p = video.play();
        if (p && p.catch) {
          p.catch(function () {
            // 多半是自动播放被拦（带声音起播需要用户手势）。
            // 静音重试：画面照样能压，代价是丢掉音频 —— 总比整个失败强。
            video.muted = true;
            var p2 = video.play();
            if (p2 && p2.catch) {
              p2.catch(function () { fail("浏览器拦住了自动播放，请再点一次「开始」"); });
            }
          });
        }
        // 兜底：ended 万一没触发也不能一直挂着
        guard = setTimeout(function () {
          try { rec.stop(); } catch (e) { fail("压缩超时"); }
        }, (dur + 60) * 1000);
      };

      video.src = url;
    });
  }

  // ---------- 上传队列 ----------

  // ---------- 拍摄时间的识别 ----------

  // 1904-01-01 → 1970-01-01 的毫秒数。MP4 的时间戳以 1904 为基准
  var MP4_EPOCH_MS = 2082844800000;

  function readSlice(file, start, end) {
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = function () { resolve(new Uint8Array(fr.result)); };
      fr.onerror = function () { resolve(null); };
      fr.readAsArrayBuffer(file.slice(start, end));
    });
  }

  /** 在 buf 里找 mvhd box，取出 1904 基准的秒数；找不到返回 0 */
  function scanMvhd(buf) {
    if (!buf || buf.length < 16) { return 0; }
    var view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (var i = 0; i + 16 <= buf.length; i++) {
      // 找 "mvhd"
      if (buf[i] !== 0x6d || buf[i + 1] !== 0x76 || buf[i + 2] !== 0x68 || buf[i + 3] !== 0x64) {
        continue;
      }
      var off = i + 8;              // 跳过 "mvhd" 之后的 version(1) + flags(3)
      if (buf[i + 4] === 1) {
        if (off + 8 > buf.length) { continue; }
        var s64 = view.getUint32(off) * 4294967296 + view.getUint32(off + 4);
        if (s64 > 0) { return s64; }
      } else if (off + 4 <= buf.length) {
        var s32 = view.getUint32(off);
        if (s32 > 0) { return s32; }
      }
    }
    return 0;
  }

  /**
   * 读出视频文件里记录的拍摄时间，读不到返回 null。
   *
   * 为什么不直接用 file.lastModified：那是**文件系统**的修改时间。文件一旦被复制、
   * 下载、或经微信/网盘转存，它就变成「转存那一刻」—— 视频于是全被归到今天。
   * 拍摄时间写在容器（moov/mvhd）里，跟着文件内容走，转存不会丢。
   *
   * moov 可能在开头（faststart）也可能在末尾，所以头尾各扫一块；
   * 用 slice 只读几 MB，不会把整个视频读进内存。
   */
  function readCaptureTime(file) {
    var HEAD = Math.min(file.size, 2 * 1024 * 1024);
    return readSlice(file, 0, HEAD).then(function (head) {
      var secs = scanMvhd(head);
      if (secs || file.size <= HEAD) { return secs; }
      var TAIL = Math.min(file.size, 16 * 1024 * 1024);
      return readSlice(file, file.size - TAIL, file.size).then(scanMvhd);
    }).then(function (secs) {
      if (!secs) { return null; }
      var ms = secs * 1000 - MP4_EPOCH_MS;
      var d = new Date(ms);
      // mvhd 规范上写 UTC，但不少安卓机直接把本地时间当 UTC 写进去。
      // 按 UTC 解释出来居然在未来（录像不可能发生在未来），就改按本地墙上时间理解
      if (d.getTime() > Date.now() + 60000) {
        d = new Date(ms + new Date(ms).getTimezoneOffset() * 60000);
      }
      if (isNaN(d.getTime()) || d.getFullYear() < 1990 || d.getTime() > Date.now() + 60000) {
        return null;
      }
      return d;
    }).catch(function () { return null; });
  }

  function fileTime(file) {
    var d = new Date(file.lastModified || Date.now());
    return isNaN(d.getTime()) ? new Date() : d;
  }

  function shotString(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":00";
  }

  /** 队列行里显示的拍摄时间。直接格式化 shotAt（真正会被上传的值），
      不要用识别出来的 Date —— 手工改过之后两者就不一样了。 */
  function fmtShotAt(str) {
    if (!str || str.length < 16) { return "未设置"; }
    var p = str.slice(0, 10).split("-");
    return (+p[1]) + "月" + (+p[2]) + "日 " + str.slice(11, 16);
  }

  function parseShotAtString(str) {
    var d = String(str || "").slice(0, 10).split("-");
    var t = String(str || "").slice(11, 19).split(":");
    return new Date(+d[0], +d[1] - 1, +d[2], +t[0] || 0, +t[1] || 0, +t[2] || 0);
  }

  /**
   * 把拍摄时间写回压缩产物的 mvhd 里。
   *
   * MediaRecorder 输出的文件是从头新建的，mvhd.creation_time 写的是「编码那一刻」，
   * 跟原始拍摄时间毫无关系 —— 实测录一段 640x360 的 MP4，creation_time 就是当前时刻；
   * WebM 干脆没有 mvhd。不补这一刀，存到服务器上的文件就再也看不出是什么时候拍的了。
   *
   * 只改 creation_time / modification_time 这两组字节，不动任何跟解码、时长、采样表
   * 有关的数据，所以不影响播放。
   */
  function patchCaptureTime(blob, when) {
    if (!blob || !/mp4/i.test(blob.type) || !(when instanceof Date) || isNaN(when.getTime())) {
      return Promise.resolve(blob);
    }
    var HEAD = Math.min(blob.size, 4 * 1024 * 1024);
    return blob.slice(0, HEAD).arrayBuffer().then(function (buf) {
      var u8 = new Uint8Array(buf);
      var pos = -1;
      for (var i = 0; i + 16 <= u8.length; i++) {
        if (u8[i] === 0x6d && u8[i + 1] === 0x76 && u8[i + 2] === 0x68 && u8[i + 3] === 0x64) {
          pos = i;
          break;
        }
      }
      if (pos < 0) { return blob; }
      var ver = u8[pos + 4];
      var off = pos + 8;
      var width = ver === 1 ? 8 : 4;
      if (off + width * 2 > u8.length) { return blob; }

      var secs = Math.floor(when.getTime() / 1000) + MP4_EPOCH_MS / 1000;
      var copy = buf.slice(0);          // 复制一份再改，别动原始 buffer
      var view = new DataView(copy);
      var hi = Math.floor(secs / 4294967296);
      var lo = secs >>> 0;
      if (ver === 1) {
        view.setUint32(off, hi); view.setUint32(off + 4, lo);
        view.setUint32(off + 8, hi); view.setUint32(off + 12, lo);
      } else {
        view.setUint32(off, lo); view.setUint32(off + 4, lo);
      }
      return new Blob([copy, blob.slice(copy.byteLength)], { type: blob.type });
    }).catch(function () { return blob; });
  }

  function findQueueItem(uid) {
    for (var i = 0; i < state.queue.length; i++) {
      if (String(state.queue[i].uid) === String(uid)) { return state.queue[i]; }
    }
    return null;
  }

  var detectQueue = [];
  var detecting = false;

  /** 串行识别，避免同时读好几个大文件把手机拖死 */
  function runDetection() {
    if (detecting) { return; }
    var item = detectQueue.shift();
    if (!item) { return; }
    detecting = true;
    readCaptureTime(item.file).then(function (d) {
      if (d) { item.shot = d; item.shotFrom = "meta"; }
    }).catch(function () { /* 读不出来就用文件时间兜着 */ }).then(function () {
      item.shotBusy = false;
      detecting = false;
      if (!item.shotPinned) { applyFormToQueue(); }
      renderQueue();
      runDetection();
    });
  }

  // ---------- 拍摄：直接调摄像头录，边录边按目标画质编码 ----------

  var cam = {
    stream: null,
    rec: null,
    chunks: [],
    startedAt: 0,
    timer: null,
    facing: "environment",
    running: false,
    zoomWant: null      // 用户调过的倍数，换画质重新取流时带过去
  };

  function camSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  function camQuality() {
    return QUALITY[$("cam-quality").value] || QUALITY.mid;
  }

  function camMsg(text, bad) {
    var el = $("cam-hint");
    el.textContent = text || "";
    el.className = "cam-hint" + (bad ? " bad" : "");
    el.style.display = text ? "block" : "none";
  }

  function camFoot(text) {
    $("cam-foot").textContent = text || "";
  }

  function stopStream() {
    if (!cam.stream) { return; }
    cam.stream.getTracks().forEach(function (t) {
      try { t.stop(); } catch (e) { /* ignore */ }
    });
    cam.stream = null;
  }

  function camErrorText(err) {
    var n = (err && err.name) || "";
    if (n === "NotAllowedError" || n === "SecurityError") {
      return "摄像头／麦克风权限被拒了。到浏览器设置里允许本站使用，然后再点一次「拍摄」。";
    }
    if (n === "NotFoundError" || n === "OverconstrainedError") {
      return "没找到可用的摄像头。";
    }
    if (n === "NotReadableError" || n === "AbortError") {
      return "摄像头被别的程序占着（比如正在视频通话），关掉它再试。";
    }
    return "打不开摄像头：" + ((err && err.message) || "未知错误");
  }

  function camConstraints() {
    var q = camQuality();
    return {
      video: {
        facingMode: cam.facing,
        width: { ideal: q.edge },
        height: { ideal: Math.round(q.edge * 9 / 16) },
        frameRate: { ideal: 30 }
      },
      audio: true
    };
  }

  function camTrack() {
    if (!cam.stream) { return null; }
    var t = cam.stream.getVideoTracks();
    return t.length ? t[0] : null;
  }

  function fmtZoom(v) {
    return (Math.round(v * 10) / 10).toFixed(1) + "x";
  }

  /**
   * 变焦。能不能用完全看设备，一律运行时探测：
   *   - 安卓 Chrome、桌面接支持 PTZ 的摄像头 → getCapabilities().zoom 有值
   *   - iPhone / iPad → WebKit 根本不暴露这个能力，连键都没有
   * 没有就把整行藏起来，不摆一个点了没反应的控件。
   */
  function setupZoom(track) {
    var row = $("cam-zoom-row");
    var caps = {};
    try { caps = (track.getCapabilities && track.getCapabilities()) || {}; } catch (e) { caps = {}; }
    if (!caps.zoom || caps.zoom.max <= caps.zoom.min) {
      row.style.display = "none";
      cam.zoomWant = null;
      return;
    }
    var range = $("cam-zoom");
    range.min = caps.zoom.min;
    range.max = caps.zoom.max;
    range.step = caps.zoom.step || 0.1;
    var cur = Math.min(caps.zoom.max,
      Math.max(caps.zoom.min, cam.zoomWant === null ? caps.zoom.min : cam.zoomWant));
    range.value = cur;
    $("cam-zoom-val").textContent = fmtZoom(cur);
    row.style.display = "";
    if (cam.zoomWant !== null) { applyZoom(cur); }
  }

  function applyZoom(v) {
    var t = camTrack();
    if (!t) { return; }
    try {
      var p = t.applyConstraints({ advanced: [{ zoom: v }] });
      if (p && p.catch) { p.catch(function () { /* 个别设备会拒，忽略就好 */ }); }
    } catch (e) { /* 忽略 */ }
  }

  function camUI() {
    var btn = $("cam-shoot");
    btn.textContent = cam.running ? "停止录制" : "开始录制";
    btn.className = "cam-btn" + (cam.running ? " rec" : "");
    btn.disabled = !cam.stream && !cam.running;
    $("cam-quality").disabled = cam.running;
    $("cam-flip").disabled = cam.running;
    $("cam-timer").style.display = cam.running ? "" : "none";
    if (!cam.running) { $("cam-timer").textContent = "00:00"; }
  }

  function startPreview() {
    stopStream();
    camMsg("正在打开摄像头…");
    camFoot("");
    camUI();

    navigator.mediaDevices.getUserMedia(camConstraints()).then(function (stream) {
      cam.stream = stream;
      var v = $("cam-preview");
      v.srcObject = stream;
      var p = v.play();
      if (p && p.catch) { p.catch(function () { /* 自动播放被拦，用户点一下也能放 */ }); }
      camMsg("");
      var track = camTrack();
      if (track) { setupZoom(track); }
      camUI();
      // 只有一个摄像头就不摆「切换镜头」这个按钮
      navigator.mediaDevices.enumerateDevices().then(function (list) {
        var n = list.filter(function (d) { return d.kind === "videoinput"; }).length;
        $("cam-flip").style.display = n > 1 ? "" : "none";
      }).catch(function () { /* ignore */ });
    }).catch(function (err) {
      camMsg(camErrorText(err), true);
      camUI();
    });
  }

  function openCamera() {
    if (!camSupported()) {
      toast("这台浏览器不能直接拍摄（或者不是 HTTPS），用「上传」选已拍好的视频吧");
      return;
    }
    cam.running = false;
    cam.startedAt = 0;
    $("cam-mask").style.display = "flex";
    camUI();
    startPreview();
  }

  function closeCamera() {
    if (cam.rec && cam.rec.state !== "inactive") {
      try { cam.rec.onstop = null; cam.rec.stop(); } catch (e) { /* ignore */ }
    }
    cam.rec = null;
    cam.chunks = [];
    clearInterval(cam.timer);
    cam.timer = null;
    cam.running = false;
    stopStream();               // 必须停，否则摄像头指示灯会一直亮着
    $("cam-preview").srcObject = null;
    $("cam-mask").style.display = "none";
    camUI();
  }

  function camStart() {
    if (!cam.stream) { return; }
    var mime = pickMime();
    if (!mime) {
      camMsg("这台浏览器不支持录像，请用「上传」选已拍好的视频", true);
      return;
    }
    var q = camQuality();
    cam.chunks = [];
    try {
      cam.rec = new MediaRecorder(cam.stream, {
        mimeType: mime,
        videoBitsPerSecond: q.vbps,     // 录的时候就用目标码率，录完不必再压
        audioBitsPerSecond: q.abps
      });
    } catch (e) {
      camMsg("这套录制参数不被支持：" + e.message, true);
      return;
    }
    cam.rec.ondataavailable = function (e) {
      if (e.data && e.data.size) { cam.chunks.push(e.data); }
    };
    cam.rec.onerror = function (e) {
      camMsg("录制出错：" + ((e.error && e.error.message) || "未知"), true);
    };
    cam.rec.start(1000);        // 每秒切一片，中途出岔子也留得住前面录的
    cam.startedAt = Date.now();
    cam.running = true;
    camMsg("");
    camUI();
    camTick();
  }

  function camStop() {
    if (!cam.rec || cam.rec.state === "inactive") { return; }
    var mime = cam.rec.mimeType || pickMime();
    var started = cam.startedAt;
    cam.rec.onstop = function () {
      var blob = new Blob(cam.chunks, { type: mime });
      cam.chunks = [];
      finishRecording(blob, mime, started);
    };
    cam.running = false;
    clearInterval(cam.timer);
    camUI();
    cam.rec.stop();
  }

  /** 录制中每半秒刷一次计时和预估体积 */
  function camTick() {
    clearInterval(cam.timer);
    cam.timer = setInterval(function () {
      var s = Math.max(0, Math.round((Date.now() - cam.startedAt) / 1000));
      $("cam-timer").textContent = pad(Math.floor(s / 60)) + ":" + pad(s % 60);
      var q = camQuality();
      camFoot("已录 " + s + " 秒，约 " + fmtSize((q.vbps + q.abps) / 8 * s) +
        "。录制期间别锁屏、别切到别的 App，切走录制就断了。");
    }, 500);
  }

  function finishRecording(blob, mime, startedAt) {
    if (!blob || !blob.size) {
      camMsg("没录到内容，再试一次", true);
      camFoot("");
      return;
    }
    var d = new Date(startedAt || Date.now());
    var ext = /mp4/i.test(mime) ? ".mp4" : ".webm";
    var name = "拍摄-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + ext;
    var file;
    try {
      file = new File([blob], name, { type: mime.split(";")[0], lastModified: d.getTime() });
    } catch (e) {
      blob.name = name;         // 老浏览器没有 File 构造器，凑合
      file = blob;
    }

    closeCamera();
    enqueue([makeQueueItem(file, {
      preEncoded: true,         // 已经按目标码率编好，跳过二次压缩
      shot: d,                  // 录制这一刻就是拍摄时间
      // shotPinned 会让 applyFormToQueue 跳过它，所以 shotAt 得在这里给全，
      // 否则队列里会显示「未设置」
      shotAt: shotString(d),
      shotFrom: "camera",
      shotPinned: true,         // 别被上传面板里的批量日期改掉
      shotBusy: false,
      quality: $("cam-quality").value
    })]);

    // 顺手把上传面板摊开，用户能立刻看到刚录的那条
    var form = $("up-form");
    if (!form.style.display || form.style.display === "none") {
      form.style.display = "block";
    }
    toast("已录好，收在上传队列里了");
  }

  var uidSeq = 0;

  /** 造一个队列条目。extra 用来覆盖默认值（拍摄直录的产物会用到） */
  function makeQueueItem(f, extra) {
    var item = {
      uid: ++uidSeq,
      file: f,
      title: f.name.replace(/\.[^.]+$/, ""),
      note: "",
      quality: $("up-quality").value,
      // 先用文件修改时间垫着，识别出真实拍摄时间后覆盖
      shot: fileTime(f),
      shotFrom: "file",
      shotPinned: false,
      shotBusy: true,
      shotEdit: null,
      duration: 0,
      cover: null,
      blob: null,
      compressed: false,
      skipped: false,
      notice: "",
      fallback: "",
      // 摄像头直录的产物已经是按目标码率编好的，不用再压一遍
      preEncoded: false,
      audio: true,
      status: "wait",
      percent: 0,
      eta: 0,
      error: ""
    };
    if (extra) {
      Object.keys(extra).forEach(function (k) { item[k] = extra[k]; });
    }
    return item;
  }

  function enqueue(items) {
    if (!items || !items.length) { return; }
    items.forEach(function (item) {
      state.queue.push(item);
      // 拍摄产物的时间就是录制时刻，不用再去读文件头认
      if (!item.preEncoded) { detectQueue.push(item); }
    });
    applyFormToQueue();
    renderQueue();
    runDetection();
  }

  function pickFiles(files) {
    if (!files || !files.length) { return; }
    var items = [];
    Array.prototype.forEach.call(files, function (f) { items.push(makeQueueItem(f)); });
    enqueue(items);
  }

  /** 表单改了就同步到还没处理的条目上，这样先选文件后调参数也能生效 */
  function applyFormToQueue() {
    var dateOverride = $("up-date").value;     // "YYYY-MM-DD" 或空
    var note = $("up-note").value.trim();
    var quality = $("up-quality").value;
    state.queue.forEach(function (it) {
      if (it.status === "done") { return; }
      it.quality = quality;
      if (note) { it.note = note; }
      // 单条手动改过的不再被批量表单覆盖
      if (it.shotPinned) { return; }
      // 只替换日期、保留识别出来的时刻，跨天补传时不用挨个改
      it.shotAt = dateOverride
        ? dateOverride + " " + pad(it.shot.getHours()) + ":" + pad(it.shot.getMinutes()) + ":00"
        : shotString(it.shot);
    });
  }

  var STATUS_TEXT = {
    wait: "等待", probe: "读取中", comp: "压缩中", skip: "原片已够小",
    up: "上传中", cover: "写封面", done: "完成", err: ""
  };

  function setStatus(item, status, text) {
    item.status = status;
    if (status !== "comp") { item.eta = 0; }
    renderQueue();
  }

  function renderQueue() {
    var el = $("up-list");
    if (!state.queue.length) { el.innerHTML = ""; renderShotLine(); return; }
    el.innerHTML = state.queue.map(function (it) {
      var text;
      if (it.status === "comp") {
        text = "压缩 " + it.percent + "%" + (it.eta > 1 ? " · 约剩 " + fmtDur(it.eta) : "");
      } else if (it.status === "up") {
        text = "上传 " + it.percent + "%";
      } else if (it.status === "err") {
        text = it.error || "失败";
      } else {
        text = STATUS_TEXT[it.status] || "";
      }
      var cls = "ustate" + (it.status === "done" ? " done" : it.status === "err" ? " err" : "");
      var bar = (it.status === "comp" || it.status === "up")
        ? '<div class="ubar"><i style="width:' + it.percent + '%"></i></div>' : "";

      // 拍摄时间做成可以点的按钮 —— 识别错了要能就地改
      var shot = it.shotBusy
        ? '<span class="ushot busy">识别中…</span>'
        : '<button class="ushot" data-shot="' + it.uid + '">' +
          escapeHTML(fmtShotAt(it.shotAt)) + "</button>";
      var src = it.shotBusy ? "" : '<span class="usrc">' +
        (it.shotFrom === "camera" ? "刚刚拍的"
          : it.shotFrom === "meta" ? "取自视频文件" : "取自文件时间") + "</span>";

      var edit = "";
      if (it.shotEdit) {
        edit = '<div class="uedit">' +
          '<input type="date" class="usd" value="' + escapeHTML(it.shotEdit.day) + '">' +
          '<input type="time" class="ust" value="' + escapeHTML(it.shotEdit.time) + '">' +
          '<button class="btn-mini" data-shot-ok="' + it.uid + '">确定</button>' +
          "</div>";
      }

      return '<li><div class="urow"><span class="uname">' + escapeHTML(it.title) +
        '</span><span class="' + cls + '">' + escapeHTML(text) + "</span></div>" +
        '<div class="usub">' + shot + src + "<span>" + fmtSize(it.file.size) + "</span>" +
        (it.notice ? "<span>· " + escapeHTML(it.notice) + "</span>" : "") +
        (it.fallback ? "<span>· " + escapeHTML(it.fallback) + "，改传原片</span>" : "") +
        "</div>" + edit + bar + "</li>";
    }).join("");
    renderShotLine();
  }

  /** 队列上方那行「识别到的拍摄时间」汇总 */
  function renderShotLine() {
    var el = $("up-shot");
    var pending = state.queue.filter(function (it) { return it.status !== "done"; });
    if (!pending.length) { el.style.display = "none"; el.textContent = ""; return; }
    el.style.display = "block";
    if (pending.some(function (it) { return it.shotBusy; })) {
      el.textContent = "正在从视频文件里读拍摄时间…";
      return;
    }
    var days = {};
    var fromMeta = 0;
    pending.forEach(function (it) {
      days[it.shotAt.slice(0, 10)] = true;
      if (it.shotFrom === "meta") { fromMeta++; }
    });
    var ks = Object.keys(days).sort();
    var labels = ks.map(function (k) { return fmtDay(k).replace(/^今天 · |^昨天 · /, ""); });
    var head = fromMeta === pending.length
      ? "拍摄时间取自视频文件："
      : "拍摄时间（部分是文件时间，可能不准）：";
    el.textContent = head + labels.join("、") +
      (ks.length > 1 ? "，会分成 " + ks.length + " 天" : "") +
      "。不对就点上面对应那行的时间改。";
  }

  function startQueue() {
    if (state.uploading) { return; }
    var items = state.queue.filter(function (it) {
      return it.status === "wait" || it.status === "err";
    });
    if (!items.length) { toast("没有待处理的文件"); return; }

    applyFormToQueue();
    renderQueue();

    var limit = state.maxUploadMb * 1024 * 1024;
    var over = items.filter(function (it) { return it.file.size > limit; });
    if (over.length) {
      toast("有 " + over.length + " 个文件超过 " + state.maxUploadMb + " MB");
      return;
    }

    state.uploading = true;
    $("btn-up-start").textContent = "处理中…";
    var i = 0;
    (function next() {
      if (i >= items.length) {
        state.uploading = false;
        $("btn-up-start").textContent = "开始";
        var failed = state.queue.filter(function (it) { return it.status === "err"; }).length;
        state.queue = state.queue.filter(function (it) { return it.status !== "done"; });
        renderQueue();
        toast(failed ? "完成，有 " + failed + " 个失败" : "全部完成");
        return load();
      }
      processOne(items[i++]).then(next);
    })();
  }

  function processOne(item) {
    item.percent = 0;
    item.error = "";
    item.notice = "";
    item.fallback = "";
    setStatus(item, "probe", "");

    var q = QUALITY[item.quality] || QUALITY.mid;

    return probeVideo(item.file).then(function (meta) {
      item.duration = meta.duration;
      item.cover = meta.cover;

      // 摄像头直录的产物：录的时候就是按目标码率编的，再压一遍纯属白等
      // —— 而压缩是 1:1 实时的，一秒都省不掉。
      if (item.preEncoded) {
        item.skipped = true;
        item.notice = "直接录的，不用再压";
        return;
      }

      if (!pickMime()) {
        item.skipped = true;
        item.notice = "这台浏览器不支持本地压缩";
        return;
      }
      if (!(meta.duration > 0)) {
        // 读不到时长就没法估算目标体积，也没法给进度和超时兜底 —— 直接传原片最稳
        item.skipped = true;
        item.notice = "读不到时长";
        return;
      }
      // 预估压完的体积：原片本来就比目标小的话，压完反而更差，直接传原片
      var est = meta.duration * (q.vbps + q.abps) / 8;
      if (item.file.size <= est * 1.15) {
        item.skipped = true;
        item.notice = "原片已够小";
        return;
      }
      setStatus(item, "comp", "");
      return compressVideo(item.file, q, function (p, cur, dur) {
        item.percent = Math.round(p * 100);
        item.eta = Math.max(0, dur - cur);
        renderQueue();
      }).then(function (res) {
        // 把拍摄时间写回压缩产物，否则存到服务器上的文件里，拍摄时间就变成「压缩那一刻」了
        return patchCaptureTime(res.blob, parseShotAtString(item.shotAt)).then(function (blob) {
          item.compressed = true;
          item.blob = blob;
          item.mime = res.mime;
          item.audio = res.audio;
          if (!item.duration && res.duration) { item.duration = res.duration; }
          if (blob.size >= item.file.size) {
            // 压完比原片还大（原片本来就很省），那就别用压缩结果
            item.compressed = false;
            item.blob = null;
            item.skipped = true;
            item.notice = "压缩后反而更大，用原片";
          }
        });
      });
    }).catch(function (err) {
      // 读不出来 / 压不动都退回原片：后端只负责存字节，不挑内容
      item.skipped = true;
      item.fallback = err.message || "压缩失败";
    }).then(function () {
      return uploadItem(item);
    }).then(function () {
      setStatus(item, "done", "");
    }).catch(function (err) {
      item.status = "err";
      item.error = err.message || "上传失败";
      renderQueue();
    });
  }

  function uploadItem(item) {
    return new Promise(function (resolve, reject) {
      var payload = item.blob || item.file;
      // 压过的要按实际容器改后缀：mov 进来是 mp4 出去，叫 .mov 会误导人
      var name = item.blob
        ? item.file.name.replace(/\.[^.]+$/, "") + extForMime(item.mime || pickMime())
        : item.file.name;

      var qs = "?filename=" + encodeURIComponent(name) +
        "&title=" + encodeURIComponent(item.title) +
        "&note=" + encodeURIComponent(item.note || "") +
        "&shot_at=" + encodeURIComponent(item.shotAt) +
        "&duration=" + encodeURIComponent(Math.round(item.duration || 0)) +
        "&raw_size=" + encodeURIComponent(item.file.size);

      setStatus(item, "up", "");
      var xhr = new XMLHttpRequest();
      xhr.open("POST", "api/videos/upload" + qs, true);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      var code = localStorage.getItem(CODE_KEY);
      if (code) { xhr.setRequestHeader("X-Access-Code", code); }

      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) {
          item.percent = Math.round(e.loaded / e.total * 100);
          renderQueue();
        }
      };
      xhr.onload = function () {
        var d = {};
        try { d = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
        if (xhr.status !== 200 || !d.ok) {
          reject(new Error(d.error || ("HTTP " + xhr.status)));
          return;
        }
        item.percent = 100;
        if (item.cover) {
          setStatus(item, "cover", "");
          uploadCover(d.id, item.cover, function () { resolve(); });
        } else {
          resolve();
        }
      };
      xhr.onerror = function () { reject(new Error("网络中断")); };
      xhr.onabort = function () { reject(new Error("已取消")); };
      xhr.send(payload);
    });
  }

  function uploadCover(id, blob, done) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", "api/videos/cover?id=" + id + "&filename=c.jpg", true);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    var code = localStorage.getItem(CODE_KEY);
    if (code) { xhr.setRequestHeader("X-Access-Code", code); }
    xhr.onload = xhr.onerror = xhr.ontimeout = function () { done(); };
    xhr.send(blob);
  }

  function renderTip() {
    var tip = $("up-tip");
    var q = QUALITY[$("up-quality").value] || QUALITY.mid;
    var mime = pickMime();
    if (!mime) {
      tip.className = "tipbox warn";
      tip.innerHTML = "<b>这台浏览器不支持在本地压缩视频</b>，会直接上传原片。" +
        "想压小一点，用 Chrome 打开这个页面再传。";
      return;
    }
    if (mime.indexOf("video/mp4") !== 0) {
      tip.className = "tipbox warn";
      tip.innerHTML = "这台浏览器只能压成 <b>WebM</b>，iPhone 上多半打不开。" +
        "要压成各平台通吃的 MP4，用 Chrome 或 Safari 再传一次。";
      return;
    }
    tip.className = "tipbox";
    tip.innerHTML = "上传前会在浏览器里压到 <b>" + q.label + "</b>，约每 1 分钟占 " +
      fmtSize(q.vbps / 8 * 60) + "。<br>压缩是实时的（1 分钟素材约需 1 分钟），" +
      "期间请让页面保持在前台，别切走。<br>原片本来就不大的会直接传。";
  }

  // ---------- 敏感操作口令弹框（删除） ----------

  function openDialog(kind, payload) {
    if (!state.unlockRequired) { return submitDialog({ kind: kind, payload: payload }, ""); }
    state.dialog = { kind: kind, payload: payload };
    $("dialog-title").textContent = "删除「" + payload.label + "」";
    $("dialog-ok").textContent = "删除";
    $("dialog-input").value = "";
    $("dialog-err").textContent = "";
    var hint = $("dialog-hint");
    if (state.unlockHint) {
      hint.innerHTML = "口令：<code>" + escapeHTML(state.unlockHint) + "</code>";
      hint.style.display = "block";
    } else {
      hint.style.display = "none";
    }
    $("dialog-mask").style.display = "flex";
    setTimeout(function () { $("dialog-input").focus(); }, 60);
  }

  function closeDialog() {
    $("dialog-mask").style.display = "none";
    state.dialog = null;
  }

  function submitDialog(dialog, code) {
    var d = dialog || state.dialog;
    if (!d) { return Promise.resolve(); }
    var token = code === undefined ? $("dialog-input").value.trim() : code;
    if (state.unlockRequired && !token) {
      $("dialog-err").textContent = "请输入口令";
      return Promise.resolve();
    }
    return request("api/videos/delete", {
      method: "POST",
      body: JSON.stringify({ id: d.payload.id, token: token })
    }).then(function () {
      closeDialog();
      toast("已删除");
      return load();
    }).catch(function (err) {
      if (err.message === "bad_token") { $("dialog-err").textContent = "口令不正确"; return; }
      if (err.message === "unauthorized") { return; }
      $("dialog-err").textContent = "删除失败，请重试";
    });
  }

  function saveEdit(id) {
    var card = document.querySelector('[data-edit-card="' + id + '"]');
    if (!card) { return; }
    var val = function (f) {
      var el = card.querySelector('[data-f="' + f + '"]');
      return el ? el.value.trim() : "";
    };
    var day = val("day");
    var time = val("time") || "00:00";
    if (!day) { toast("请选拍摄日期"); return; }
    request("api/videos/update", {
      method: "POST",
      body: JSON.stringify({
        id: id, note: val("note"), shot_at: day + " " + time
      })
    }).then(function () {
      state.editing = null;
      toast("已保存");
      return load();
    }).catch(function (err) {
      if (err.message === "unauthorized") { return; }
      toast(err.detail || "保存失败");
    });
  }

  // ---------- 事件 ----------

  function bindEvents() {
    $("btn-manage").addEventListener("click", function () {
      state.manage = !state.manage;
      state.editing = null;
      state.linkFor = null;
      render();
    });

    // 拍摄
    $("btn-shoot").addEventListener("click", openCamera);
    $("cam-close").addEventListener("click", function () {
      // 正在录的时候点关闭，先把这段收好再退，别让人白录
      if (cam.running) { camStop(); return; }
      closeCamera();
    });
    $("cam-shoot").addEventListener("click", function () {
      if (cam.running) { camStop(); } else { camStart(); }
    });
    $("cam-quality").addEventListener("change", function () {
      if (!cam.running) { startPreview(); }   // 换档就重新取流，约束才生效
    });
    $("cam-flip").addEventListener("click", function () {
      if (cam.running) { return; }
      cam.facing = cam.facing === "environment" ? "user" : "environment";
      startPreview();
    });
    // 变焦不用重新取流，所以录制中也允许调（像摄像机推拉一样）
    $("cam-zoom").addEventListener("input", function () {
      var v = parseFloat(this.value);
      if (isNaN(v)) { return; }
      cam.zoomWant = v;
      $("cam-zoom-val").textContent = fmtZoom(v);
      applyZoom(v);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && $("cam-mask").style.display === "flex") {
        if (cam.running) { camStop(); } else { closeCamera(); }
      }
    });

    $("btn-upload").addEventListener("click", function () {
      var open = $("up-form").style.display !== "none";
      $("up-form").style.display = open ? "none" : "block";
      if (!open) { renderTip(); }
    });

    $("btn-up-cancel").addEventListener("click", function () {
      $("up-form").style.display = "none";
    });
    $("up-pick").addEventListener("click", function () { $("up-files").click(); });
    $("up-files").addEventListener("change", function () {
      pickFiles(this.files);
      this.value = "";
    });
    $("btn-up-start").addEventListener("click", startQueue);

    // 点拍摄时间 → 就地展开日期/时间输入
    $("up-list").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-shot]");
      if (btn) {
        var it = findQueueItem(btn.getAttribute("data-shot"));
        if (!it) { return; }
        it.shotEdit = it.shotEdit ? null : {
          day: it.shotAt.slice(0, 10),
          time: it.shotAt.slice(11, 16)
        };
        renderQueue();
        return;
      }
      var ok = e.target.closest("[data-shot-ok]");
      if (!ok) { return; }
      var t = findQueueItem(ok.getAttribute("data-shot-ok"));
      if (!t || !t.shotEdit) { return; }
      var li = ok.closest("li");
      var day = li.querySelector(".usd").value;
      var time = li.querySelector(".ust").value || "00:00";
      if (!day) { toast("请先选日期"); return; }
      t.shotAt = day + " " + time + ":00";
      t.shotPinned = true;      // 手动改过的不再被批量日期覆盖
      t.shotEdit = null;
      renderQueue();
    });

    // 编辑框里的输入不触发重绘，否则一边打字一边被冲掉
    $("up-list").addEventListener("input", function (e) {
      var inp = e.target.closest(".usd, .ust");
      if (!inp) { return; }
      var li = inp.closest("li");
      var okBtn = li && li.querySelector("[data-shot-ok]");
      if (!okBtn) { return; }
      var t = findQueueItem(okBtn.getAttribute("data-shot-ok"));
      if (!t || !t.shotEdit) { return; }
      var d = li.querySelector(".usd").value;
      var tm = li.querySelector(".ust").value;
      if (d) { t.shotEdit.day = d; }
      if (tm) { t.shotEdit.time = tm; }
    });

    // 已经传上来但日期归错了的，按视频文件里的时间重新认一遍
    $("btn-resync").addEventListener("click", function () {
      var btn = this;
      if (btn.disabled) { return; }
      btn.disabled = true;
      btn.textContent = "识别中…";
      request("api/videos/resync_shot", { method: "POST", body: "{}" })
        .then(function (d) {
          if (d.updated) {
            toast("按视频文件里的时间调整了 " + d.updated + " 个");
          } else if (d.no_meta && !d.decided) {
            // 压缩过的文件被重新编码了，原始拍摄时间已经不在文件里
            toast("这些视频里读不到原始拍摄时间，只能手工改日期");
          } else {
            toast("没有需要调整的");
          }
          return load();
        })
        .catch(function (err) {
          if (err.message !== "unauthorized") { toast("识别失败，请重试"); }
        })
        .then(function () {
          btn.disabled = false;
          btn.textContent = "重认拍摄时间";
        });
    });

    ["up-date", "up-note", "up-quality"].forEach(function (id) {
      $(id).addEventListener("change", function () {
        applyFormToQueue();
        renderQueue();
        if (id === "up-quality") { renderTip(); }
      });
      $(id).addEventListener("input", function () {
        if (id === "up-note") { applyFormToQueue(); renderQueue(); }
      });
    });

    $("timeline").addEventListener("click", function (e) {
      // 年和月的折叠切换排在最前面：它们是整块的标题条，不参与卡片上的其它判断
      var ty = e.target.closest("[data-tly]");
      if (ty) { toggleYear(ty.getAttribute("data-tly")); return; }
      var tm = e.target.closest("[data-tlm]");
      if (tm) { toggleMonth(tm.getAttribute("data-tlm")); return; }
      var edit = e.target.closest("[data-edit]");
      if (edit) { state.editing = Number(edit.getAttribute("data-edit")); render(); return; }
      // 点「直链」把完整地址摊在卡片上。只扔进剪贴板的话，手机上根本看不见拿到了什么
      var link = e.target.closest("[data-link]");
      if (link) {
        var lid = Number(link.getAttribute("data-link"));
        state.linkFor = state.linkFor === lid ? null : lid;
        render();
        if (state.linkFor === lid) {
          var inp = document.querySelector(".vlink input");
          if (inp) { inp.focus(); inp.select(); }
        }
        return;
      }
      var cp = e.target.closest("[data-copy]");
      if (cp) {
        var cv = findVideo(Number(cp.getAttribute("data-copy")));
        if (cv) { copyText(absUrl(cv)); }
        return;
      }
      var del = e.target.closest("[data-del]");
      if (del) {
        var id = Number(del.getAttribute("data-del"));
        var v = findVideo(id);
        if (v) { openDialog("delete", { id: id, label: cardLabel(v) }); }
        return;
      }
      var save = e.target.closest("[data-save]");
      if (save) { saveEdit(Number(save.getAttribute("data-save"))); return; }
      if (e.target.closest("[data-cancel-edit]")) { state.editing = null; render(); return; }
      var cov = e.target.closest("[data-cover]");
      if (cov) {
        var input = document.querySelector('[data-cover-file="' + cov.getAttribute("data-cover") + '"]');
        if (input) { input.click(); }
        return;
      }
      // 「点卡片进播放」这一步必须放在上面所有按钮判断之后 ——
      // .vedit 里的保存/换封面/取消都在这个容器里，先判 .vedit 会把它们一并吞掉
      if (e.target.closest(".vedit") || e.target.closest(".vlink") || state.editing) { return; }
      var playable = e.target.closest("[data-play]");
      if (playable) { play(Number(playable.getAttribute("data-play"))); }
    });

    $("timeline").addEventListener("change", function (e) {
      var input = e.target.closest("[data-cover-file]");
      if (!input || !input.files || !input.files[0]) { return; }
      var id = Number(input.getAttribute("data-cover-file"));
      toast("正在上传封面…");
      uploadCover(id, input.files[0], function () {
        state.editing = null;
        toast("封面已更新");
        load();
      });
    });

    $("player-close").addEventListener("click", closePlayer);
    $("player-mask").addEventListener("click", function (e) {
      if (e.target === this) { closePlayer(); }
    });
    $("player").addEventListener("ended", function () { pushProgress(true); });

    $("dialog-ok").addEventListener("click", function () { submitDialog(); });
    $("dialog-cancel").addEventListener("click", closeDialog);
    $("dialog-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { submitDialog(); }
    });
    $("dialog-mask").addEventListener("click", function (e) {
      if (e.target === this) { closeDialog(); }
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

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") { return; }
      if ($("player-mask").style.display !== "none") { closePlayer(); }
      else if ($("dialog-mask").style.display !== "none") { closeDialog(); }
      else if (state.editing) { state.editing = null; render(); }
    });

    // 压缩期间切走标签页会拖慢甚至中断，提醒一下
    window.addEventListener("beforeunload", function (e) {
      if (!state.uploading) { return; }
      e.preventDefault();
      e.returnValue = "";
    });
  }

  function start() {
    load().then(function () {
      $("gate").style.display = "none";
      $("app").style.display = "block";
    }).catch(function () { /* unauthorized -> 已由 request() 切到口令页 */ });
  }

  bindEvents();
  start();
})();
