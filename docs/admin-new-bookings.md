# 后台今日新订单

2026-10-23：概览增加“今日新订单”卡片，统计上海时区当天创建的预约，包含所有订单状态，与预约服务日期无关。点击复用订单汇总界面，展示今日创建的订单。卡片右上角显示当前管理员尚未查看的数量，零时不展示气泡。

## 已核对的生产者与消费者

- 后端 `src/routes/admin.js` 的 GET `/api/admin/overview` 原有字段保留，新增 `todayBookingCount`、`unviewedBookingCount`、`bookingsSnapshotBefore`。
- 新增 GET `/api/admin/new-bookings?before=<ISO时间>`，返回同一快照所在上海日期、创建时间严格早于快照的订单，使用既有分页头和订单序列化。新增 POST `/api/admin/new-bookings/viewed`，请求 `{before: <ISO时间>}`，只推进当前鉴权管理员的已查看时间边界。非法或未来时间拒绝。
- `src/models.js` 的 AdminUser 新增可选 `newBookingsViewedBefore`。无该字段的已有管理员当天订单均视为未查看，无需回填；使用 `$max` 原子推进，多个窗口不会让已查看边界倒退。
- `merchant_app` 的 `AdminRepository` 读取新增统计、逐页加载完整今日快照，在列表成功展示后提交已查看标记；加载或标记失败不清除气泡。`AdminOverviewPage` 展示卡片与数字气泡，打开列表后刷新统计，概览激活时每 30 秒更新。`AdminOrdersSummaryScreen` 只增加可选标题参数，原全部订单入口不变。
- 已跨 `hot_hair_service`、`merchant_app`、`hot_hair_mp` 检索：上述 `/admin/overview`、`/admin/bookings` 仅由后台 AdminRepository 消费；商家端和小程序不调用这些管理员接口，不写入管理员已查看状态。现有 `/admin/bookings`、预约创建请求和公共订单响应不改动。

## 兼容、顺序与回滚

全部新增字段/接口，旧后台原请求继续正常工作；新后台连接旧后端时不启用新订单入口，既有全部订单功能保留。先发布后端再发布后台。无需数据库迁移和新增索引，复用 Booking.createdAt 索引；回滚优先后台，数据库中可选边界保留，旧后端忽略。不能以浏览器本地存储代替服务端已查看状态，避免刷新、换设备或多个管理员相互影响。

时间边界固定于加载概览的服务端快照，列表跨页使用相同条件；查看时仅推进该快照，加载期间快照之后的新订单留待下一次查看。上海零点后统计自然切换新的一天。

## 验证

验证上海日期边界、首次查看、跨日、独立管理员、同一快照分页、未来/非法时间、并发边界不倒退、旧概览与订单请求结构兼容；后台验证卡片数字、气泡、列表导航、请求失败保留未读和旧订单入口。运行后端与 Flutter 测试、静态检查及 Web 构建；实际数据库并发和线上发布单独记录。

本地验证通过：后端 Node 全量 184 项、Flutter 全量 116 项、真实本地 MongoDB replica set 集成测试 29 项；Flutter analyze 无问题。新增 HTTP 集成用例核对上海午夜、旧订单列表请求、管理员身份隔离、真实 `$max` 并发更新及新订单边界。管理后台与商家 Web 均按项目命令构建成功。未进行线上发布或线上浏览器验收。
