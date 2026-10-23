# 评价有用反馈契约

## 生产者与消费者

实施前检索三端：评价由 `src/routes/client-bookings.js` 提交、编辑、删除，由 `src/routes/admin.js` 审核；公开评价由 `src/routes/public.js` 店铺详情与分页接口生产，小程序 `pages/detail/detail.js`、`pages/salon-reviews/salon-reviews.js` 消费。商家端 `merchant_app/lib/features/booking/data/order_repository.dart` 使用商家回复接口、订单页面读取订单评价，不消费新增反馈字段或接口，无需修改。其他理发师详情和个人评价页面不增加反馈按钮。

新增登录接口 `POST /api/bookings/:id/review/helpful`，请求 `{ reviewId }`；用户身份仅由现有微信登录令牌确定。仅允许对仍公开且审核通过的评价提交，过期评价返回404。成功返回 `{ bookingId, reviewId, helpfulCount, helpful: true }`。

店铺详情 `reviews[]` 与评价分页 `items[]` 兼容新增 `helpfulCount`（全量人数）和 `helpful`（当前登录用户是否已反馈）；匿名或失效令牌仅返回公共状态，不阻断浏览。返回用户状态的响应使用 `private, no-store`；详情公共缓存中的对象不写入个人状态。用户ID和反馈用户列表不返回客户端。

新增 ReviewHelpful 集合，以 `(bookingId, reviewId, userId)` 唯一索引保证重复点击、重试、并发请求幂等；按该评价统计人数。评价编辑保留ID时反馈继续保留，删除后重建的不同ID评价独立统计。仅使用已发布评价，不公开待审版本。

## 发布与回滚

兼容新增，不修改旧请求必填项或旧字段含义，无历史数据回填，旧评价初始反馈为0。先发布后端并建立新集合唯一索引、验证登录反馈和旧客户端详情请求，再发布小程序。回滚先回退小程序，后端新增字段/接口和集合可保留；如需回退后端，保留集合以便恢复，不能删除用户反馈。商家端及后台无需发版。

## 验证

- 后端 `npm test`：157 项通过；小程序 `node --test tests/*.test.js`：75 项通过。
- 隔离本地 MongoDB 副本集运行 `npm run test:integration`：2 套、11 项通过。新增用例验证6个并发重复提交只计1人、第二个用户计2人、已登录/匿名/失效令牌状态隔离、缓存外读取、下线/待审/已替换评价不可反馈、重建评价不沿用旧人数，并继续验证旧详情请求及分页契约。
- 前端覆盖成功前不显示已反馈、失败保留原人数并可重试、重复点击合并、分页或刷新后按评价身份更新、页面卸载后停止更新；详情页及评价页均使用同一个反馈处理函数。
- 微信 WXML/WXSS 原生编译通过。Flutter 端无改动且消费契约不变，未重复构建。尚未部署线上或进行微信真机验收。
