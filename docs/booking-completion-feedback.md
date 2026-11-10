# 订单完成来源与用户异议契约

## 范围与方案

保留现有按服务时长自动完成、优惠券核销和评价资格。新增可选 completionSource（merchant/automatic）和 completedAt；历史订单不推测或回填来源。复用 complaint 提交问题类型与描述，新增独立后台投诉查询和处理接口，处理结果通过订单详情和持久消息反馈。商家现有无反馈订单纠错、已有反馈订单申诉规则不变。本轮不添加到店码、支付或反刷单策略。

只提醒而不自动完成会重新引入遗忘订单；新增独立异议系统会重复投诉和审核流程。采用现有投诉子文档，不改既有终态和财务计算规则。后台处理意见不自动更改订单、优惠券、评价或爽约计数。

## 已检索的生产者和消费者

| 字段或接口 | 生产者 | 消费者与兼容确认 |
| --- | --- | --- |
| Booking.completionSource/completedAt | src/routes/merchant.js 的旧 complete 请求；src/services/auto-complete-bookings.js 定时事务 | src/services/booking.js 的 normalizeBookingPayload、订单 HTTP 和 WS；hot_hair_mp utils/orders.js、orders/order-detail；merchant_app BookingOrder、MerchantOrdersScreen，后台订单和 calculateOrderAccounting 已读取 completedAt。字段可选，历史来源显示不详，不影响旧客户端解析 |
| 完成通知与订单详情入口 | booking-messages.js、两种完成流程的 userMessage | hot_hair_mp messages 页面、home/messages 计数、bookingSocket；既有持久消息与未读机制不变 |
| complaint.reason（可选，not_arrived/service_incomplete/other） | client-bookings.js POST /bookings/:id/complaint；hot_hair_mp review-editor | 小程序订单详情、管理员投诉页。旧 description/imageObjects 请求不含 reason 继续接受，缺省 other；既有描述、图片和归属/状态校验保留 |
| complaint.status/response/handledAt | 新 PATCH /admin/complaints/:id，只写处理字段；status 从 submitted 扩展到 handled | hot_hair_mp utils/orders.js/order-detail 展示处理结果；merchant_app 管理后台。普通商家仍可读取其订单投诉；无新必填旧字段 |
| GET /admin/complaints 分页结果 | admin.js，独立查询全部投诉，包括已处理记录 | AdminRepository.fetchUserComplaints、AdminComplaintsPage；原 user-images 接口和审核规则保持兼容，避免已审核投诉消失 |
| PATCH /admin/complaints/:id 的 response | AdminRepository.handleUserComplaint、后台处理对话框 | admin.js 管理员鉴权路由，事务内写入结论及 BookingMessage；并发只处理一次，写消息失败全部回滚，不改订单 updatedAt，避免移动历史记账月份 |
| complaint_handled 消息 | admin.js | booking-messages 通用列表、小程序消息跳转，旧客户端仍显示 userMessage |

其他关联调用方：小程序 confirm 保留建单结构、profile 评价和公开店铺评分不变；merchant_app OrderRepository 原 action/reason、AdminBookingsView/calculateOrderAccounting、商家申诉和后台内容审核不变。已检查三个仓库，新增交互仅使用上述调用点，不新增任何旧接口必填字段。

## 发布、迁移、回滚

先发布兼容后端，再发布小程序、商家和后台。无需存量迁移；旧订单 completedAt 缺省仍沿用既有统计回退，不做回填。新增 completedAt 取原完成操作时间，处理投诉不改变该时间或 updatedAt。不在本次收缩旧格式。

回滚先前端后后端，保留已写字段和消息，不批量回写订单；旧版本忽略新增字段。后台上线前不能假设旧后端支持新接口。部署遵守各仓库 Git 和物理网卡绑定流程，本轮仅本地实现验证，不部署。

## 验证计划

两种完成来源、准确时间、历史缺省；旧 complete/action 和 complaint 请求；真实 Mongoose 子文档；用户归属与非法问题类型；管理员处理和重复/并发、持久通知失败回滚；投诉后商家更正仍被保护；金额、评价、优惠券和 updatedAt 不变；三端字段解析和历史兼容、提交失败重试、通知跳转详情、处理结果回显。运行后端、小程序、Flutter 测试/分析及两个 Web 构建；Mongo 集成只使用本机随机隔离库。

## 本地验证结果（2026-11-05）

- 后端 `npm test`：208项通过。
- `TEST_MONGODB_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0 npm run test:integration`：36项通过，随机隔离测试库已清理；测试服务仅监听127.0.0.1。集成测试对本进程使用现有仅测试环境可用的限流绕过，生产限流代码不变。
- 小程序 `node --test tests/*.test.js`：113项通过，覆盖消息跳转、三种问题类型、处理结果展示、完成来源及旧字段兼容。
- Flutter `flutter test`：126项通过；`flutter analyze`无问题；商家和后台按AGENTS规定参数的Web构建均成功。
- 并发回归：持久消息写入失败回滚；重复管理员处理仅一次成功；投诉内容审核只写审核子字段，不覆盖并发处理结果；已处理投诉不可被旧提交请求覆盖。
- 保留小程序原有未提交工作。未连接线上服务器、未部署，也未运行微信开发者工具或真机交互验证。

### 用户端展示调整（2026-11-05）

订单详情只展示订单状态，不展示系统自动完成或商家确认完成的来源及对应附加行。小程序移除来源和完成时间的展示格式化字段；后端来源/时间记录、商家和管理端展示、用户评价和问题反馈流程保留。此项仅为展示调整，无接口或Schema变更。

### 未到店判定异议

| 契约 | 生产者与消费者 |
| --- | --- |
| 现有 POST /bookings/:id/complaint | 小程序订单详情和反馈编辑页对 `no_show` 提交 `reason: no_show_dispute`。后端仍校验订单归属、描述和图片，只接受一次。已完成订单继续接受旧小程序和 Flutter 用户端的 `description/imageObjects`，省略 reason 时仍为 other。 |
| complaint.reason 和可选 complaint.decision | 后端订单详情、订单列表及管理后台投诉列表输出。小程序展示处理结果，管理后台区分爽约异议。旧小程序和商家端仍能读取订单，原商家更新请求和商家申诉不涉及这两个字段。 |
| 现有 PATCH /admin/complaints/:id | Flutter 管理后台对爽约异议提交 `response` 和 `decision: approved/rejected`。普通投诉继续只提交 response。后端事务内记录处理结果，撤销时扣回一次计次并按三次阈值重算限制，同时写入既有类型的站内消息。 |
| 图片审核和订单状态 | 原订单状态作为历史记录保留，订单详情和列表显示「爽约已撤销」。后台图片审核可驳回图片，爽约异议及其处理记录保留。商家订单操作、统计、优惠券和时段沿用历史订单状态。 |

已有未到店订单可以反馈，无需回填。发布顺序为后端、管理后台、小程序。回滚时先关闭小程序入口，保留新版后端与后台处理已受理的异议。已撤销的计次和处理记录持续有效，不做数据回写。如果后端必须回退到旧实现，暂停对异议记录的后台处理和图片删除，待兼容版本恢复后继续处理。
