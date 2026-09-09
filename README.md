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

## 部署到云服务器（nginx 子路径 /bm/，与现有站点共存）

前端所有资源与接口都用**相对路径**，因此既能挂在域名根路径，也能挂在 `/bm/` 这样的子路径，后端无需改动。

1. 上传整个目录到服务器（如 `/opt/badminton`），确认有 Python 3.6+

2. 放好 nginx 片段，并让博客站点引用它：

```bash
sudo cp deploy/nginx-badminton.conf /etc/nginx/snippets/badminton.conf
```

在博客站点的 `server { }` 块**内**加一行（443 块必须加；若 80 块也直接提供博客服务，同样加一行）：

```nginx
include /etc/nginx/snippets/badminton.conf;
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

> 原理：`proxy_pass http://127.0.0.1:8765/;` 结尾的斜杠会剥掉 `/bm/` 前缀，
> 所以 `/bm/api/state` 到后端就是 `/api/state`。
> 想下线只删那一行 `include` 即可，博客配置一行不改。

3. 配置 systemd 守护（注意 `HOST=127.0.0.1` 让端口只对本机开放）：

```bash
sudo cp deploy/badminton.service /etc/systemd/system/
sudo $EDITOR /etc/systemd/system/badminton.service   # 改 ACCESS_CODE
sudo systemctl daemon-reload
sudo systemctl enable --now badminton
```

4. 访问 `https://你的域名/bm/`，手机可「添加到主屏幕」当 App 用。

## 数据库表

- `attendance(day, created_at)` — 参训日期，一天一条，主键为日期
- `payment(id, pay_date, amount, sessions, note)` — 缴费记录

剩余课时 = 缴费记录 `sessions` 之和 − 参训记录总数。

## 备份

数据库是单个文件，定期拷走即可：

```bash
cp /opt/badminton/data/training.db /opt/badminton/data/training.db.bak
```
