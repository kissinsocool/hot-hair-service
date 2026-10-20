# 商家订单申诉契约

2026-10-20：已有评价或投诉的已完成订单保留完成状态，商家不能直接更改状态，改为提交“用户未到店”或“其他情况”的文字申诉。管理员查看并填写处理意见，商家查看处理结果。本轮不自动删除反馈、退券、变更订单或增加爽约次数。

## 跨端检索与调用方确认

| 数据/接口 | 生产者 | 消费者及兼容确认 |
| --- | --- | --- |
| 新增可选 Booking.merchantAppeal 子文档 | merchant.js POST /api/merchant/bookings/:id/appeal；admin.js PATCH /api/admin/booking-appeals/:id | merchant_app BookingOrder、OrderRepository、MerchantOrdersScreen；AdminRepository、AdminComplaintsPage 使用新增分页 GET /api/admin/booking-appeals |
| 完成状态、review/reviewed、complaint/complained | merchant.js、client-bookings.js、admin.js、auto-complete-bookings.js | merchant_app 商家订单、后台统计和审核；hot_hair_mp utils/api.js、utils/orders.js、orders/order-detail/profile；既有字段语义不变，已有反馈订单保持完成，原状态修改保护继续生效 |
| normalizeBookingPayload 普通客户端响应和实时事件 | booking.js、index.js normalizeBooking/normalizeMerchantBooking、既有 booking.updated | merchant_app、小程序 bookingSocket 和订单读取：仅商家 HTTP 响应含 merchantAppeal，普通客户端/公开读取不包含商家私有申诉；实时事件仍使用原有响应触发商家重新查询，不广播私有正文 |
| 原商家 PATCH action/reason、用户建单/评价/投诉、后台内容审核 | merchant.js、client-bookings.js、admin.js | OrderRepository.updateMerchantBookingStatus；hot_hair_mp confirm/orders/profile；AdminRepository.manageUserImage；全部旧请求照常可用，无新增必填字段 |

## 方案取舍

复用当前 Booking 文档和投诉管理页面，在投诉表下提供独立商家申诉表。复用投诉字段会混淆用户投诉与商家申诉；将全部订单拉到后台筛选会破坏现有按需分页，因此新增只读分页查询。申诉采用一单一份、pending→handled，重复/并发提交和重复处理由原子查询限制。门店身份来自登录会话，处理人来自管理员会话；类型与说明服务端校验。提交时同时检查完成状态和反馈存在。保留子文档反馈与布尔标志任一存在的判断，避免审核后标志变化绕过保护。

申诉提交/处理只写 merchantAppeal，不更新订单 updatedAt，避免后台按完成时间（兼容回退为 updatedAt）计算的金额月份发生移动。商家提交人及说明不进入普通用户响应。管理员处理意见不自动产生财务或用户账号副作用。

## 数据、发布、回滚

### 审核结果扩展（2026-10-20）

投诉管理改为“用户投诉／商家申诉”Tab。新增可选 merchantAppeal.decision：approved（审核通过）／rejected（未通过），由 admin.js PATCH /api/admin/booking-appeals/:id 写入；merchant_app AdminRepository/申诉处理表单为唯一生产调用方。消费者为后台申诉列表与 MerchantOrderAppealDialog，商家订单 HTTP 响应由 normalizeMerchantBooking 生产；普通客户端与 WebSocket 仍剔除整个 merchantAppeal，hot_hair_mp 无新字段依赖。已跨三个仓库检索确认，无其他生产调用方。

新后台必须选择结果，同时保留原必填 response。后端继续接受当前线上旧后台只有 response 的请求；decision 缺省时不推测结果，历史 handled 且无 decision 的记录显示“已处理”。decision 提供时仅接受 approved/rejected，非法值返回400；结果与说明在同一原子更新中保存，仍只有 pending 可以处理。审核结果仅记录结论，不自动改订单状态、财务或用户反馈。

本次验证：后端162项测试、本地隔离MongoDB24项集成测试、小程序81项测试、Flutter101项测试均通过，静态分析无问题。覆盖通过/未通过原子保存和读取、非法结果拒绝、旧response单字段请求继续成功，以及Tab切换、必选结果、失败重试保留所选结果与文字说明。

无存量迁移、无新必填后端字段。先发布兼容后端，再发布后台和商家端；回滚先客户端后后端，保留已有结果记录。后续若要求后端强制 decision，需先验证旧请求已停止使用，再单独收缩，不能本次立即拒绝旧格式。测试同时覆盖实际旧 response 请求、新结果的通过/未通过、非法输入、处理竞态、商家读取、客户端隔离、Tab切换及失败重试保留结果和说明。

新增可选子文档，历史无字段即未申诉，不做存量数据迁移或回填。请求 reason 为 no_show/other，description 必填且最多2000字；处理 response 必填且最多2000字。旧客户端不调用新接口，不要求同步更新小程序。

先发布后端兼容扩展，再发布商家端和管理后台；不删除旧接口或兼容格式。回滚先恢复前端旧构建，再回滚后端 Git 提交，保留已提交子文档，不批量重写订单。后端通过提交、推送、线上干净工作树 Git 拉取部署；前端各自备份并按已验证 OSS 流程发布。

## 验证

验证商家表单、必填/长度校验、成功刷新、失败重试、重复/并发提交、门店隔离、非完成/无反馈拒绝、普通客户端私有数据隔离、管理员鉴权、后台分页、处理结果回显及重复处理保护。真实本地 Mongo 集成测试使用当前线上客户端实际旧请求格式回归，检查评价、投诉、优惠券、订单状态、updatedAt 和爽约计数均不受申诉影响。运行后端/小程序/Flutter测试、静态分析和两端Web构建，线上只检查健康和资源，不操作真实订单。

本地验证：后端162项单元/契约测试、127.0.0.1本地rs0隔离数据库22项集成测试、小程序81项既有测试、Flutter97项测试通过。集成测试覆盖旧客户端请求、四种反馈存在形式、输入/归属校验、并发一单一申诉、分页、管理员并发处理、商家读取处理结果及客户端隐私隔离；真实Mongoose文档和普通对象均验证序列化时不向客户端或WebSocket泄漏申诉。提交前后对比完整订单，确认除申诉字段外无变更。
