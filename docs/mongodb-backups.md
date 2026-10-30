# MongoDB 备份与恢复

## 生产链路

`ops/mongo-backup` 由 root cron 每天北京时间 03:00 执行，日志写入 `/root/mongo_backup.log`。沿用现有 `hothairdb/mongodb_backups/` 私有 OSS 路径和 OSS CLI 凭据，不改变客户端接口或数据。

- MongoDB Database Tools 从 `/root/.config/hot-hair/mongo-backup.yml` 读取 URI 和密码；文件权限必须为 600，凭据不进入 Git 或命令行参数。
- 使用 `mongodump --oplog` 全量备份，恢复时必须使用 `--oplogReplay`。备份账号需要读取 oplog 的权限；权限不足时失败退出，不降级为不一致备份。
- 文件保存在 `/data/backup/mongodb/` 下独立的私有工作目录。文件锁阻止重叠运行；导出、压缩、上传或下载校验失败时退出非零，保留本地工作目录。
- 使用现有 `/usr/local/bin/ossutil-v2` 上传私有对象，再下载并比较 SHA-256。只有一致时才更新 `last-success.json` 并清理本次本地文件。
- 不自动删除 OSS 历史备份。失败目录需在问题解决后人工检查清理，防止长期积累占满磁盘。现有日志仅记录任务结果；本次不新增通知服务。

旧 `/root/mongo_backup.sh` 退出调度但保留，避免任何旧版本误报成功逻辑继续运行。旧 `.tar.gz` 内以时间命名目录，新文件内以 `dump/` 为根目录；人工恢复须先确认布局。两者均为 mongodump 目录格式，旧备份未包含 oplog。

## 发布和回滚

先通过失败注入测试，提交并推送 Git。在服务器确认分支和工作树干净后拉取指定提交，检查 Python 语法。将已有凭据迁移到受限配置文件，保留原 crontab 副本；仅把原 MongoDB 备份任务替换为：

```cron
0 3 * * * /usr/bin/python3 /opt/hot-hair-service/ops/mongo-backup >> /root/mongo_backup.log 2>&1
```

立即执行一次新备份并从 OSS 下载进行隔离恢复，检查集合、索引及数据校验。无需重启生产应用或 MongoDB。回滚调度应先暂停新任务、保留所有备份与配置，再指向经过验证的脚本 Git 版本；旧脚本缺少失败保护，不应作为日常回滚目标。

## 隔离恢复要求

仅在新建临时数据目录、不同端口、绑定 `127.0.0.1` 的独立 mongod 实例上演练。恢复前核对该实例的实际 dbPath 和 PID，绝不连接生产 27017 或复用生产目录。下载并验证备份 SHA-256，解包后使用：

```sh
mongorestore --host 127.0.0.1 --port "$TEST_PORT" \
  --dir "$RESTORE_DIR/dump" --oplogReplay --stopOnError --objcheck \
  --numParallelCollections=1
```

恢复必须无失败文档，所有业务集合通过 `validate({full:true})`。oplog 为空时，逐集合比较 BSON 文档数及元数据索引；oplog 非空时，文档数可能因回放改变，需结合回放操作核对。结束后关闭该临时实例，删除本次临时恢复数据，生产数据库和 OSS 备份保持原样。

数据库备份不覆盖操作系统、Nginx、应用环境变量和 OSS 图片，不能代替整机恢复方案。

## 2026-10-30 发布验证

- 脚本 Git 提交 `7d6559c`，服务器工作树干净后通过 Git 快进部署；凭据迁移为独立 600 权限配置，未轮换数据库账号。
- 17:25（北京时间）手动运行成功：`mongo_backup_20261030_172514_do0yc7qi.tar.gz`，519,408 字节，SHA-256 `da5fe7341c3c3e23367e9594ee4a5c359be7c04bc8569d5f4433744552a6821f`，上传后回读校验通过。
- 从 OSS 下载到服务器新建的独立临时 mongod（不同端口、全新 dbPath、256 MiB WiredTiger 缓存、关闭 TTL 扫描），核对 PID 和 dbPath 后使用 `--oplogReplay --stopOnError --objcheck` 完整恢复成功。18 个业务集合全部通过 full validate、文档数和索引名称比对；这份 oplog 只有 no-op，未向生产注入测试写入。临时实例和恢复数据已清理。
- cron 已切换为新脚本，每天北京时间 03:00 执行；原 cron 保存到 `/root/crontab.before-mongo-backup-20261030_172736`。
- 本地 `npm test` 206 项通过，包含导出失败、缺少 oplog、上传失败、下载失败、校验不符、成功清理、配置权限和任务互斥检查。
- 安全组 `sg-2ze8yt4nep45qhf7b1jl` 删除入方向 TCP 3000/3000、来源 0.0.0.0/0 的允许规则。健康检查和带坐标的店铺列表接口返回 200，WebSocket 升级返回 101，3000 公网连接超时。未修改 SSH 规则，未重启生产应用或 MongoDB。
