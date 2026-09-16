#!/usr/bin/env python3
"""羽毛球培训记录 - 零依赖后端

仅使用 Python 3 标准库 + SQLite，不需要 pip 安装任何包。

启动:
    python3 server.py
    PORT=9000 ACCESS_CODE=1234 python3 server.py

环境变量:
    PORT        监听端口，默认 8765
    HOST        监听地址，默认 0.0.0.0
    DB_PATH     SQLite 文件路径，默认 ./data/training.db
    ACCESS_CODE 访问口令；留空表示不做校验（仅建议本机使用）
    UNLOCK_CODE 解锁已锁定记录的口令；留空则回退使用 ACCESS_CODE
    SHOW_UNLOCK_CODE  是否在解锁弹框里明示口令，默认 1（明示）；设为 0 则隐藏
    MEDIA_DIR   视频与封面存放目录，默认 ./media
    MAX_UPLOAD_MB  单个视频文件大小上限（MB），默认 2048
"""

import hmac
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import sys
import uuid
from datetime import date, datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.environ.get("DB_PATH", os.path.join(DATA_DIR, "training.db"))
ACCESS_CODE = os.environ.get("ACCESS_CODE", "").strip()
UNLOCK_CODE = os.environ.get("UNLOCK_CODE", "").strip()
# 是否在解锁弹框里把口令直接显示出来（自用场景图方便；公网多人使用时建议设为 0）
SHOW_UNLOCK_CODE = os.environ.get("SHOW_UNLOCK_CODE", "1").strip() != "0"
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8765"))

# ---------- 视频库 ----------
MEDIA_DIR = os.environ.get("MEDIA_DIR", os.path.join(BASE_DIR, "media"))
MEDIA_ORIGIN = os.path.join(MEDIA_DIR, "origin")
MEDIA_COVER = os.path.join(MEDIA_DIR, "cover")
MEDIA_TMP = os.path.join(MEDIA_DIR, "tmp")
# 单个视频文件大小上限（MB）。上传是流式落盘的，内存占用与文件大小无关
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "2048"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024

