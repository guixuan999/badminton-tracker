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
| `UNLOCK_CODE` | 空 | 解锁已锁定记录的口令；留空则回退用 `ACCESS_CODE` |
| `SHOW_UNLOCK_CODE` | 1 | 是否在解锁弹框里直接把口令显示出来（自用图方便）。设为 `0` 则隐藏 |

## 部署到云服务器（nginx 独立子域 bm.cypherx.top）

前端所有资源与接口都用**相对路径**，因此挂在域名根路径、挂在 `/bm/` 这样的子路径、或者挂到独立子域，三种方式都能直接用，后端无需改动。目前线上采用的是**独立子域** `bm.cypherx.top`。

1. 上传整个目录到服务器（本项目部署在 `/opt/badminton-tracker`），确认有 Python 3.7+

2. 建子域站点并发证书（先后顺序很重要，见下方警告）：

```bash
sudo cp deploy/nginx-badminton.conf /etc/nginx/sites-available/badminton
sudo ln -sf /etc/nginx/sites-available/badminton /etc/nginx/sites-enabled/badminton
sudo nginx -t && sudo systemctl reload nginx
```

> ⚠️ **先让带 `server_name bm.cypherx.top` 的块生效，再跑 certbot。**
> 顺序反了会出事：certbot 找不到匹配的 server 块时会"就近"挑中默认站点，
> 把博客的证书覆盖成新域的（这个坑实际踩过一次，博客 HTTPS 一度报证书不匹配）。

```bash
sudo certbot --nginx -d bm.cypherx.top     # 提示选 2（Redirect）
```

> 原理：子域部署时 `proxy_pass http://127.0.0.1:8765;` **结尾不带斜杠**，
> 请求路径原样透传，`/api/state` 到后端还是 `/api/state`。
> 这点和子路径部署**正好相反** —— 子路径必须写成 `proxy_pass .../;` 靠结尾斜杠剥前缀，别照抄。
>
> 下线：删掉 `/etc/nginx/sites-enabled/badminton` 这个软链接即可，博客配置不受影响。

3. （可选）旧链接兼容：让原来的 `www.cypherx.top/bm/` 自动跳到新子域

```bash
sudo cp deploy/nginx-badminton-legacy.conf /etc/nginx/snippets/badminton.conf
```

在博客站点的 `server { }` 块**内**（443 那块）加一行：

```nginx
include /etc/nginx/snippets/badminton.conf;
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

> 不需要兼容旧链接就跳过这步。想彻底让 `/bm/` 回归 404，把 `include` 那行删掉即可，子域不受影响。

4. 配置 systemd 守护（注意 `HOST=127.0.0.1` 让端口只对本机开放）：

```bash
sudo cp deploy/badminton.service /etc/systemd/system/
sudo $EDITOR /etc/systemd/system/badminton.service   # 改 ACCESS_CODE
sudo systemctl daemon-reload
sudo systemctl enable --now badminton
```

5. 访问 `https://bm.cypherx.top/`，首次打开会要求输入 `ACCESS_CODE`（存在浏览器 localStorage，之后免输）。手机可「添加到主屏幕」当 App 用。

### ⚠️ 两个部署时容易踩的坑

**① 云服务器通常有两道防火墙，都要放行 80/443**

- 云厂商控制台的**安全组**（阿里云 / 腾讯云等）
- 机器本机运行的 **ufw / firewalld**

只开一道的表现是：外网 SYN 包到达网卡但无任何响应（`curl` 返回 `000`，浏览器转圈到超时）。
定位方法：

```bash
sudo tcpdump -i any -nn 'tcp port 443'    # 只有 [S] 没有 [S.] 即为被丢包
sudo ufw status                            # 看本机防火墙放行了哪些端口
```

放行：`sudo ufw allow 443/tcp && sudo ufw reload`

**② 换协议或换域名后，都要重新输一次口令**

localStorage 按**协议 + 域名 + 端口**三者隔离，其中任何一项变了就是一个全新的源，口令不会自动带过去。已经遇到过的两种情况：

- http → https
- `www.cypherx.top/bm/` → `bm.cypherx.top`（子域是独立源，口令不共享）

重新输入一次即可，之后照常免输。同理，换过地址的桌面图标要删掉重加。

## 数据库表

- `attendance(day, created_at, locked)` — 参训日期，一天一条，主键为日期
- `payment(id, pay_date, amount, sessions, note)` — 缴费记录
- `meta(k, v)` — 键值表，目前存 `locked_at`（最近一次锁定时间）

剩余课时 = 缴费记录 `sessions` 之和 − 参训记录总数。

### 记录锁定

参训明细展开后底部有「锁定」按钮，作用是把**今天及之前**所有未锁定的参训记录一次性冻结：

- **只锁今天和过去的日期**。今天之后提前报的名不会被锁——那些课还没上，随时可能临时不去，必须保留取消的能力
- 锁定后这些记录无法在界面上取消（日历点击和后端接口都会拒绝，返回 409）
- 锁定之后再补报的日期（哪怕是过去的日期）不会被自动锁上，仍可自由取消，直到下次点「锁定」

**解锁**：在日历上点击已锁定的日期，会弹出输入框要求填写解锁口令（`UNLOCK_CODE`），
口令正确即解除该条的锁定，再点一次即可取消。解锁是**单条**的，不会影响其他已锁定记录。

默认情况下弹框里会**直接显示口令**（`SHOW_UNLOCK_CODE=1`），照着输入即可 —— 这是给自用场景省事用的。
如果哪天这个页面会给别人看，把 `SHOW_UNLOCK_CODE` 设为 `0` 关掉，口令就只存在于服务端。

口令未设置时回退使用 `ACCESS_CODE`；两者都为空（本机自用）则不再询问，点击直接解锁。

**删除缴费记录同样需要这个口令**。缴费记录一删就会改变剩余课时，属于同等敏感的破坏性操作，
所以在管理模式里点「删除」、行内确认之后，还会再要求输入一次口令。两类操作共用同一个 `UNLOCK_CODE`。

确实需要绕过界面时也可以直接操作数据库：

```bash
sqlite3 /opt/badminton-tracker/data/training.db
sqlite> UPDATE attendance SET locked = 0 WHERE day = '2026-08-01';   -- 解锁单条
sqlite> UPDATE attendance SET locked = 0;                            -- 全部解锁
```

`locked` 列由 `init_db()` 自动迁移，老库首次用新版本启动时会自动补上，数据不受影响。

## 备份

数据库是单个文件。建议用 `tools/backup.sh` 做定时备份（保留最近 30 份）：

```bash
chmod +x tools/backup.sh
# 每天凌晨 3 点自动备份
(crontab -l 2>/dev/null; echo "0 3 * * * /opt/badminton-tracker/tools/backup.sh") | crontab -
```

手动拷走一份：

```bash
cp /opt/badminton-tracker/data/training.db ~/training.db.bak
```
