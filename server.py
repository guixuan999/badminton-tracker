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
from datetime import date, datetime, timedelta, timezone
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
    title      TEXT    NOT NULL DEFAULT '',
    note       TEXT    NOT NULL DEFAULT '',
    shot_at    TEXT    NOT NULL DEFAULT '',
    filename   TEXT    NOT NULL,
    cover      TEXT    NOT NULL DEFAULT '',
    duration   REAL    NOT NULL DEFAULT 0,
    size       INTEGER NOT NULL DEFAULT 0,
    raw_size   INTEGER NOT NULL DEFAULT 0,
    progress   REAL    NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL
);
"""

# 索引必须和建表分开、等补列迁移跑完再建。
# 否则老库（video 表还没有 shot_at 列）会在这里直接报 "no such column: shot_at"，
# 服务连启动都启动不了 —— SCHEMA 里的 CREATE INDEX 是没机会等迁移的。
INDEXES = """
CREATE INDEX IF NOT EXISTS idx_payment_date ON payment(pay_date);
CREATE INDEX IF NOT EXISTS idx_video_shot ON video(shot_at);
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
        _migrate_video(conn)
        # 索引放在补列之后：老库没这一列时，先建索引会直接报 no such column
        conn.executescript(INDEXES)
        conn.commit()
    finally:
        conn.close()
    # 清掉上次中断留下的半截上传文件
    for name in os.listdir(MEDIA_TMP):
        try:
            os.remove(os.path.join(MEDIA_TMP, name))
        except OSError:
            pass


def _migrate_video(conn):
    """把视频表从最早的「分组 + 序号」课程式结构迁到时间线结构。

    视频库第一版是按动作分组、看序号的（grp/seq），后来定位改成「按时间线记录
    每次训练」，改为 shot_at + note。老库里的 grp/seq 没有日期信息，就用上传时间
    回填 shot_at，总比空着强。
    """
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(video)")}
    if not cols:
        return
    for name, decl in (
        ("note", "TEXT NOT NULL DEFAULT ''"),
        ("shot_at", "TEXT NOT NULL DEFAULT ''"),
        ("raw_size", "INTEGER NOT NULL DEFAULT 0"),
    ):
        if name not in cols:
            conn.execute("ALTER TABLE video ADD COLUMN %s %s" % (name, decl))
    conn.execute(
        "UPDATE video SET shot_at = substr(created_at, 1, 16) || ':00' WHERE shot_at = ''"
    )
    if "grp" in cols or "seq" in cols:
        # DROP COLUMN 要求先摘掉依赖它的索引；老版本 SQLite 不支持就当没这回事
        conn.execute("DROP INDEX IF EXISTS idx_video_grp")
        for c in ("grp", "seq"):
            if c in cols:
                try:
                    conn.execute("ALTER TABLE video DROP COLUMN " + c)
                except sqlite3.OperationalError:
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


SHOT_RE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$")

# 1904-01-01 → 1970-01-01 的秒数。MP4 的时间戳以 1904 为基准
MP4_EPOCH = 2082844800


def read_mp4_creation(path):
    """从 MP4 / MOV 的 moov/mvhd 里读出拍摄时间，读不到返回 None。

    为什么要读文件内部：file.lastModified 是**文件系统**的修改时间，视频一旦被复制、
    下载、或经微信/网盘转存，这个时间就变成「转存那一刻」—— 于是所有视频都被归到今天。
    而拍摄时间写在容器里，跟着文件内容走，转存不会丢。

    实现上不解析完整的 box 树：moov 可能在文件开头（faststart）也可能在结尾，
    老实按 box 走反而更脆。直接扫 'mvhd' 标记，再对取到的时间戳做合理性校验就够了。
    只读头 2MB + 尾 16MB，不会把几百 MB 的视频整个读进来。
    """
    try:
        size = os.path.getsize(path)
    except OSError:
        return None
    if size <= 0:
        return None

    windows = []
    try:
        with open(path, "rb") as f:
            head = f.read(min(size, 2 * 1024 * 1024))
            windows.append(head)
            if size > len(head):
                tail_len = min(size, 16 * 1024 * 1024)
                f.seek(size - tail_len)
                windows.append(f.read(tail_len))
    except OSError:
        return None

    for buf in windows:
        pos = buf.find(b"mvhd")
        while pos >= 0:
            dt = None
            off = pos + 8          # 跳过 "mvhd" 之后的 version(1) + flags(3)
            if pos + 5 <= len(buf):
                ver = buf[pos + 4]
                if ver == 1 and off + 8 <= len(buf):
                    dt = _mp4_secs_to_dt(int.from_bytes(buf[off:off + 8], "big"))
                elif ver == 0 and off + 4 <= len(buf):
                    dt = _mp4_secs_to_dt(int.from_bytes(buf[off:off + 4], "big"))
            if dt:
                return dt
            pos = buf.find(b"mvhd", pos + 1)
    return None


