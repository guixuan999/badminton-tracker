#!/bin/bash
# 备份 training.db，保留最近 30 份
#
# 用法：
#   chmod +x tools/backup.sh
#   ./tools/backup.sh                      # 手动备份一次
#   crontab -e 加入：0 3 * * * /opt/badminton-tracker/tools/backup.sh
#
# 备份文件落在 data/backups/（该目录已被 .gitignore 忽略）

set -e

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB="${DB_PATH:-$BASE_DIR/data/training.db}"
DST="$BASE_DIR/data/backups"

if [ ! -f "$DB" ]; then
    echo "找不到数据库文件：$DB" >&2
    exit 1
fi

mkdir -p "$DST"
cp "$DB" "$DST/training-$(date +%Y%m%d-%H%M%S).db"

# 只保留最近 30 份，更早的删掉
ls -1t "$DST"/training-*.db 2>/dev/null | tail -n +31 | xargs -r rm -f

echo "已备份到 $DST（当前 $(ls -1 "$DST"/training-*.db 2>/dev/null | wc -l) 份）"
