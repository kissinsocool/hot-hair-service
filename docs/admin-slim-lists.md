# 管理后台轻量列表接口

目的：商家数增长后，后台不再为了订单表和套餐推广审核而拉取全量商家的完整信息。

## 契约

| 能力 | 生产者 | 消费者 | 兼容方式 |
| --- | --- | --- | --- |
| 商家列表不含评价文本 | `GET /api/admin/merchants` 及资质、内容、推广、推荐、上下架五个审核接口返回的 `merchant` | 管理后台（`merchant_app` 的 admin 功能）；小程序和商家端不调用 | `salon.reviews` 与 `salon.staff[].reviews` 保留为空数组，理发师 `rating`、`reviewCount` 照常返回。后台各版本均未读取过这里的评价 |
| 店铺联系信息 | 新增 `GET /api/admin/salon-contacts` | 后台概览的"全部订单""今日新订单"表 | 纯新增。分页与其他后台列表一致（`page`、`limit`、`X-Total-Count`），每项为 `salonId`、`name`、`phone`、`address` |
| 商家摘要列表 | `GET /api/admin/merchants?view=summary` | 后台"商家账号"页（待后台端切换） | 纯新增的可选参数；不带参数时响应不变。每项为账号字段、各审核状态与时间、`licenseUrl`，以及 `salon` 下的 `id`、`name`、`address`、`phone`、`tags`、`businessDistrict`、`isFeatured`。名称、地址、电话与完整信息一致，优先取待审核草稿 |
| 单个商家完整信息 | 新增 `GET /api/admin/merchants/:id` | 后台"商家账号"页查看店铺内容时 | 纯新增。返回 `{ merchant }`，结构与各审核接口返回的 `merchant` 相同；账号不存在返回 404 |
| 套餐推广申请 | 新增 `GET /api/admin/service-promotions` | 后台"套餐推广"页 | 纯新增。返回数组，每项为线上套餐字段（同 `servicePayload`）加 `merchantId`、`salonId`、`salonName`；只含推广状态为 pending、approved、rejected 的套餐 |

行为差异：

- 套餐推广页此前从商家列表里挑套餐，显示的是合并了待审核草稿后的内容；新接口显示线上套餐，即审核通过后实际被推广的内容。只存在于待审核草稿、尚未上线的套餐不再出现，这类套餐原本也无法审核（审核接口只查线上套餐）。
- 订单表里的店铺电话、地址此前可能取自待审核草稿，现在取线上值。

## 发布与回滚

无数据迁移。先发布后端，再发布管理后台；旧版后台继续使用 `GET /api/admin/merchants`，不受影响。回滚时先回滚后台，再回滚后端：新版后台依赖两个新接口，不能只回滚后端。

## 尚未处理

"商家账号"页的后台端尚未切换到摘要列表：它仍拉取全部商家的完整信息。切换后列表改用 `view=summary`，搜索与筛选继续在浏览器内对摘要进行，只有查看店铺内容时读取单个商家的完整信息。