def _mp4_secs_to_dt(secs):
    """把 mvhd 的 1904 基准秒数转成本地时间。

    mvhd 规范上写 UTC，但不少安卓机直接把本地时间当 UTC 写进去。
    如果按 UTC 解释出来居然是未来（录像不可能在未来），那一定是后者，
    就把它当成本地墙上时间。这样两种设备都能落到正确的日期。
    """
    if not secs:
        return None
    try:
        aware = datetime.fromtimestamp(secs - MP4_EPOCH, timezone.utc)
    except (ValueError, OSError, OverflowError):
        return None
    if aware.year < 1990 or aware.year > 2100:
        return None
    local_of_utc = aware.astimezone().replace(tzinfo=None)
    utc_wall = aware.replace(tzinfo=None)
    dt = utc_wall if local_of_utc > datetime.now() else local_of_utc
    if dt > datetime.now() or dt.year < 1990:
        return None
    return dt


def parse_shot_at(value, default=None):
    """把 'YYYY-MM-DD' / 'YYYY-MM-DD HH:MM' / 'YYYY-MM-DD HH:MM:SS' 统一成完整时间串。

    拍摄时间是这个模块的排序主轴（时间线按它倒序），所以统一格式比省几个字节重要。
    """
    if not isinstance(value, str):
        return default
    m = SHOT_RE.match(value.strip())
    if not m:
        return default
    y, mo, d, hh, mi, ss = m.groups()
    try:
        dt = datetime(int(y), int(mo), int(d), int(hh or 0), int(mi or 0), int(ss or 0))
    except ValueError:
        return default
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def list_videos(keyword=None):
    """按拍摄时间倒序返回，最新的训练在最前面。"""
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, title, note, shot_at, filename, cover, duration, size, raw_size, progress "
            "FROM video WHERE size > 0 ORDER BY shot_at DESC, id DESC"
        ).fetchall()
    finally:
        conn.close()

    items = [dict(r) for r in rows]
    if keyword:
        kw = keyword.lower()
        items = [
            v for v in items
            if kw in ((v["title"] or "") + " " + (v["note"] or "")).lower()
        ]

    for v in items:
        # 相对路径：挂在根路径 / 子路径 / 子域下都能直接用，和后端接口保持一致
        v["url"] = "media/origin/" + v["filename"]
        v["cover_url"] = ("media/cover/" + v["cover"]) if v["cover"] else ""
        v["day"] = (v["shot_at"] or "")[:10]
        v["time"] = (v["shot_at"] or "")[11:16]
        v["watched"] = bool(v["duration"] > 0 and v["progress"] > v["duration"] * 0.9)
        # 压缩省下的体积；原片本来就小的时候不为负
        v["saved"] = max(0, int(v["raw_size"] or 0) - int(v["size"] or 0))
        v.pop("filename", None)
        v.pop("cover", None)
    return items


def video_days():
    """时间线用的按天汇总，最新的天排最前。"""
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT substr(shot_at, 1, 10) AS day, COUNT(*) AS count, "
            "COALESCE(SUM(duration), 0) AS duration, COALESCE(SUM(size), 0) AS size "
            "FROM video WHERE size > 0 GROUP BY day ORDER BY day DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def videos_stats():
    conn = get_conn()
    try:
        r = conn.execute(
            "SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS s, COALESCE(SUM(duration), 0) AS d, "
            "COALESCE(SUM(CASE WHEN raw_size > size THEN raw_size - size ELSE 0 END), 0) AS saved, "
            "COALESCE(SUM(CASE WHEN duration > 0 AND progress > duration * 0.9 "
            "             THEN 1 ELSE 0 END), 0) AS w "
            "FROM video WHERE size > 0"
        ).fetchone()
        return {
            "count": int(r["c"]),
            "size": int(r["s"]),
            "duration": float(r["d"]),
            "saved": int(r["saved"]),
            "watched": int(r["w"]),
        }
    finally:
        conn.close()


