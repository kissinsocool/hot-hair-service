# Nginx 连接上限与 PM2 日志轮转

两项都是服务器配置，不改客户端接口、业务代码和数据库，也不需要重启 Node 服务。

## 一、Nginx 连接上限

### 现状与目标

线上 `worker_connections` 为 1024，`worker_rlimit_nofile` 未设置，worker 的文件句柄软上限为 1024。每条经代理的 WebSocket 占用 2 个连接（客户端一条、到 Node 一条），所以同时在线约 500 就会到顶，远低于应用自身的 `WS_MAX_CONNECTIONS=5000`。

目标值：`worker_connections 4096`，`worker_rlimit_nofile 8192`（句柄数取连接数的 2 倍）。连接槽位在启动时预分配，每个 worker 多占约 1–2 MB 内存，不增加 CPU。

这两条指令分别属于 `events` 和主配置上下文，不能放进 `conf.d`，只能改 `/etc/nginx/nginx.conf`，因此仓库里没有对应的配置文件，只有本文的步骤。

### 实施

1. 记录现状：
   ```
   grep -nE 'worker_processes|worker_connections|worker_rlimit_nofile' /etc/nginx/nginx.conf
   for pid in $(pgrep -f 'nginx: worker'); do grep 'open files' /proc/$pid/limits; done
   ```
2. 备份：`cp -p /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak-$(date +%Y%m%d)`
3. 修改 `/etc/nginx/nginx.conf`：
   - 主配置上下文（与 `worker_processes` 同级）加入 `worker_rlimit_nofile 8192;`
   - `events { }` 内把 `worker_connections` 改为 `4096;`
4. `nginx -t && systemctl reload nginx`。语法检查失败则恢复备份，不重载。

### 验证

- worker 的 `open files` 软上限显示 8192（步骤 1 的第二条命令）。
- `/health`、`/ready` 返回 200，带坐标的店铺列表正常，WebSocket 升级返回 101。
- 顺带确认 Node 进程自身的句柄上限足够（应不低于 8192）：
  `grep 'open files' /proc/$(pgrep -f 'node.*index.js' | head -1)/limits`
  若偏低，需要在 PM2 的启动环境里提高 `nofile`，另行评估。

### 回滚

恢复备份文件，`nginx -t && systemctl reload nginx`。

## 二、PM2 日志轮转

### 方案

使用系统自带的 logrotate，配置为仓库中的 `ops/logrotate/hot-hair-pm2`：每天轮转，保留 14 份，`copytruncate` 方式（PM2 无需重启或收信号），隔天压缩。没有常驻进程；每天运行一次，压缩一个几十 MB 的文件约占一个核 1–2 秒。

没有选 `pm2-logrotate`，因为它是常驻模块（约 30–50 MB 内存），而服务器的 Nginx 日志已经在用 logrotate。

`copytruncate` 在复制与截断之间可能丢失极少量日志行，对请求日志可以接受。

### 实施

1. 确认日志路径与配置一致（默认 `/root/.pm2/logs/`），并记录当前占用：
   ```
   pm2 info <应用名> | grep -i 'log path'
   du -sh /root/.pm2/logs && df -h /
   ```
   路径不同则先修改 `ops/logrotate/hot-hair-pm2` 第一行的路径并走 Git 提交流程。
2. 确认没有已安装的 `pm2-logrotate`（`pm2 ls` 的 Module 区域），避免两套轮转同时生效。
3. 确认 `/etc/logrotate.d/hot-hair-pm2` 不存在后安装。logrotate 要求配置文件属主为 root 且不可被组和其他人写入：
   ```
   install -o root -g root -m 0644 /opt/hot-hair-service/ops/logrotate/hot-hair-pm2 /etc/logrotate.d/hot-hair-pm2
   ```
   这里用复制而不是软链接，以免仓库文件权限变化导致 logrotate 拒绝加载；以后改动配置需重新执行本条。
4. 演练（不改动任何文件）：`logrotate -d /etc/logrotate.d/hot-hair-pm2`，输出中不应有 error。
5. 若现有日志已经很大，立即执行一次：`logrotate -f /etc/logrotate.d/hot-hair-pm2`。

### 验证

- `/root/.pm2/logs/` 下出现带日期后缀的文件，原文件被截断且新请求继续写入（`tail -f` 能看到新行）。
- `df -h /` 的占用没有异常增长；次日确认前一天的文件已压缩为 `.gz`。
- `systemctl list-timers logrotate.timer` 或 `/etc/cron.daily/logrotate` 存在，说明每天会自动运行。

### 回滚

删除 `/etc/logrotate.d/hot-hair-pm2`。已轮转的日志文件保留。

## 建单事务重试

建单请求的 `http_request` 日志包含 `bookingTransactionRetries`，表示 MongoDB 事务回调额外执行的次数。未进入事务的请求没有该字段，单独重试 commit 也不会增加该值。k6 写入模式发出的请求 ID 为 `k6.<K6_RUN_ID>.<VU>.<ITER>`。在压测环境中将服务端本次运行各实例的 JSON 请求日志汇总到同一文件，再按运行 ID 统计。

```bash
jq -s --arg runId "$K6_RUN_ID" '
  map(select(.event == "http_request"
    and (.requestId | startswith("k6." + $runId + "."))
    and has("bookingTransactionRetries")))
  | {requests: length, retried: (map(select(.bookingTransactionRetries > 0)) | length),
     retries: (map(.bookingTransactionRetries) | add // 0)}
' requests.jsonl
```
