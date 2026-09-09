# 羽毛球培训记录

记录孩子每天是否参加羽毛球培训，以及缴费与剩余课时。自用工具，手机浏览器访问。

## 目录结构

```
server.py           后端（Python 3 标准库 + SQLite，零第三方依赖）
static/index.html   页面结构
static/app.js       前端逻辑
static/style.css    样式
data/training.db    数据库（首次启动自动创建，已 gitignore）
```

## 本地运行

```bash
python3 server.py
# 浏览器打开 http://127.0.0.1:8765
```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | 8765 | 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `DB_PATH` | ./data/training.db | 数据库路径 |
| `ACCESS_CODE` | 空 | 访问口令；**部署到公网时务必设置** |

## 部署到云服务器

1. 上传整个目录到服务器（如 `/opt/badminton`），确认有 Python 3.6+
2. 设置口令并做 systemd 守护：

```ini
# /etc/systemd/system/badminton.service
[Unit]
Description=Badminton Training Tracker
After=network.target

[Service]
WorkingDirectory=/opt/badminton
Environment=PORT=8765
Environment=ACCESS_CODE=你的口令
ExecStart=/usr/bin/python3 /opt/badminton/server.py
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now badminton
```

3. 用 nginx 反代并配 HTTPS（域名已备案，可直接签发证书）：

```nginx
server {
    listen 443 ssl;
    server_name 你的域名;
    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

4. 手机上打开域名即可，建议「添加到主屏幕」当 App 用。

## 数据库表

- `attendance(day, created_at)` — 参训日期，一天一条，主键为日期
- `payment(id, pay_date, amount, sessions, note)` — 缴费记录

剩余课时 = 缴费记录 `sessions` 之和 − 参训记录总数。

## 备份

数据库是单个文件，定期拷走即可：

```bash
cp /opt/badminton/data/training.db /opt/badminton/data/training.db.bak
```