def resync_shot_times():
    """按视频文件里的 mvhd 修正拍摄时间。

    只在**确实能提供新信息**时才动记录，两条判断缺一不可：

    1. 该记录的 shot_at 日期 == created_at 日期 —— 也就是它看起来「落在了上传当天」，
       这正是要修的症状。日期已经被定成别的值（识别对了、或人工改过）就不碰，
       否则会把人家手工改好的日期冲掉。
    2. 文件里 mvhd 的日期 != created_at 日期 —— 说明文件确实带着独立的拍摄时间。

    第 2 条是关键。**浏览器压缩后的产物，mvhd 会被写成「压缩那一刻」**（实测确认：
    MediaRecorder 输出的 MP4，creation_time 就是编码时的墙上时间；WebM 干脆没有 mvhd）。
    这种文件的 mvhd 跟上传时间同一时刻，提供不了任何原始信息 —— 不加这条判断，
    「重认」就会把已经正确的日期又冲回上传当天，还不如不做。

    返回一个 dict：scanned 扫描数、changes 变更清单、
    decided 跳过数（日期已定）、no_meta 跳过数（文件里没有可用时间）。
    """
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, title, shot_at, created_at, filename FROM video WHERE size > 0"
        ).fetchall()
    finally:
        conn.close()

    scanned = 0
    decided = 0          # 日期已经定下来了，不该再动
    no_meta = 0          # 文件里读不出可用时间，或读出来就是上传时刻
    changes = []

    conn = get_conn()
    try:
        for r in rows:
            shot_day = (r["shot_at"] or "")[:10]
            made_day = (r["created_at"] or "")[:10]
            if shot_day and made_day and shot_day != made_day:
                decided += 1
                continue

            path = _safe_media_path(MEDIA_ORIGIN, r["filename"])
            if not path or not os.path.isfile(path):
                no_meta += 1
                continue
            scanned += 1

            dt = read_mp4_creation(path)
            if not dt:
                no_meta += 1
                continue
            new = dt.strftime("%Y-%m-%d %H:%M:%S")
            if new[:10] == made_day or new == r["shot_at"]:
                # 文件里的日期就是上传那天，说明它是被重新编码过的产物，没有原始信息
                no_meta += 1
                continue

            conn.execute("UPDATE video SET shot_at = ? WHERE id = ?", (new, r["id"]))
            changes.append({
                "id": r["id"], "title": r["title"],
                "from": r["shot_at"], "to": new,
            })
        conn.commit()
    finally:
        conn.close()

    return {"scanned": scanned, "decided": decided, "no_meta": no_meta, "changes": changes}


def get_video(pid):
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM video WHERE id = ?", (pid,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


# 允许被改的字段，写死白名单，避免把 SQL 拼出别的列
VIDEO_EDITABLE = ("title", "note", "shot_at")


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


def add_video(title, note, shot_at, filename, duration=0.0, size=0, raw_size=0):
    conn = get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO video(title, note, shot_at, filename, cover, duration, size, raw_size, "
            "                  progress, created_at) "
            "VALUES(?, ?, ?, ?, '', ?, ?, ?, 0, ?)",
            (
                title, note, shot_at, filename, float(duration or 0), int(size or 0),
                int(raw_size or 0), datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
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

    def handle_one_request(self):
        """浏览器切走页面、关标签、拖动进度条换连接时，会直接把 TCP 连接粗断，
        这在日常使用里是常态。默认实现会让 socketserver 打一整屏 traceback，
        日志里全是噪声，真出问题时反而看不见。这里安静收掉。"""
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            self.close_connection = True

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
        note = (qs.get("note") or "").strip()[:200]
        shot_at = parse_shot_at(
            qs.get("shot_at"), datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        )

        try:
            duration = max(0.0, float(qs.get("duration") or 0))
        except ValueError:
            duration = 0.0
        if duration != duration or duration > 3600 * 12:  # 挡住 NaN / 离谱值
            duration = 0.0

        try:
            raw_size = max(0, int(qs.get("raw_size") or 0))
        except ValueError:
            raw_size = 0

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
        # raw_size 是压缩前的原始体积，用来显示「压掉了多少」。
        # 客户端可能没传，或者传了个比实际还小的值（那种就是没压缩），都按实际大小算。
        if raw_size < written:
            raw_size = written
        pid = add_video(title, note, shot_at, stored, duration, written, raw_size)
        return self._json({
            "ok": True, "id": pid, "title": title, "shot_at": shot_at,
            "url": "media/origin/" + stored, "size": written, "raw_size": raw_size,
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
                "days": video_days(),
                "videos": list_videos((qs.get("q") or "").strip() or None),
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

        if path == "/api/videos/resync_shot":
            res = resync_shot_times()
            return self._json({
                "ok": True,
                "scanned": res["scanned"],
                "updated": len(res["changes"]),
                "decided": res["decided"],
                "no_meta": res["no_meta"],
                "changes": res["changes"][:60],
            })

        if path == "/api/videos/update":
            try:
                vid = int(body.get("id"))
            except (TypeError, ValueError):
                return self._json({"error": "id 无效"}, 400)
            if not get_video(vid):
                return self._json({"error": "视频不存在"}, 404)
            fields = {}
            if "title" in body:
                fields["title"] = str(body.get("title") or "").strip()[:120]
            if "note" in body:
                fields["note"] = str(body.get("note") or "").strip()[:200]
            if "shot_at" in body:
                shot = parse_shot_at(body.get("shot_at"))
                if not shot:
                    return self._json({"error": "时间格式应为 YYYY-MM-DD HH:MM"}, 400)
                fields["shot_at"] = shot
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
