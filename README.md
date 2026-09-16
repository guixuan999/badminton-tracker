# 羽毛球培训记录

记录孩子每天是否参加羽毛球培训、缴费与剩余课时，外加一个按时间线记录的训练视频库。自用工具，手机浏览器访问。

## 目录结构

```
server.py           后端（Python 3 标准库 + SQLite，零第三方依赖）
static/index.html   训练记录页结构
static/app.js       训练记录页逻辑
static/videos.html  训练视频页结构
static/videos.js    训练视频页逻辑（含上传前压缩）
static/video.css    训练视频页样式
static/style.css    两页共用的基础样式与设计变量
data/training.db    数据库（首次启动自动创建，已 gitignore）
media/origin/       上传的视频（已压缩后，已 gitignore）
media/cover/        封面图，上传时由浏览器从视频里截一帧（已 gitignore）
```

两个页面共用同一个后端，顶部有「训练记录 / 训练视频」互相切换。

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
| `UNLOCK_CODE` | 空 | 敏感操作口令（解锁报名 / 删缴费记录 / **删视频**）；留空则回退用 `ACCESS_CODE` |
| `SHOW_UNLOCK_CODE` | 1 | 是否在口令弹框里直接把口令显示出来（自用图方便）。设为 `0` 则隐藏 |
| `MEDIA_DIR` | ./media | 视频与封面存放目录 |
| `MAX_UPLOAD_MB` | 2048 | 单个视频文件大小上限（MB） |

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

> 换了部署目录的话，除了 service 里的 `DB_PATH` / `MEDIA_DIR`，
> 别忘了 nginx 里 `location /media/` 的 `alias` 也要跟着改，否则视频全部 404。

5. 访问 `https://bm.cypherx.top/`，首次打开会要求输入 `ACCESS_CODE`（存在浏览器 localStorage，之后免输）。手机可「添加到主屏幕」当 App 用。

### 视频相关的 nginx 配置（已在 `deploy/nginx-badminton.conf` 里）

```nginx
client_max_body_size 2048m;   # 默认只有 1MB，不改的话所有视频上传都会被 413 挡下
client_body_timeout 600s;

location /media/ {
    alias /opt/badminton-tracker/media/;   # 视频由 nginx 直接读盘，不经 Python
    add_header Accept-Ranges bytes;
}
location / {
    proxy_pass http://127.0.0.1:8765;
    proxy_request_buffering off;   # 上传直接透传，不在 nginx 落地成临时文件
    proxy_read_timeout 3600s;      # 视频可能长时间暂停，默认 60s 会中途 504
    proxy_send_timeout 3600s;
}
```

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

## 训练视频

访问 `/videos.html`（或点顶部「训练视频」）。**按时间线记录贵大王每次训练拍的视频**，最新的排最前面。

### 定位

这不是课程库，是**训练流水账**：

- 每天一组，组头显示当天的个数、总时长、占用空间
- 每个视频显示拍摄时刻、时长、体积，以及比原片压掉了多少
- 看过的标「已看」，看一半的在封面下沿有一条进度线

### 上传前会先压缩

选好文件点「开始」，视频**先在浏览器里压小再上传** —— 手机上直接传几百 MB 太亏，服务器也省地方。

实测一段 3 秒 720p 素材：**1.28 MB → 227 KB，压掉 82%**，画质按手机看完全够。

三档画质：

| 档位 | 分辨率上限 | 视频码率 | 约每分钟 |
| --- | --- | --- | --- |
| 省流 | 854 | 800 kbps | 6 MB |
| 标准（默认） | 960 | 1200 kbps | 9 MB |
| 清晰 | 1280 | 2000 kbps | 15 MB |

**这两种情况会自动跳过压缩**，队列里会写明原因：

- **原片已够小** —— 原文件比压完的预估体积还小，再压只会更差
- **浏览器不支持本地压缩 / 读不到时长** —— 直接传原片

### ⚠️ 压缩是实时的，会等

浏览器没法快速转码，这里用的是「边播边录」（MediaRecorder）：把画面逐帧画到缩小后的画布上，
再从视频接一条音轨，一起喂给编码器。**它是按墙上时间打时间戳的，所以 1 分钟素材就要压 1 分钟**，换不掉。

于是：

- 压缩期间队列里会显示百分比和「约剩 1:20」这样的倒计时
- **请让页面留在前台**，切到后台浏览器会降频，进度会变慢甚至中断
- 处理没结束时关页面会被拦一下，防止白等

> 想快就得上 WebCodecs 自己写 MP4 封装，硬件编码能跑到十几倍实时。
> 那是另一个量级的工作量（几百行封装代码，错一个字段整段视频就打不开），这个自用工具不值当。

