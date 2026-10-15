# 三端优化契约与发布顺序

范围：2026-10-15 联合审查清单1～6、8、9；不修改第7项恢复登录网络错误处理。

## 调用方确认

| 能力 | 生产者 | 全部生产调用方/消费者 | 兼容方式 |
| --- | --- | --- | --- |
| 会话注销 | 后端三角色现有POST注销路由 | 小程序account/API；Flutter MerchantAuthRepository（商家和后台）；WS会话撤销 | 请求体/响应不变，客户端开始使用现有接口；旧客户端照常工作 |
| 预约价格确认 | 后端POST /api/bookings | 小程序confirm（唯一产品建单方）；scripts/k6-booking-flow.js（旧请求压测方）；两客户端订单展示、后台与WS消费既有订单响应 | 新增可选expectedOriginalAmountFen/expectedPayableAmountFen；提供时校验；不提供仍沿用旧请求。价格变化409兼容新增code/quote，未建单且事务回滚；订单成功响应字段不变 |
| 商家改期时段 | 新增GET /api/merchant/bookings/:id/slots | Flutter OrderRepository改期；公共slots仍被小程序booking和旧商家调用 | 新路由按鉴权归属、历史时长、排除自身占用计算；原公共接口保持兼容 |
| 改期消息 | 后端商家改期事务/BookingMessage | 小程序messages、orders、首页未读计数；Flutter改期成功文案；WS消费者 | 使用现有消息字段，新增type=reschedule；status仍是订单真实状态，userMessage说明改期，无Schema迁移 |
| 商家订单分页/筛选 | 既有GET /api/merchant/bookings；新增summary读取 | Flutter OrderRepository/订单页；旧商家、测试及脚本仍使用现有date/status/page/limit | 新增可选fromDate/toDate（左闭右开）、includePending、staffId、statuses；原参数语义不变。summary按同样范围聚合计数，旧调用不受影响 |
| 图片 | 后端privateImageUrl；两端图片URL helper | 小程序profile/api/评价预览；Flutter商家图片卡片及后台图片组件 | 签名URL字节保留，多图统一600秒；仅受控公共域名无query图生成OSS缩略图，原URL存储/编辑/预览不变 |
| 实时刷新 | 后端既有authenticated及booking.*事件 | 小程序bookingSocket与home/orders/messages；FlutterBookingUpdateStream、订单页、门店通知、主页角标 | 不变更WS格式；客户端增加身份绑定、重连后快照同步和刷新合并 |

测试/替身：后端index.test.js、merchant-reschedule及契约测试；小程序确认页/图片/API/分页/socket测试；Flutter仓库、socket与订单widget测试随调用签名一并更新。金额仍以后端真实服务/优惠券计算为准，期望金额不被信任为订单金额。

## 方案取舍

推荐复用现有HTTP、Mongo事务、WS和OSS图片处理。只在客户端重算价格无法避免提交期间改价；直接新增必填报价会拒绝旧线上请求，故采用可选期望金额扩展。改期仅传serviceId无法保证历史时长或排除自身，因此使用按订单鉴权的新增接口。逐事件全历史读取改为按范围/状态分页并合并刷新，不引入缓存服务。

## 数据、部署与回滚

无存量数据迁移，无字段删除。先发布后端兼容新增能力，再发布商家端/后台和小程序。旧格式客户端继续接受，其价格变动重确认保护要等客户端升级才生效；未来如要强制报价，需先验证线上旧格式已停止使用，再单独收缩。

回滚先回滚客户端到旧请求，再回滚后端；新客户端依赖新改期/summary路由，不能只回滚后端。回滚不删除已写入的改期消息。代码须按各仓库Git流程发布，不直接覆盖线上文件。

## 验证要求

使用旧客户端实际建单结构验证不带期望金额仍可建单；使用新结构验证改价409不落单/不占券、确认新价格后正常建单。验证角色注销、不同账号WS隔离、多图签名、改期自身排除/长服务冲突/消息事务、日期范围与跨日待接单、分页及合并刷新。运行后端/小程序/Flutter测试、Flutter分析及商家和后台Web构建。真实Mongo集成测试仅使用已确认独立测试实例；线上或非本地数据库不作为自动测试默认目标。

## 本地验证记录

- 后端 `npm test`：145项通过。
- 小程序 `node --test tests/*.test.js`：65项通过，包含工作树原有首页/详情/socket修改。
- Flutter `flutter test --no-pub`：66项通过；`flutter analyze --no-pub` 无问题。
- 隔离本地 MongoDB 8.0 副本集：`npm run test:integration` 两套测试、8项通过。数据库绑定127.0.0.1，随机测试库已删除、实例已关闭，没有连接线上数据库。
- 集成测试确认：旧请求兼容；期望金额不符时订单、占用、优惠券、用户策略和门店并发标记全部回滚；价格降低使优惠券不再达标时返回新报价；消息写入失败时改期回滚；历史时长与排除自身生效；新读取接口门店隔离；三角色HTTP注销、旧WS关闭。
- 商家Web构建和管理后台Web构建均通过，base href分别为 `/merchant-app/` 和 `/admin-app/`。
- 会话回归额外覆盖修改密码后的连接换令牌、A退出/B登录、迟到注销响应不能清B凭据。本地退出不等待远程注销响应；网络不可用时服务端撤销仍依赖请求送达和会话到期。
- 第7项 `restoreSession()` 的网络错误处理保持原样；未改变该行为。

验证记录截至发布前；未运行线上压测、未验证微信真机或线上OSS缩略图配置。日志保存在 `/tmp/hot-hair-opt-*.log`。发布时仍须按“后端先、客户端后”执行。
