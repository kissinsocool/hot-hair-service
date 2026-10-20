# 已完成订单纠正契约

2026-10-20：定时任务完成订单不等于确认用户到店。允许商家将尚无评价或投诉的 completed 订单纠正为 canceled 或 no_show。历史数据没有自动/手动完成标识，因此对两种完成来源采用相同规则，不推测或回填历史来源。

## 已检索并确认的生产者和消费者

| 契约 | 生产者 | 生产消费者 |
| --- | --- | --- |
| PATCH /api/merchant/bookings/:id，action/reason 和既有订单响应 | merchant.js；完成来源为 merchant.js 和 services/auto-complete-bookings.js | merchant_app 的 OrderRepository.updateMerchantBookingStatus、MerchantOrdersScreen；小程序没有商家写入调用 |
| status/couponId/couponDiscountFen/payableAmountFen/review/complaint | merchant.js 事务、models.js；优惠券预占/核销来自 client-bookings.js、merchant.js、auto-complete-bookings.js | 三端订单读取：client-bookings.js GET 列表/详情、merchant.js GET 列表/summary、admin.js GET bookings；merchant_app BookingOrder、商家订单卡片、AdminBookingsView/calculateOrderAccounting、AdminOrdersSummaryScreen；hot_hair_mp utils/api.js、utils/orders.js、orders/order-detail 页面及优惠券列表 |
| 评价和投诉资格及并发 | client-bookings.js review/complaint 写入；admin.js 审核 | 小程序 orders、order-detail、profile；商家评价查看/回复；后台内容审核和公开店铺评价 |
| 状态通知/计数 | merchant.js、booking-messages.js；incrementNoShowCount | 小程序 messages/home/orders、bookingSocket；商家 BookingUpdateStream、订单列表和角标；用户策略/黑名单 |
| 金额统计和历史事件 | 当前 Booking 状态/优惠券字段；analytics.js 事件 | 后台 calculateOrderAccounting：no_show 必须与 canceled/rejected 一起扣除；AnalyticsEvent 为历史事件，保留曾发生的自动完成事件，不作为净成交金额 |

## 方案和边界

仅放开前端会被后端 409 拒绝；放开所有终态或删除评价会破坏用户记录。推荐在既有状态机上增加 completed→canceled/no_show 两条转换，保护已有评价/投诉，事务查询同时检查反馈字段以防用户并发提交。已完成仍不能接单、拒单或改期，也不能重复完成；客户端当前“已完成”选项不触发请求。

复用现有退券、移除优惠抵扣、爽约计数、时段释放、消息和 WS 流程。保留门店隔离和原状态条件，重复/并发纠正只能成功一次；失败时所有关联写入回滚。当前用户评价、投诉字段与子文档任一存在均保护，不能借审核标志回退绕过保护。

## 兼容、迁移、部署与回滚

不新增/删除请求或响应字段，无 Schema 变动、无数据迁移。旧 accepted 请求继续兼容；旧商家 UI 仍只对 accepted 提交操作；小程序继续消费已有 canceled/no_show 格式，无需同步发布。先发布后端兼容扩展，再发布商家及后台；没有删除旧兼容的收缩步骤。

回滚先恢复前端旧构建，再回退后端 Git 提交；已纠正的 canceled/no_show 记录和通知不回写，旧端仍可正常读取。后端必须通过本地明确提交→推送→线上干净工作树 Git 拉取部署，前端 OSS 发布前备份。验证使用旧商家 action/reason 实际结构，覆盖真实 Mongo 自动完成→纠正、优惠券/消息事务回滚、反馈保护、并发、隔离及三端读取；运行后端、小程序、Flutter 测试和两端 Web 构建。

## 验证记录

后端 `npm test` 161 项通过；本地 127.0.0.1 的 rs0 随机隔离数据库集成测试 20 项通过并清理测试库。使用现有线上 action/reason 结构验证自动完成后两种纠正、已接单未到店、门店隔离、并发重复、消息失败全事务回滚、退券、三次爽约拉黑、评价/投诉竞态、三端读取及通知。测试发现并修复原爽约计数管线缺少 Mongoose `updatePipeline: true` 的兼容问题，未改变计数规则。

小程序既有消费格式回归及全量测试 81 项通过，无生产代码修改；Flutter 92 项测试通过，静态分析无问题。线上验证只做部署、健康检查与资源一致性核对，不修改真实订单。
