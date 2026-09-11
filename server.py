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
"""

import hmac
import json
import os
import re
import sqlite3
import sys
from datetime import date, datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

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

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

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
"""


class LockedError(Exception):
    """尝试取消一条已锁定的参训记录"""


def get_conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    # 不使用 WAL：单文件小库直接落盘，避免进程被强杀时 -wal 未合并导致丢数据
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA synchronous=FULL")
    return conn


def init_db():
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


# ---------- HTTP ----------

class Handler(SimpleHTTPRequestHandler):
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
        if path.startswith("/api/"):
            return self._json({"error": "not found"}, 404)
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return self._json({"error": "not found"}, 404)
        if not self._authorized():
            return self._json({"error": "unauthorized"}, 401)
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

        return self._json({"error": "not found"}, 404)


def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("数据库: %s" % DB_PATH)
    print("访问控制: %s" % ("已启用口令" if ACCESS_CODE else "未启用（仅限本机/内网使用）"))
    print("服务已启动: http://127.0.0.1:%d" % PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        server.server_close()


if __name__ == "__main__":
    main()
