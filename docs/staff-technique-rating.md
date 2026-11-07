# 理发师技术评分

理发师 `rating` 为已审核通过评价中有效 `review.ratings.technique`（技术·完成效果）的平均数，保留两位小数。缺失技术分的历史评价不计入分母；没有有效技术分时返回 `null`。待审评价、驳回评价及 `pendingEdit` 不参与评分。`reviewCount` 仍表示全部已审核通过评价数。

店铺 `rating` 继续使用 `review.rating` 的综合平均分，评价本身的综合分、评价列表筛选口径保持不变。同一次 MongoDB 聚合分别统计综合分与技术分，不新增数据库查询。

## 生产者与消费者

- 后端：`getApprovedRatingSummariesByStaffIds` 同时提供综合分和内部 `techniqueRating`；`buildStaffPayload`、`buildPublicStaffSummary` 将技术分输出为理发师 `rating`。店铺汇总仍只使用综合分总和。
- 公共接口：店铺详情中的 `staff[]`、理发师详情；商家店铺资料与管理端商家资料的理发师数据共用上述构造函数。
- 小程序：`pages/detail/detail.js` 展示店铺综合分和理发师列表；`pages/staff/staff.js` 使用 `ratingDisplay` 展示理发师评分；`pages/booking/booking.js` 消费同一店铺理发师资料。现有展示支持 `rating: null`，不需要字段适配。
- 商家/管理 Flutter 端：`merchant_app/lib` 未找到重新计算理发师评分的逻辑；商家评价列表和订单评价展示仍读取评价本身的综合分，不变。

## 发布与回滚

仅改变理发师评分语义，无字段增删、无数据回写或迁移。后端可独立发布，各端继续接收原结构；店铺详情缓存为进程内短缓存，发布重启后重新计算。回滚时通过 Git 还原本次修改并重启后端，原始评分数据不变。小程序尚未上线（用户已确认）。

## 验证

真实 MongoDB 集成用例使用综合分 4.5、4.75、5，其中前两条技术分为 3、4，验证店铺分为 4.75、理发师分为 3.5、评价总数均为 3。验证公共详情、店铺理发师列表、商家资料一致，以及历史无维度评价返回空技术评分；保留分页、两位小数、待审内容隔离的接口回归。
