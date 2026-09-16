#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""核对视频文件里记录的拍摄时间对不对。

背景：时间线是按 `shot_at` 排的，而这个值来自视频文件内部的拍摄时间戳
（MP4/MOV 的 moov/mvhd，WebM 的 DateUTC），不是文件系统的修改时间 ——
后者在被复制、下载、转存之后会变成「转存那一刻」，视频就会全被归到上传当天。

这个脚本把「文件里到底写了什么」摊开给你看，可以和数据库里的值逐条对照。

零第三方依赖，Python 3.6+ 就能跑。四种用法：

  # 1. 核对单个文件（本地路径）
  python3 tools/check_shot.py IMG_1234.mp4

  # 2. 核对单个文件（直接给地址，不用先下载整个文件）
  python3 tools/check_shot.py https://bm.cypherx.top/media/origin/xxxx.mp4

  # 3. 核对整个目录（在服务器上跑最方便）
  python3 tools/check_shot.py --dir /opt/badminton-tracker/media/origin

  # 4. 对着数据库逐条核对（要能同时看到 .db 和媒体目录）
  python3 tools/check_shot.py --db data/training.db --media media/origin

  # 5. 不开 SSH，直接从线上拉列表逐个核对（需要访问口令）
  python3 tools/check_shot.py --site https://bm.cypherx.top --code 你的口令

判定结果：

  OK         文件里的时间和数据库里的一致
  MISMATCH   两边不一致（两个值都会列出来）
  SUSPECT    文件里记的是「生成这个文件的时刻」而不是拍摄时刻
             —— 典型是压缩后没有回写时间戳的产物，原始拍摄时间已经没了
  NO-META    文件里根本没有拍摄时间（WebM、或元数据被转发时抹掉了）
"""

import argparse
import os
import sqlite3
import sys
from datetime import datetime, timezone

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# 1904-01-01 → 1970-01-01 的秒数（MP4 的时间戳基准）
MP4_EPOCH = 2082844800
# 2001-01-01 → 1970-01-01 的秒数（WebM/EBML 的 DateUTC 基准）
WEBM_EPOCH = 978307200

HEAD_BYTES = 2 * 1024 * 1024
TAIL_BYTES = 16 * 1024 * 1024
VIDEO_EXT = (".mp4", ".mov", ".m4v", ".webm", ".mkv")


# ---------------------------------------------------------------- 时间戳解析

def _mp4_secs_to_dt(secs):
    """mvhd 的 1904 基准秒数 → 本地时间。

    规范上写 UTC，但不少安卓机直接把本地时间当 UTC 写进去。
    按 UTC 解释出来居然是未来（录像不可能在未来），那就是后者，
    改按本地墙上时间理解 —— 和 server.py 里的处理保持一致。
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


def _webm_date(buf):
    """WebM/EBML 里的 DateUTC 元素（ID 0x4461），值是 2001 基准的纳秒。"""
    i = buf.find(b"\x44\x61")
    while i >= 0:
        parsed = _read_vint(buf, i + 2)
        if parsed:
            size, ln = parsed
            start = i + 2 + ln
            if size == 8 and start + 8 <= len(buf):
                ns = int.from_bytes(buf[start:start + 8], "big", signed=True)
                secs = ns / 1e9 + WEBM_EPOCH
                try:
                    aware = datetime.fromtimestamp(secs, timezone.utc)
                except (ValueError, OSError, OverflowError):
                    aware = None
                if aware and 1990 <= aware.year <= 2100:
                    dt = aware.astimezone().replace(tzinfo=None)
                    if dt <= datetime.now():
                        return dt
        i = buf.find(b"\x44\x61", i + 2)
    return None


def _read_vint(buf, off):
    """EBML 变长整数，返回 (值, 占用字节数)。"""
    if off >= len(buf):
        return None
    first = buf[off]
    if first == 0:
        return None
    length, mask = 1, 0x80
    while not (first & mask):
        mask >>= 1
        length += 1
        if length > 8:
            return None
    if off + length > len(buf):
        return None
    val = first & (mask - 1)
    for k in range(1, length):
        val = (val << 8) | buf[off + k]
    return val, length


