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
"""

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
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8765"))

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS attendance (
    day        TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    pay_date  TEXT NOT NULL,
    amount    REAL NOT NULL,
    sessions  INTEGER NOT NULL,
    note      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_payment_date ON payment(pay_date);
"""


def get_conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    conn = get_conn()
    try:
        conn.executescript(SCHEMA)
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


# ---------- 数据操作 ----------

def list_attendance(start=None, end=None):
    sql = "SELECT day FROM attendance"
    args = []
    conds = []
    if start:
        conds.append("day >= ?")
        args.append(start)
    if end:
        conds.append("day <= ?")
        args.append(end)
    if conds:
        sql += " WHERE " + " AND ".join(conds)
    sql += " ORDER BY day"
    conn = get_conn()
    try:
        return [r["day"] for r in conn.execute(sql, args)]
    finally:
        conn.close()


def toggle_attendance(day):
    """返回操作后的状态: True=已报名, False=已取消"""
    conn = get_conn()
    try:
        row = conn.execute("SELECT day FROM attendance WHERE day = ?", (day,)).fetchone()
        if row:
            conn.execute("DELETE FROM attendance WHERE day = ?", (day,))
            state = False
        else:
            conn.execute(
                "INSERT INTO attendance(day, created_at) VALUES(?, ?)",
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
                "INSERT OR IGNORE INTO attendance(day, created_at) VALUES(?, ?)",
                (day, datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
            )
        else:
            conn.execute("DELETE FROM attendance WHERE day = ?", (day,))
        conn.commit()
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
                    "payments": list_payments(),
                    "summary": build_summary(start, end),
                    "auth_required": bool(ACCESS_CODE),
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
            signed = toggle_attendance(day)
            return self._json({"ok": True, "date": day, "signed": signed})

        if path == "/api/attendance/set":
            day = parse_day(body.get("date"))
            if not day:
                return self._json({"error": "日期格式应为 YYYY-MM-DD"}, 400)
            set_attendance(day, bool(body.get("signed")))
            return self._json({"ok": True, "date": day, "signed": bool(body.get("signed"))})

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