### 输出格式

优先压成 **MP4 / H.264**，iPhone、安卓、桌面通吃。

浏览器不支持 MP4 录制时会退回 WebM，这时页面会**明确警告** —— WebM 在 iPhone 上大概率打不开，
建议改用 Chrome 或 Safari 上传。Chrome 130+ 和 Safari 都支持 MP4 录制，一般走不到这条退路。

压过的文件后缀会跟着实际容器改（`.mov` 进去、`.mp4` 出来），不会出现「叫 mov 其实是 mp4」的误导。

### 封面

上传前浏览器从视频第 2 秒截一帧当封面，**不用另外准备图片**。
截不出来（格式解不了）就显示播放占位图，不影响上传。

### 拍摄时间

默认用**视频文件自带的拍摄时间**（手机拍的都带），时间线上显示成「今天 · 9月16日 周三」「9月12日 周六」。
要统一改就在上传面板选「拍摄日期」，**留空就是用文件自带的时间**；单个视频也可以在管理模式里改。

### 播放

点卡片进播放浮层，支持**拖动进度条**（后端自己实现了 HTTP Range 的 206 分片响应）和**断点续播**，
看到一半关掉，下次从上次位置接着放。

> Safari / iOS 起播前会先发一个 `Range: bytes=0-1` 的探测请求，拿不到 206 就直接不播 ——
> 这也是为什么必须自己实现 Range，`SimpleHTTPRequestHandler` 原生不支持分片响应。

### 管理

点「管理」进入管理模式，每张卡片出现「编辑 / 删除」：

- **编辑**：改备注、拍摄日期和时间，也可以「换封面」（自己挑一张图）
- **删除**：行内确认后弹出口令框，输入 `UNLOCK_CODE` 才真正删除

删除会**连同磁盘上的视频文件和封面一起清掉**，和删缴费记录一样属于破坏性操作，所以共用同一个口令。

### ⚠️ 视频目录不做口令校验

`<video>` 标签没法带自定义请求头，所以 `/media/` 下的文件是**不需要口令**就能访问的，
靠的是文件名是 32 位随机十六进制（猜不到），而不是鉴权。

如果介意，两个选择：

```nginx
# 在 nginx 的 location /media/ 里限定来源
allow 1.2.3.4;      # 你家宽带出口 IP
deny all;

# 或者套一层 Basic Auth
auth_basic "restricted";
auth_basic_user_file /etc/nginx/.htpasswd-media;
```

另外 `location /media/` 里的 `alias` **必须和实际部署目录一致**
（默认写的是 `/opt/badminton-tracker/media/`）。改过目录名而没改这里，视频会全部 404。

## 数据库表

- `attendance(day, created_at, locked)` — 参训日期，一天一条，主键为日期
- `payment(id, pay_date, amount, sessions, note)` — 缴费记录
- `meta(k, v)` — 键值表，目前存 `locked_at`（最近一次锁定时间）
- `video(id, title, note, shot_at, filename, cover, duration, size, raw_size, progress, created_at)` — 训练视频

剩余课时 = 缴费记录 `sessions` 之和 − 参训记录总数。

`video` 里 `filename` / `cover` 存的是磁盘上的随机文件名，`size` 是压完后的实际体积，
`raw_size` 是压缩前的原始体积（用来算「压掉了多少」）。`size = 0` 的行不会出现在列表里
（上传中途断了就是这个状态）。整张表按 `shot_at` 倒序，也就是拍摄时间最新的排最前。

> 视频功能最初是按动作分组、排序号的（`grp` / `seq`），后来定位改成「按时间线记录每次训练」。
> `init_db()` 里有自动迁移：老库会补上 `shot_at` / `raw_size` 列（用上传时间回填拍摄时间），
> 并把废弃的 `grp` / `seq` 删掉。**索引一定要放在补列之后建** —— 否则老库还没有 `shot_at` 列时，
> `CREATE INDEX ... ON video(shot_at)` 会直接报 `no such column`，服务连启动都启动不了。

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

**视频不在备份范围内**，而且也不该每天全量拷一遍。`media/` 目录建议这样处理：

```bash
# 定期同步到别处（只补新增和改动的，已经传过的不重传）
rsync -a --ignore-existing /opt/badminton-tracker/media/ ~/badminton-media-backup/
```

注意 `media/origin` 和 `media/cover` 的文件名是随机串，直接看目录分不清哪个是哪个视频。
要知道「哪个文件对应哪个视频」，查数据库：

```bash
sqlite3 /opt/badminton-tracker/data/training.db \
  "SELECT id, title, grp, seq, filename, cover FROM video ORDER BY grp, seq;"
```