# 允许的视频/图片后缀。磁盘上一律用随机文件名，后缀只从白名单里取，
# 因此不存在「用户传入的路径」参与文件系统操作的情况
VIDEO_EXT = {
    ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".ts",
    ".flv", ".wmv", ".mpg", ".mpeg", ".3gp", ".ogv",
}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS attendance (
    day        TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    locked     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payment (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    pay_date  TEXT NOT NULL,
    amount    REAL NOT NULL,
    sessions  INTEGER NOT NULL,
    note      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_payment_date ON payment(pay_date);
CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS video (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    grp        TEXT    NOT NULL DEFAULT '',
    seq        TEXT    NOT NULL DEFAULT '',
    filename   TEXT    NOT NULL,
    cover      TEXT    NOT NULL DEFAULT '',
    duration   REAL    NOT NULL DEFAULT 0,
    size       INTEGER NOT NULL DEFAULT 0,
    progress   REAL    NOT NULL DEFAULT 0,
    note       TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_grp ON video(grp, seq, id);
"""


class LockedError(Exception):
    """尝试取消一条已锁定的参训记录"""


class UploadError(Exception):
    """视频上传过程中的可预期错误（体积超限、传输中断等）"""


def get_conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    # 不使用 WAL：单文件小库直接落盘，避免进程被强杀时 -wal 未合并导致丢数据
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA synchronous=FULL")
    return conn


def init_db():
    for d in (MEDIA_DIR, MEDIA_ORIGIN, MEDIA_COVER, MEDIA_TMP):
        os.makedirs(d, exist_ok=True)
    conn = get_conn()
    try:
        conn.executescript(SCHEMA)
        # 老库补列：attendance.locked 是后加的，CREATE TABLE IF NOT EXISTS 不会动已有表
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(attendance)")}
        if "locked" not in cols:
            conn.execute("ALTER TABLE attendance ADD COLUMN locked INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    finally:
        conn.close()
    # 清掉上次中断留下的半截上传文件
    for name in os.listdir(MEDIA_TMP):
        try:
            os.remove(os.path.join(MEDIA_TMP, name))
        except OSError:
            pass


def valid_day(value):
    if not isinstance(value, str) or not DATE_RE.match(value):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def parse_day(value, default=None):
    d = valid_day(value)
    if d is None:
        return default
    return d.strftime("%Y-%m-%d")


def check_unlock_code(supplied):
    """校验解锁口令。

    UNLOCK_CODE 未设置时回退用 ACCESS_CODE；两者都没设（本机自用）则直接放行。
    """
    expected = UNLOCK_CODE or ACCESS_CODE
    if not expected:
        return True
    return hmac.compare_digest(str(supplied or ""), expected)


# ---------- 数据操作 ----------

def list_attendance(start=None, end=None, only_locked=False):
    sql = "SELECT day FROM attendance"
    args = []
    conds = []
    if start:
        conds.append("day >= ?")
        args.append(start)
    if end:
        conds.append("day <= ?")
        args.append(end)
    if only_locked:
        conds.append("locked = 1")
    if conds:
        sql += " WHERE " + " AND ".join(conds)
    sql += " ORDER BY day"
    conn = get_conn()
    try:
        return [r["day"] for r in conn.execute(sql, args)]
    finally:
        conn.close()


def toggle_attendance(day):
    """返回操作后的状态: True=已报名, False=已取消

    取消已锁定的记录会抛 LockedError。
    """
    conn = get_conn()
    try:
        row = conn.execute("SELECT day, locked FROM attendance WHERE day = ?", (day,)).fetchone()
        if row:
            if row["locked"]:
                raise LockedError(day)
            conn.execute("DELETE FROM attendance WHERE day = ?", (day,))
            state = False
        else:
            conn.execute(
                "INSERT INTO attendance(day, created_at, locked) VALUES(?, ?, 0)",
                (day, datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
            )
            state = True
        conn.commit()
        return state
    finally:
        conn.close()


def set_attendance(day, signed):
    conn = get_conn()
    try:
        if signed:
            conn.execute(
                "INSERT OR IGNORE INTO attendance(day, created_at, locked) VALUES(?, ?, 0)",
                (day, datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
            )
        else:
            row = conn.execute("SELECT locked FROM attendance WHERE day = ?", (day,)).fetchone()
            if row and row["locked"]:
                raise LockedError(day)
            conn.execute("DELETE FROM attendance WHERE day = ?", (day,))
        conn.commit()
    finally:
        conn.close()


def lock_attendance():
    """把「今天及之前」所有未锁定的参训记录一次性锁定。

    未来日期（今天之后）的报名**不会**被锁定 —— 那些是提前报的，
    随时可能临时不去，必须保留取消的能力。

    返回 (本次锁定条数, 最近一次锁定时间)。
    锁定后的记录无法通过界面取消，只能走解锁（UNLOCK_CODE）或直接改数据库。
    """
    conn = get_conn()
    try:
        today = date.today().strftime("%Y-%m-%d")
        cur = conn.execute(
            "UPDATE attendance SET locked = 1 WHERE locked = 0 AND day <= ?", (today,)
        )
        count = cur.rowcount
        if count:
            conn.execute(
                "INSERT OR REPLACE INTO meta(k, v) VALUES('locked_at', ?)",
                (datetime.now().strftime("%Y-%m-%d %H:%M:%S"),),
            )
        conn.commit()
        row = conn.execute("SELECT v FROM meta WHERE k = 'locked_at'").fetchone()
        return count, (row["v"] if row else None)
    finally:
        conn.close()


def unlock_attendance(day):
    """解除单条记录的锁定，返回受影响行数。

    只解锁这一条，解锁后该日期恢复为普通已报名，可以再次点击取消。
    """
    conn = get_conn()
    try:
        cur = conn.execute(
            "UPDATE attendance SET locked = 0 WHERE day = ? AND locked = 1", (day,)
        )
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


def lock_info():
    conn = get_conn()
    try:
        row = conn.execute("SELECT v FROM meta WHERE k = 'locked_at'").fetchone()
        count = conn.execute(
            "SELECT COUNT(*) AS c FROM attendance WHERE locked = 1"
        ).fetchone()["c"]
        return {"locked_at": row["v"] if row else None, "locked_count": count}
    finally:
        conn.close()


def list_payments():
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, pay_date, amount, sessions, note FROM payment ORDER BY pay_date DESC, id DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def add_payment(pay_date, amount, sessions, note=""):
    conn = get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO payment(pay_date, amount, sessions, note) VALUES(?, ?, ?, ?)",
            (pay_date, amount, sessions, note or ""),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def delete_payment(pid):
    conn = get_conn()
    try:
        conn.execute("DELETE FROM payment WHERE id = ?", (pid,))
        conn.commit()
    finally:
        conn.close()


def build_summary(start=None, end=None):
    conn = get_conn()
    try:
        total_count = conn.execute("SELECT COUNT(*) AS c FROM attendance").fetchone()["c"]
        if start and end:
            range_count = conn.execute(
                "SELECT COUNT(*) AS c FROM attendance WHERE day BETWEEN ? AND ?", (start, end)
            ).fetchone()["c"]
        else:
            range_count = total_count
        paid = conn.execute(
            "SELECT COALESCE(SUM(sessions), 0) AS s, COALESCE(SUM(amount), 0) AS a FROM payment"
        ).fetchone()
        paid_sessions = int(paid["s"])
        paid_amount = round(float(paid["a"]), 2)
        remaining = paid_sessions - total_count
        return {
            "range_count": range_count,
            "total_count": total_count,
            "paid_sessions": paid_sessions,
            "paid_amount": paid_amount,
            "remaining": remaining,
        }
    finally:
        conn.close()


# ---------- 视频库数据操作 ----------

def _safe_media_path(directory, name):
    """把库里存的文件名拼成绝对路径，并确保没有跳出媒体目录。

    磁盘上的文件名一律由服务端随机生成，这一步是纵深防御：万一库里被塞进
    了 ../ 之类的值，也不会碰到媒体目录以外的文件。
    """
    if not name:
        return None
    path = os.path.realpath(os.path.join(directory, os.path.basename(name)))
    if os.path.dirname(path) != os.path.realpath(directory):
        return None
    return path


def _rm(path):
    try:
        os.remove(path)
    except OSError:
        pass


def normalize_seq(value):
    """序号统一成 3 位：8 → 008。这样字典序就等于数字序，列表天然有序。"""
    s = str(value or "").strip()
    if s.isdigit():
        return s.zfill(3)
    return s[:12]


def _seq_key(seq):
    """自然序排序键，兜住「有的是 008、有的没填序号」的混合情况。"""
    parts = re.split(r"(\d+)", str(seq or ""))
    return [int(p) if i % 2 else p.lower() for i, p in enumerate(parts)]


def list_videos(group=None, keyword=None):
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, title, grp, seq, filename, cover, duration, size, progress, note, created_at "
            "FROM video WHERE size > 0"
        ).fetchall()
        # 分组顺序 = 该分组第一个视频的 id（即用户先建哪个分组哪个在前）。
        # 按分组名的中文排序没有意义（会变成 体能/手法/步法 这种码位顺序）。
        order = {
            r["grp"]: r["ord"]
            for r in conn.execute("SELECT grp, MIN(id) AS ord FROM video GROUP BY grp")
        }
    finally:
        conn.close()

    items = [dict(r) for r in rows]
    if group:
        items = [v for v in items if (v["grp"] or "") == group]
    if keyword:
        kw = keyword.lower()
        items = [v for v in items if kw in (v["title"] + " " + (v["note"] or "")).lower()]
    items.sort(key=lambda v: (order.get(v["grp"] or "", 1 << 62), _seq_key(v["seq"]), v["id"]))

    for v in items:
        # 相对路径：挂在根路径 / 子路径 / 子域下都能直接用，和后端接口保持一致
        v["url"] = "media/origin/" + v["filename"]
        v["cover_url"] = ("media/cover/" + v["cover"]) if v["cover"] else ""
        v["watched"] = bool(v["duration"] > 0 and v["progress"] > v["duration"] * 0.9)
        v.pop("filename", None)
        v.pop("cover", None)
    return items


def video_groups():
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT grp AS name, COUNT(*) AS count, COALESCE(SUM(size), 0) AS size "
            "FROM video WHERE size > 0 GROUP BY grp ORDER BY MIN(id)"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def videos_stats():
    conn = get_conn()
    try:
        r = conn.execute(
            "SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS s, "
            "COALESCE(SUM(CASE WHEN duration > 0 AND progress > duration * 0.9 "
            "             THEN 1 ELSE 0 END), 0) AS w "
            "FROM video WHERE size > 0"
        ).fetchone()
        return {"count": int(r["c"]), "size": int(r["s"]), "watched": int(r["w"])}
    finally:
        conn.close()


def get_video(pid):
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM video WHERE id = ?", (pid,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


# 允许被改的字段，写死白名单，避免把 SQL 拼出别的列
VIDEO_EDITABLE = ("title", "grp", "seq", "note")


def update_video(pid, fields):
    sets, args = [], []
    for k in VIDEO_EDITABLE:
        if k in fields:
            sets.append(k + " = ?")
            args.append(fields[k])
    if not sets:
        return 0
    args.append(pid)
    conn = get_conn()
    try:
        cur = conn.execute("UPDATE video SET " + ", ".join(sets) + " WHERE id = ?", args)
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


def add_video(title, grp, seq, filename, duration=0.0, size=0, note=""):
    conn = get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO video(title, grp, seq, filename, cover, duration, size, progress, note, created_at) "
            "VALUES(?, ?, ?, ?, '', ?, ?, 0, ?, ?)",
            (
                title, grp, seq, filename, float(duration or 0), int(size or 0),
                note or "", datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            ),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def set_video_cover(pid, cover):
    conn = get_conn()
    try:
        conn.execute("UPDATE video SET cover = ? WHERE id = ?", (cover, pid))
        conn.commit()
    finally:
        conn.close()


def set_video_progress(pid, pos, duration=0.0):
    conn = get_conn()
    try:
        if duration and duration > 0:
            conn.execute(
                "UPDATE video SET progress = ?, duration = ? WHERE id = ?", (pos, duration, pid)
            )
        else:
            conn.execute("UPDATE video SET progress = ? WHERE id = ?", (pos, pid))
        conn.commit()
    finally:
        conn.close()


def delete_video(pid):
    """删除记录并连同磁盘文件一起清掉，返回被删掉的记录。"""
    rec = get_video(pid)
    if not rec:
        return None
    conn = get_conn()
    try:
        conn.execute("DELETE FROM video WHERE id = ?", (pid,))
        conn.commit()
    finally:
        conn.close()
    for directory, name in ((MEDIA_ORIGIN, rec["filename"]), (MEDIA_COVER, rec["cover"])):
        path = _safe_media_path(directory, name)
        if path:
            _rm(path)
    return rec


# ---------- HTTP ----------

class Handler(SimpleHTTPRequestHandler):
    # 用 HTTP/1.1：视频拖动进度条会连续发很多个 Range 请求，
    # 长连接能省掉反复握手。代价是每条响应都必须带准确的 Content-Length，
    # 本文件里所有分支都做到了。
    protocol_version = "HTTP/1.1"
    # 空闲长连接最多挂 120 秒就回收，避免线程被占着不放
    timeout = 120

    def __init__(self, *args, **kwargs):
        kwargs["directory"] = STATIC_DIR
        super().__init__(*args, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # helpers
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _query(self):
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    def _authorized(self):
        if not ACCESS_CODE:
            return True
        supplied = self.headers.get("X-Access-Code", "")
        return supplied == ACCESS_CODE

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _unlock_fields(self):
        return {
            "unlock_required": bool(UNLOCK_CODE or ACCESS_CODE),
            "unlock_hint": (
                (UNLOCK_CODE or ACCESS_CODE)
                if SHOW_UNLOCK_CODE and (UNLOCK_CODE or ACCESS_CODE)
                else ""
            ),
        }

    # ---------- 视频：上传与播放 ----------

    def _receive_to_file(self, dest, limit):
        """把请求体原样流式写入 dest，返回写入字节数。

        刻意不用 multipart/form-data —— Python 3.13 起标准库已移除 cgi 模块，
        而自己解析 multipart 很容易把整个文件读进内存。改成「元数据走 query、
        文件体走裸 body」，几百 MB 的视频也只是 512KB 一块地过，内存不涨。
        """
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise UploadError("Content-Length 无效")
        if length <= 0:
            raise UploadError("缺少 Content-Length，无法确定文件大小")
        if length > limit:
            raise UploadError("文件超过 %d MB 上限" % (limit // 1024 // 1024))

        written = 0
        with open(dest, "wb") as f:
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(512 * 1024, remaining))
                if not chunk:
                    break
                f.write(chunk)
                written += len(chunk)
                remaining -= len(chunk)
        if written != length:
            raise UploadError("传输中断，只收到 %d/%d 字节" % (written, length))
        return written

    def _serve_media(self, path):
        """按 Range 返回视频或封面。

        自己实现 Range 是必需的：SimpleHTTPRequestHandler 原生不支持分片响应，
        而 Safari / iOS 起播前会先发一个 `Range: bytes=0-1` 探测请求，
        拿不到 206 就直接不播；桌面浏览器拖动进度条同样依赖 206。
        """
        parts = [p for p in path.split("/") if p]
        if len(parts) != 3 or parts[1] not in ("origin", "cover"):
            return self._json({"error": "not found"}, 404)
        directory = MEDIA_ORIGIN if parts[1] == "origin" else MEDIA_COVER
        target = _safe_media_path(directory, unquote(parts[2]))
        if not target or not os.path.isfile(target):
            return self._json({"error": "not found"}, 404)

        size = os.path.getsize(target)
        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if size <= 0:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        start, end, partial = 0, size - 1, False
        raw = (self.headers.get("Range") or "").strip()
        if raw:
            m = RANGE_RE.match(raw)
            ok = False
            if m:
                g1, g2 = m.group(1), m.group(2)
                if g1:
                    start = int(g1)
                    end = int(g2) if g2 else size - 1
                    ok = True
                elif g2:
                    start = max(size - int(g2), 0)  # bytes=-N 表示最后 N 字节
                    ok = True
            if not ok or start >= size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % size)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            end = min(end, size - 1)
            partial = True

        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if partial:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Cache-Control", "public, max-age=604800")
        self.end_headers()

        with open(target, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    # 用户拖了进度条，浏览器会掐掉旧连接，属正常现象
                    return
                remaining -= len(chunk)

    def _handle_raw_upload(self, path):
        """处理请求体是原始文件流的两个接口：/api/videos/upload 与 /api/videos/cover。"""
        qs = self._query()

        if path == "/api/videos/cover":
            try:
                pid = int(qs.get("id"))
            except (TypeError, ValueError):
                return self._json({"error": "id 无效"}, 400)
            rec = get_video(pid)
            if not rec:
                return self._json({"error": "视频不存在"}, 404)
            ext = os.path.splitext(qs.get("filename") or "")[1].lower()
            if ext not in IMAGE_EXT:
                ext = ".jpg"
            stored = uuid.uuid4().hex + ext
            tmp = os.path.join(MEDIA_TMP, stored + ".part")
            try:
                written = self._receive_to_file(tmp, 8 * 1024 * 1024)
            except UploadError as exc:
                _rm(tmp)
                return self._json({"error": str(exc)}, 400)
            if written <= 0:
                _rm(tmp)
                return self._json({"error": "封面内容为空"}, 400)
            os.replace(tmp, os.path.join(MEDIA_COVER, stored))
            old = rec["cover"]
            set_video_cover(pid, stored)
            if old:
                _rm(_safe_media_path(MEDIA_COVER, old) or "")
            return self._json({"ok": True, "id": pid, "cover_url": "media/cover/" + stored})

        # /api/videos/upload
        raw_name = os.path.basename(qs.get("filename") or "")
        ext = os.path.splitext(raw_name)[1].lower()
        if ext not in VIDEO_EXT:
            return self._json({"error": "不支持的视频格式：%s" % (ext or "无后缀")}, 400)

        title = (qs.get("title") or "").strip()[:120] or os.path.splitext(raw_name)[0][:120]
        grp = (qs.get("group") or "").strip()[:40]
        seq = normalize_seq(qs.get("seq"))
        note = (qs.get("note") or "").strip()[:200]

        try:
            duration = max(0.0, float(qs.get("duration") or 0))
        except ValueError:
            duration = 0.0
        if duration > 3600 * 24 or duration != duration:  # 挡住 NaN / 离谱值
            duration = 0.0

        stored = uuid.uuid4().hex + ext
        tmp = os.path.join(MEDIA_TMP, stored + ".part")
        try:
            written = self._receive_to_file(tmp, MAX_UPLOAD_BYTES)
        except UploadError as exc:
            _rm(tmp)
            return self._json({"error": str(exc)}, 400)
        except OSError as exc:
            _rm(tmp)
            return self._json({"error": "写入失败：%s" % exc}, 500)

        os.replace(tmp, os.path.join(MEDIA_ORIGIN, stored))
        pid = add_video(title, grp, seq, stored, duration, written, note)
        return self._json({
            "ok": True, "id": pid, "title": title, "group": grp, "seq": seq,
            "url": "media/origin/" + stored, "size": written,
        })

    # routes
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            if not self._authorized():
                return self._json({"error": "unauthorized"}, 401)
            qs = {}
            if "?" in self.path:
                from urllib.parse import parse_qs

                qs = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
            start = parse_day(qs.get("start"))
            end = parse_day(qs.get("end"))
            return self._json(
                {
                    "ok": True,
                    "today": date.today().strftime("%Y-%m-%d"),
                    "attendance": list_attendance(start, end),
                    "locked_days": list_attendance(start, end, only_locked=True),
                    "lock_info": lock_info(),
                    "payments": list_payments(),
                    "summary": build_summary(start, end),
                    "auth_required": bool(ACCESS_CODE),
                    "unlock_required": bool(UNLOCK_CODE or ACCESS_CODE),
                    "unlock_hint": (
                        (UNLOCK_CODE or ACCESS_CODE)
                        if SHOW_UNLOCK_CODE and (UNLOCK_CODE or ACCESS_CODE)
                        else ""
                    ),
                }
            )
        if path == "/api/videos":
            if not self._authorized():
                return self._json({"error": "unauthorized"}, 401)
            qs = self._query()
            payload = {
                "ok": True,
                "groups": video_groups(),
                "videos": list_videos((qs.get("group") or "").strip() or None,
                                      (qs.get("q") or "").strip() or None),
                "stats": videos_stats(),
                "max_upload_mb": MAX_UPLOAD_MB,
            }
            payload.update(self._unlock_fields())
            return self._json(payload)
        if path.startswith("/media/"):
            return self._serve_media(path)
        if path.startswith("/api/"):
            return self._json({"error": "not found"}, 404)
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return self._json({"error": "not found"}, 404)
        if not self._authorized():
            return self._json({"error": "unauthorized"}, 401)

        # 这两条的请求体是文件流，必须先于 _body() 处理 ——
        # _body() 会把 Content-Length 指定的内容一次读进内存，正好把这个上传毁了
        if path in ("/api/videos/upload", "/api/videos/cover"):
            return self._handle_raw_upload(path)

        body = self._body()

        if path == "/api/attendance/toggle":
            day = parse_day(body.get("date"))
            if not day:
                return self._json({"error": "日期格式应为 YYYY-MM-DD"}, 400)
            try:
                signed = toggle_attendance(day)
            except LockedError:
                return self._json(
                    {"error": "locked", "date": day, "message": "该记录已锁定，无法取消"}, 409
                )
            return self._json({"ok": True, "date": day, "signed": signed})

        if path == "/api/attendance/set":
            day = parse_day(body.get("date"))
            if not day:
                return self._json({"error": "日期格式应为 YYYY-MM-DD"}, 400)
            try:
                set_attendance(day, bool(body.get("signed")))
            except LockedError:
                return self._json(
                    {"error": "locked", "date": day, "message": "该记录已锁定，无法取消"}, 409
                )
            return self._json({"ok": True, "date": day, "signed": bool(body.get("signed"))})

        if path == "/api/attendance/lock":
            count, locked_at = lock_attendance()
            return self._json({"ok": True, "locked_count": count, "locked_at": locked_at})

        if path == "/api/attendance/unlock":
            day = parse_day(body.get("date"))
            if not day:
                return self._json({"error": "日期格式应为 YYYY-MM-DD"}, 400)
            if not check_unlock_code(body.get("token")):
                return self._json({"error": "bad_token", "message": "解锁口令不正确"}, 403)
            n = unlock_attendance(day)
            return self._json({"ok": True, "date": day, "unlocked": n})

        if path == "/api/payment/add":
            pay_date = parse_day(body.get("date"), date.today().strftime("%Y-%m-%d"))
            try:
                amount = round(float(body.get("amount")), 2)
                sessions = int(body.get("sessions"))
            except (TypeError, ValueError):
                return self._json({"error": "金额或次数无效"}, 400)
            if amount < 0 or sessions <= 0:
                return self._json({"error": "金额不能为负，次数需大于 0"}, 400)
            pid = add_payment(pay_date, amount, sessions, str(body.get("note") or "")[:200])
            return self._json({"ok": True, "id": pid})

        if path == "/api/payment/delete":
            try:
                pid = int(body.get("id"))
            except (TypeError, ValueError):
                return self._json({"error": "id 无效"}, 400)
            if not check_unlock_code(body.get("token")):
                return self._json({"error": "bad_token", "message": "口令不正确"}, 403)
            delete_payment(pid)
            return self._json({"ok": True, "id": pid})

        if path == "/api/videos/update":
            try:
                vid = int(body.get("id"))
            except (TypeError, ValueError):
                return self._json({"error": "id 无效"}, 400)
            if not get_video(vid):
                return self._json({"error": "视频不存在"}, 404)
            fields = {}
            if "title" in body:
                title = str(body.get("title") or "").strip()[:120]
                if not title:
                    return self._json({"error": "标题不能为空"}, 400)
                fields["title"] = title
            if "group" in body:
                fields["grp"] = str(body.get("group") or "").strip()[:40]
            if "seq" in body:
                fields["seq"] = normalize_seq(body.get("seq"))
            if "note" in body:
                fields["note"] = str(body.get("note") or "").strip()[:200]
            update_video(vid, fields)
            return self._json({"ok": True, "id": vid})

        if path == "/api/videos/delete":
            try:
                vid = int(body.get("id"))
            except (TypeError, ValueError):
                return self._json({"error": "id 无效"}, 400)
            # 删除会连磁盘上的视频文件一起清掉，和删缴费记录一样属于破坏性操作
            if not check_unlock_code(body.get("token")):
                return self._json({"error": "bad_token", "message": "口令不正确"}, 403)
            rec = delete_video(vid)
            if not rec:
                return self._json({"error": "视频不存在"}, 404)
            return self._json({"ok": True, "id": vid, "title": rec["title"]})

        if path == "/api/videos/progress":
            try:
                vid = int(body.get("id"))
                pos = max(0.0, float(body.get("pos") or 0))
            except (TypeError, ValueError):
                return self._json({"error": "参数无效"}, 400)
            try:
                duration = max(0.0, float(body.get("duration") or 0))
            except (TypeError, ValueError):
                duration = 0.0
            if not get_video(vid):
                return self._json({"error": "视频不存在"}, 404)
            set_video_progress(vid, pos, duration)
            return self._json({"ok": True})

        return self._json({"error": "not found"}, 404)


def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("数据库: %s" % DB_PATH)
    print("媒体库: %s（上限 %d MB/个）" % (MEDIA_DIR, MAX_UPLOAD_MB))
    print("访问控制: %s" % ("已启用口令" if ACCESS_CODE else "未启用（仅限本机/内网使用）"))
    print("服务已启动: http://127.0.0.1:%d" % PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        server.server_close()


if __name__ == "__main__":
    main()