def probe(windows):
    """在若干段字节里找拍摄时间。返回 (datetime, 来源标签)。"""
    for buf in windows:
        pos = buf.find(b"mvhd")
        while pos >= 0:
            off = pos + 8          # 跳过 "mvhd" 之后的 version(1) + flags(3)
            dt = None
            if pos + 5 <= len(buf):
                ver = buf[pos + 4]
                if ver == 1 and off + 8 <= len(buf):
                    dt = _mp4_secs_to_dt(int.from_bytes(buf[off:off + 8], "big"))
                elif ver == 0 and off + 4 <= len(buf):
                    dt = _mp4_secs_to_dt(int.from_bytes(buf[off:off + 4], "big"))
            if dt:
                return dt, "mvhd"
            pos = buf.find(b"mvhd", pos + 1)
    for buf in windows:
        dt = _webm_date(buf)
        if dt:
            return dt, "DateUTC"
    return None, ""


# ---------------------------------------------------------------- 取字节

def windows_from_local(path, tail_bytes=TAIL_BYTES):
    size = os.path.getsize(path)
    if size <= 0:
        return None, 0, "文件是空的"
    out = []
    try:
        with open(path, "rb") as f:
            head = f.read(min(size, HEAD_BYTES))
            out.append(head)
            if size > len(head):
                n = min(size, tail_bytes)
                f.seek(size - n)
                out.append(f.read(n))
    except OSError as exc:
        return None, size, str(exc)
    return out, size, ""


def _http_get(url, rng, no_proxy):
    from urllib.request import Request, build_opener, ProxyHandler
    from urllib.error import HTTPError, URLError

    opener = build_opener(ProxyHandler({} if no_proxy else None)) \
        if no_proxy else build_opener()
    req = Request(url, headers={"Range": "bytes=" + rng, "User-Agent": "check-shot/1"})
    try:
        with opener.open(req, timeout=60) as resp:
            return resp.read(), resp.status, dict(resp.headers)
    except HTTPError as exc:
        if exc.code == 416:      # 要的范围超出文件大小，说明文件比这还小
            return b"", 416, dict(exc.headers)
        raise


def windows_from_url(url, tail_bytes=TAIL_BYTES, no_proxy=False):
    """只取头尾几 MB，不下载整个视频。服务端支持 Range（本项目自带 206 实现）。"""
    from urllib.error import HTTPError, URLError

    try:
        head, status, headers = _http_get(url, "0-%d" % (HEAD_BYTES - 1), no_proxy)
    except (HTTPError, URLError, OSError) as exc:
        return None, 0, "取头部失败：%s" % exc

    total = 0
    cr = headers.get("Content-Range") or ""
    if "/" in cr:
        try:
            total = int(cr.rsplit("/", 1)[1])
        except ValueError:
            total = 0
    if not total:
        try:
            total = int(headers.get("Content-Length") or 0)
        except ValueError:
            total = 0

    if status == 200:
        # 服务端不支持 Range，整个文件都下来了
        total = len(head)
        return [head], total, ""

    out = [head]
    if total > len(head) and total > 0:
        n = min(total, tail_bytes)
        try:
            tail, tstatus, _ = _http_get(url, "-%d" % n, no_proxy)
            if tail and len(tail) < total:
                out.append(tail)
        except (HTTPError, URLError, OSError):
            pass          # 尾部取不到就只用头部碰运气
    return out, total, ""


# ---------------------------------------------------------------- 对照判定

def judge(dt, kind, row):
    """返回 (标记, 说明)。row 为 None 时只报告文件里写了什么。

    判定顺序有讲究：**先看「文件里写的是不是生成这个文件的时刻」，再谈和数据库一不一致**。

    原因是两条判断会互相干扰：早期压缩上传的产物，mvhd 写的就是编码那一刻，
    而当时入库的 shot_at 也正是从同一个来源取的 —— 两边是「一起错」，
    看起来一致，其实是错得一模一样。只比对是否相等会把它判成 OK，正好漏掉最该报的情况。
    """
    if dt is None:
        return "NO-META", "文件里没有拍摄时间"
    if row is None:
        return "FILE", dt.strftime("%Y-%m-%d %H:%M:%S")

    shot_at = (row.get("shot_at") or "")[:19]
    created = (row.get("created_at") or "")[:19]
    fdt = dt.strftime("%Y-%m-%d %H:%M:%S")

    # 文件里的时间 ≈ 入库时刻 → 它是被「造」出来的时间，不是拍摄时间
    if created:
        try:
            c = datetime.strptime(created[:19], "%Y-%m-%d %H:%M:%S")
            gap = abs((c - dt).total_seconds())
            if gap <= 300:
                return "SUSPECT", "%s  ← 距入库仅 %d 秒，很可能只是压缩/上传的时刻" % (fdt, gap)
        except ValueError:
            pass

    if shot_at and fdt[:16] == shot_at[:16]:
        return "OK", fdt
    try:
        if shot_at:
            a = datetime.strptime(shot_at[:19], "%Y-%m-%d %H:%M:%S")
            gap = abs((a - dt).total_seconds())
            if gap <= 120:
                return "OK", "%s（与库中相差 %d 秒）" % (fdt, gap)
    except ValueError:
        pass

    if shot_at[:10] == fdt[:10]:
        return "OK", fdt
    return "MISMATCH", "文件 %s   数据库 %s" % (fdt, shot_at or "(空)")


