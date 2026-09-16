(function () {
  "use strict";

  var CODE_KEY = "badminton_access_code";

  var state = {
    videos: [],
    groups: [],
    stats: { count: 0, size: 0, watched: 0 },
    group: null,
    manage: false,
    editing: null,
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
    var s = Math.max(0, Math.floor(Number(sec) || 0));
    var m = Math.floor(s / 60);
    var h = Math.floor(m / 60);
    if (h > 0) { return h + ":" + String(m % 60).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }
    return m + ":" + String(s % 60).padStart(2, "0");
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
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.className = "toast show";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = "toast"; }, 1800);
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
    // 一次性取全量，分组筛选在本地做 —— 个人库就几十上百条，
    // 本地过滤点起来没有延迟，也避免了「未分组」没法用接口筛选的边角情况
    return request("api/videos").then(function (d) {
      state.videos = d.videos || [];
      state.groups = d.groups || [];
      state.stats = d.stats || state.stats;
      state.maxUploadMb = d.max_upload_mb || 2048;
      state.unlockRequired = d.unlock_required !== false;
      state.unlockHint = d.unlock_hint || "";
      render();
    });
  }

  // state.group: null = 全部；"" = 未分组；其余为分组名
  function visible() {
    if (state.group === null) { return state.videos; }
    return state.videos.filter(function (v) { return (v.grp || "") === state.group; });
  }

  // ---------- 渲染 ----------

  function render() {
    renderChips();
    renderStats();
    renderDatalist();
    renderGrid();
  }

  function renderChips() {
    var html = '<button class="chip' + (state.group === null ? " active" : "") +
      '" data-group="__all__">全部 ' + state.stats.count + "</button>";
    state.groups.forEach(function (g) {
      var name = g.name || "";
      var active = state.group !== null && state.group === name;
      html += '<button class="chip' + (active ? " active" : "") +
        '" data-group="' + (name ? escapeHTML(name) : "__none__") + '">' +
        (name ? escapeHTML(name) : "未分组") + " " + g.count + "</button>";
    });
    $("group-chips").innerHTML = html;
  }

  function renderStats() {
    var s = state.stats;
    $("vstats").textContent = state.manage
      ? "管理中 · 共 " + s.count + " 个"
      : "共 " + s.count + " 个 · 已看 " + s.watched + " · 占用 " + fmtSize(s.size);
    $("btn-manage").textContent = state.manage ? "完成" : "管理";
  }

  function renderDatalist() {
    $("up-group-list").innerHTML = state.groups
      .filter(function (g) { return g.name; })
      .map(function (g) { return '<option value="' + escapeHTML(g.name) + '"></option>'; })
      .join("");
  }

  // 「008-侧滑抄球」这类标题里已经带了序号，卡片左上角又有一个序号角标，
  // 两块一起显示就重复了。标题里的序号跟角标一致时把前缀去掉。
  function stripSeqPrefix(title, seq) {
    var t = String(title || "").trim();
    if (!seq || !/^\d+$/.test(seq)) { return t; }
    var m = t.match(/^0*(\d+)\s*[-–—_.、·:：\s]\s*(.+)$/);
    if (m && String(parseInt(m[1], 10)) === String(parseInt(seq, 10))) { return m[2]; }
    return t;
  }

  function shortTitle(v) {
    return stripSeqPrefix(v.title, v.seq);
  }

  function cardHTML(v) {
    if (state.editing === v.id) { return editHTML(v); }
    var cover = v.cover_url
      ? '<img src="' + escapeHTML(v.cover_url) + '" alt="" loading="lazy">'
      : '<span class="ph"></span>';
    var pct = v.duration > 0 ? Math.min(100, Math.round(v.progress / v.duration * 100)) : 0;
    var prog = (pct > 0 && pct < 100) ? '<div class="vprog"><i style="width:' + pct + '%"></i></div>' : "";
    var adm = state.manage
      ? '<div class="vadm"><button class="btn-mini" data-edit="' + v.id + '">编辑</button>' +
        '<button class="btn-mini danger" data-del="' + v.id + '">删除</button></div>'
      : "";
    return '<div class="vcard" data-play="' + v.id + '">' +
      '<div class="vcover">' + cover +
        (v.seq ? '<span class="vseq">' + escapeHTML(v.seq) + "</span>" : "") +
        (v.watched ? '<span class="vdone">已看</span>' : "") +
        (v.duration > 0 ? '<span class="vdur">' + fmtDur(v.duration) + "</span>" : "") +
      "</div>" + prog +
      '<div class="vbody"><div class="vtitle">' + escapeHTML(shortTitle(v)) + "</div>" +
        '<div class="vsub">' + (v.grp ? escapeHTML(v.grp) + " · " : "") + fmtSize(v.size) + "</div>" +
      "</div>" + adm + "</div>";
  }

  function editHTML(v) {
    return '<div class="vcard editing" data-edit-card="' + v.id + '">' +
      '<div class="vedit">' +
        '<div class="vfull"><label class="field">标题</label><input type="text" data-f="title" value="' +
          escapeHTML(v.title) + '"></div>' +
        '<div><label class="field">分组</label><input type="text" data-f="group" list="up-group-list" value="' +
          escapeHTML(v.grp || "") + '"></div>' +
        '<div><label class="field">序号</label><input type="text" data-f="seq" inputmode="numeric" value="' +
          escapeHTML(v.seq || "") + '"></div>' +
        '<div class="vfull row" style="margin-top:2px">' +
          '<button class="btn-mini" data-save="' + v.id + '">保存</button>' +
          '<button class="btn-mini" data-cover="' + v.id + '">换封面</button>' +
          '<button class="btn-mini" data-cancel-edit>取消</button>' +
          '<input type="file" accept="image/*" hidden data-cover-file="' + v.id + '">' +
        "</div>" +
      "</div></div>";
  }

  function renderGrid() {
    var list = visible();
    var empty = $("vempty");
    if (!list.length) {
      empty.textContent = state.videos.length
        ? "这个分组下还没有视频"
        : "还没有视频，点上方「上传」添加第一个。";
      empty.style.display = "block";
    } else {
      empty.style.display = "none";
    }
    $("vgrid").innerHTML = list.map(cardHTML).join("");
  }

  // ---------- 播放 ----------

  function play(id) {
    var v = findVideo(id);
    if (!v) { return; }
    state.current = v;
    state.lastSent = 0;
    $("player-title").textContent = v.title;
    $("player-foot").textContent = (v.grp ? v.grp + " · " : "") + fmtSize(v.size) +
      (v.duration > 0 ? " · " + fmtDur(v.duration) : "");

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

  // ---------- 上传 ----------

  function extractSeq(name) {
    var m = name.match(/^0*(\d{1,4})\s*[-–—_.、·:：\s]/);
    if (!m) { m = name.match(/^0*(\d{1,4})(?=\D|$)/); }
    return m ? String(parseInt(m[1], 10)).padStart(3, "0") : "";
  }

  function pickFiles(files) {
    if (!files || !files.length) { return; }
    var group = $("up-group").value.trim();
    var baseSeq = $("up-seq").value.trim();
    var usedMax = 0;
    state.videos.forEach(function (v) {
      if ((v.grp || "") === group && /^\d+$/.test(v.seq || "")) {
        usedMax = Math.max(usedMax, parseInt(v.seq, 10));
      }
    });
    var next = /^\d+$/.test(baseSeq) ? parseInt(baseSeq, 10) : usedMax + 1;

    Array.prototype.forEach.call(files, function (f) {
      var item = {
        file: f,
        title: f.name.replace(/\.[^.]+$/, ""),
        group: group,
        seq: extractSeq(f.name),
        size: f.size,
        duration: 0,
        cover: null,
        coverTried: false,
        status: "wait",
        percent: 0,
        error: "",
        xhr: null
      };
      if (item.seq) { usedMax = Math.max(usedMax, parseInt(item.seq, 10)); }
      else { item.seq = String(next).padStart(3, "0"); next++; }
      state.queue.push(item);
    });
    state.queue.sort(function (a, b) { return a.seq.localeCompare(b.seq); });
    renderQueue();
    prepareCovers();
  }

  function prepareCovers() {
    // 串行截封面：同时解码多个视频在手机上很容易把浏览器拖死
    var pending = state.queue.filter(function (it) {
      return it.status === "wait" && !it.coverTried;
    });
    var i = 0;
    (function next() {
      if (i >= pending.length) { return; }
      var it = pending[i++];
      it.coverTried = true;
      captureCover(it.file, function (blob, duration) {
        it.cover = blob;
        if (duration) { it.duration = duration; }
        next();
      });
    })();
  }

  function captureCover(file, done) {
    var url = URL.createObjectURL(file);
    var video = document.createElement("video");
    var finished = false;
    var timer = setTimeout(function () { finish(null, 0); }, 12000);

    function finish(blob, duration) {
      if (finished) { return; }
      finished = true;
      clearTimeout(timer);
      try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
      video.removeAttribute("src");
      done(blob || null, duration || 0);
    }

    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.onloadedmetadata = function () {
      var d = video.duration;
      if (!d || !isFinite(d)) { finish(null, 0); return; }
      // 取第 2 秒（或时长的 10%）那一帧，避免抓到片头黑场
      try { video.currentTime = Math.min(2, Math.max(0.1, d * 0.1)); }
      catch (e) { finish(null, Math.floor(d)); }
    };
    video.onseeked = function () {
      var d = Math.floor(video.duration || 0);
      try {
        var w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) { finish(null, d); return; }
        var tw = Math.min(640, w);
        var canvas = document.createElement("canvas");
        canvas.width = tw;
        canvas.height = Math.round(h * tw / w);
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (b) { finish(b, d); }, "image/jpeg", 0.82);
      } catch (e) {
        finish(null, d);
      }
    };
    video.onerror = function () { finish(null, 0); };
    video.src = url;
    video.load();
  }

  var STATUS_TEXT = { wait: "等待", up: "", cover: "写封面", done: "完成", err: "" };

  function renderQueue() {
    var el = $("up-list");
    if (!state.queue.length) { el.innerHTML = ""; return; }
    el.innerHTML = state.queue.map(function (it) {
      var text = it.status === "up" ? it.percent + "%"
        : it.status === "err" ? (it.error || "失败")
        : STATUS_TEXT[it.status];
      var cls = "ustate" + (it.status === "done" ? " done" : it.status === "err" ? " err" : "");
      var bar = it.status === "up"
        ? '<div class="ubar"><i style="width:' + it.percent + '%"></i></div>' : "";
      return "<li><div class=\"urow\"><span class=\"uname\">" +
        escapeHTML(it.seq + " " + stripSeqPrefix(it.title, it.seq)) +
        '</span><span class="' + cls + '">' + escapeHTML(text) + "</span></div>" + bar + "</li>";
    }).join("");
  }

  function startUpload() {
    if (state.uploading) { return; }
    var items = state.queue.filter(function (it) {
      return it.status === "wait" || it.status === "err";
    });
    if (!items.length) { toast("没有待上传的文件"); return; }
    var limit = state.maxUploadMb * 1024 * 1024;
    var over = items.filter(function (it) { return it.size > limit; });
    if (over.length) {
      toast("有 " + over.length + " 个文件超过 " + state.maxUploadMb + " MB");
      return;
    }

    state.uploading = true;
    $("btn-up-start").textContent = "上传中…";
    var i = 0;
    (function next() {
      if (i >= items.length) {
        state.uploading = false;
        $("btn-up-start").textContent = "开始上传";
        toast("上传完成");
        state.queue = state.queue.filter(function (it) { return it.status !== "done"; });
        renderQueue();
        return load();
      }
      // 串行上传：并发会在家庭宽带上互相抢带宽，反而更慢
      uploadOne(items[i++], next);
    })();
  }

  function uploadOne(item, done) {
    item.status = "up";
    item.percent = 0;
    item.error = "";
    renderQueue();

    var qs = "?filename=" + encodeURIComponent(item.file.name) +
      "&title=" + encodeURIComponent(item.title) +
      "&group=" + encodeURIComponent(item.group) +
      "&seq=" + encodeURIComponent(item.seq) +
      "&duration=" + encodeURIComponent(item.duration || 0);

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
      if (xhr.status === 200 && d.ok) {
        if (item.cover) {
          item.status = "cover";
          renderQueue();
          // 封面失败不算上传失败，视频本身已经存好了
          uploadCover(d.id, item.cover, function () {
            item.status = "done";
            item.percent = 100;
            item.file = null;
            renderQueue();
            done();
          });
        } else {
          item.status = "done";
          item.percent = 100;
          item.file = null;
          renderQueue();
          done();
        }
      } else {
        item.status = "err";
        item.error = d.error || ("HTTP " + xhr.status);
        renderQueue();
        done();
      }
    };
    xhr.onerror = function () { item.status = "err"; item.error = "网络中断"; renderQueue(); done(); };
    xhr.onabort = function () { item.status = "err"; item.error = "已取消"; renderQueue(); done(); };
    item.xhr = xhr;
    xhr.send(item.file);
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

  // ---------- 敏感操作口令弹框（删除视频） ----------

  function openDialog(kind, payload) {
    if (!state.unlockRequired) { return submitDialog({ kind: kind, payload: payload }, ""); }
    state.dialog = { kind: kind, payload: payload };
    $("dialog-title").textContent = "删除「" + payload.title + "」";
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
    var title = val("title");
    if (!title) { toast("标题不能为空"); return; }
    request("api/videos/update", {
      method: "POST",
      body: JSON.stringify({ id: id, title: title, group: val("group"), seq: val("seq") })
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
    $("group-chips").addEventListener("click", function (e) {
      var chip = e.target.closest(".chip[data-group]");
      if (!chip) { return; }
      var g = chip.getAttribute("data-group");
      state.group = g === "__all__" ? null : (g === "__none__" ? "" : g);
      render();
    });

    $("btn-manage").addEventListener("click", function () {
      state.manage = !state.manage;
      state.editing = null;
      render();
    });

    $("btn-upload").addEventListener("click", function () {
      var open = $("up-form").style.display !== "none";
      $("up-form").style.display = open ? "none" : "block";
      if (!open) { $("up-group").value = state.group || ""; }
    });

    $("btn-up-cancel").addEventListener("click", function () {
      $("up-form").style.display = "none";
    });

    $("up-pick").addEventListener("click", function () { $("up-files").click(); });

    $("up-files").addEventListener("change", function () {
      pickFiles(this.files);
      this.value = "";
    });

    $("btn-up-start").addEventListener("click", startUpload);

    $("vgrid").addEventListener("click", function (e) {
      if (e.target.closest(".vedit")) { return; }
      var edit = e.target.closest("[data-edit]");
      if (edit) { state.editing = Number(edit.getAttribute("data-edit")); renderGrid(); return; }
      var del = e.target.closest("[data-del]");
      if (del) {
        var id = Number(del.getAttribute("data-del"));
        var v = findVideo(id);
        if (v) { openDialog("delete", { id: id, title: v.title }); }
        return;
      }
      var save = e.target.closest("[data-save]");
      if (save) { saveEdit(Number(save.getAttribute("data-save"))); return; }
      if (e.target.closest("[data-cancel-edit]")) { state.editing = null; renderGrid(); return; }
      var cov = e.target.closest("[data-cover]");
      if (cov) {
        var input = document.querySelector('[data-cover-file="' + cov.getAttribute("data-cover") + '"]');
        if (input) { input.click(); }
        return;
      }
      if (state.editing) { return; }
      var playable = e.target.closest("[data-play]");
      if (playable) { play(Number(playable.getAttribute("data-play"))); }
    });

    $("vgrid").addEventListener("change", function (e) {
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
      else if (state.editing) { state.editing = null; renderGrid(); }
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