COLOR = {"OK": "\033[32m", "MISMATCH": "\033[31m", "SUSPECT": "\033[33m",
         "NO-META": "\033[90m", "FILE": "\033[36m"}
RESET = "\033[0m"


def use_color():
    return sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def tag(name):
    if not use_color():
        return name
    return COLOR.get(name, "") + name + RESET


# ---------------------------------------------------------------- 各模式

def load_db(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, title, note, shot_at, filename, size, raw_size, created_at "
            "FROM video WHERE size > 0 ORDER BY shot_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def print_header(title):
    print("")
    print(title)
    print("-" * 72)


def report(label, dt, kind, row, size):
    flag, detail = judge(dt, kind, row)
    sz = ("%.1f MB" % (size / 1048576.0)) if size else "?"
    print("%s  %-38s %8s  %s" % (tag(flag), label[:38], sz, detail))
    return flag


def expand_dirs(targets):
    """把目录展开成文件列表。放在外面做，免得递归时把标题重复打一遍。"""
    out = []
    for t in targets:
        if os.path.isdir(t):
            names = sorted(n for n in os.listdir(t) if n.lower().endswith(VIDEO_EXT))
            out.extend(os.path.join(t, n) for n in names)
        else:
            out.append(t)
    return out


def mode_files(targets, tail_bytes, no_proxy, rows_by_file=None):
    stats = {}
    print_header("逐个核对（文件里记录的拍摄时间）")
    for t in targets:
        label = os.path.basename(t)
        windows, size, err = windows_from_local(t, tail_bytes)
        row = (rows_by_file or {}).get(os.path.basename(t))
        if err:
            print("%s  %-38s %8s  %s" % (tag("NO-META"), label[:38], "?", err))
            stats["NO-META"] = stats.get("NO-META", 0) + 1
            continue
        dt, kind = probe(windows)
        f = report(label + ("  [%s]" % kind if kind else ""), dt, kind, row, size)
        stats[f] = stats.get(f, 0) + 1
    return stats


def mode_site(site, code, tail_bytes, no_proxy, limit):
    import json
    from urllib.request import Request, build_opener, ProxyHandler
    from urllib.error import HTTPError, URLError

    site = site.rstrip("/")
    api = site + "/api/videos"
    opener = build_opener(ProxyHandler({})) if no_proxy else build_opener()
    req = Request(api, headers={"X-Access-Code": code or "", "User-Agent": "check-shot/1"})
    try:
        with opener.open(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        print("取 %s 失败：HTTP %d %s" % (api, exc.code,
              "（检查 --code 口令）" if exc.code == 401 else ""))
        return None
    except (URLError, OSError) as exc:
        print("取 %s 失败：%s" % (api, exc))
        return None

    vids = data.get("videos") or []
    if limit:
        vids = vids[:limit]
    print_header("从 %s 拉到的 %d 条记录" % (site, len(vids)))
    stats = {}
    for i, v in enumerate(vids, 1):
        url = site + "/" + (v.get("url") or "").lstrip("/")
        label = "%2d. %s" % (i, (v.get("title") or "?")[:28])
        windows, size, err = windows_from_url(url, tail_bytes, no_proxy)
        if err:
            print("%s  %-38s %8s  %s" % (tag("NO-META"), label[:38], "?", err))
            stats["NO-META"] = stats.get("NO-META", 0) + 1
            continue
        dt, kind = probe(windows)
        row = {"shot_at": v.get("shot_at"), "created_at": v.get("created_at")}
        f = report(label + ("  [%s]" % kind if kind else ""), dt, kind, row, size)
        stats[f] = stats.get(f, 0) + 1
    return stats


def summarize(stats):
    if not stats:
        return
    print("")
    print("-" * 72)
    order = ["OK", "SUSPECT", "MISMATCH", "NO-META", "FILE"]
    print("  " + "   ".join("%s %d" % (k, stats[k]) for k in order if stats.get(k)))
    if stats.get("SUSPECT"):
        print("")
        print("  SUSPECT = 文件里的时间离入库只有几秒，基本可以断定它是「生成这个文件的时刻」，")
        print("  不是拍摄时间。说明这个视频被重新编码过（压缩上传、或微信转发），")
        print("  原始拍摄时间已经不在文件里了 —— 只能手工改日期，或拿原始文件重新上传一遍。")
    if stats.get("MISMATCH"):
        print("")
        print("  MISMATCH = 两边对不上。文件里的是可用的，点「重认拍摄时间」能按它修正。")
    if stats.get("NO-META"):
        print("")
        print("  NO-META = 读不到时间。WebM 没有 mvhd，微信转发过的也会被抹掉元数据。")


# ---------------------------------------------------------------- 入口

def main():
    ap = argparse.ArgumentParser(
        description="核对视频文件里记录的拍摄时间",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("targets", nargs="*", help="文件路径或 http(s) 地址")
    ap.add_argument("--dir", action="append", default=[], help="扫描目录（可重复）")
    ap.add_argument("--db", help="数据库路径，用来逐条对照 shot_at")
    ap.add_argument("--media", help="媒体目录（配合 --db 用，默认取数据库同级 media/origin）")
    ap.add_argument("--site", help="站点根地址，例如 https://bm.cypherx.top")
    ap.add_argument("--code", default=os.environ.get("ACCESS_CODE", ""), help="访问口令")
    ap.add_argument("--limit", type=int, default=0, help="--site 模式最多核对几条")
    ap.add_argument("--tail-mb", type=int, default=16, help="尾部额外读多少 MB（默认 16）")
    ap.add_argument("--no-proxy", action="store_true", help="走直连，忽略系统代理")
    args = ap.parse_args()

    tsz = max(1, args.tail_mb) * 1024 * 1024
    rows_by_file = {}
    stats = {}

    if args.db:
        if not os.path.isfile(args.db):
            print("找不到数据库：%s" % args.db)
            return 2
        media = args.media or os.path.join(os.path.dirname(os.path.abspath(args.db)),
                                           "..", "media", "origin")
        media = os.path.normpath(media)
        rows = load_db(args.db)
        for r in rows:
            rows_by_file[r["filename"]] = r
        print("数据库：%s" % args.db)
        print("媒体目录：%s" % media)
        print("记录数：%d" % len(rows))
        if os.path.isdir(media):
            stats.update(mode_files(expand_dirs([media]), tsz, args.no_proxy, rows_by_file))
        else:
            print("媒体目录不存在，跳过文件核对")

    if args.site:
        s = mode_site(args.site, args.code, tsz, args.no_proxy, args.limit)
        if s:
            for k, v in s.items():
                stats[k] = stats.get(k, 0) + v

    local = list(args.targets) + list(args.dir)
    urls = [t for t in local if t.startswith("http://") or t.startswith("https://")]
    paths = [t for t in local if t not in urls]

    if paths:
        stats.update(mode_files(expand_dirs(paths), tsz, args.no_proxy, rows_by_file))

    if urls:
        print_header("逐个核对（远程文件，只取头尾几 MB）")
        for u in urls:
            windows, size, err = windows_from_url(u, tsz, args.no_proxy)
            label = os.path.basename(u.split("?")[0])[:38]
            if err:
                print("%s  %-38s %8s  %s" % (tag("NO-META"), label, "?", err))
                stats["NO-META"] = stats.get("NO-META", 0) + 1
                continue
            dt, kind = probe(windows)
            f = report(label + ("  [%s]" % kind if kind else ""), dt, kind, None, size)
            stats[f] = stats.get(f, 0) + 1

    if not (args.db or args.site or local):
        ap.print_help()
        print("\n例子：python3 tools/check_shot.py --db data/training.db")
        return 1

    summarize(stats)
    return 0


if __name__ == "__main__":
    sys.exit(main())
