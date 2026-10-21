# 套餐折扣与价格展示

## 字段与语义

- `services[].priceFen` 仍是实际售价（分），预约、报价校验、支付和订单快照的语义不变。
- 新增可选的 `services[].discountTenths`：整数 1–100，代表 0.1–10.0 折；例如商家输入 6.5 折，提交 65，小程序显示 -35%。缺省表示未设置；显式 null 清除；旧客户端省略时保留该套餐已有值。
- 售价大于零且折扣小于 10.0 折时显示折扣和划线原价。原价为 `round(priceFen * 100 / discountTenths)`，精确到分。零价、无折扣、10.0 折只显示售价。原价是展示值，不参与交易，舍入可能导致反算结果存在不足一分钱的误差。
- 价格符号使用 ¥；标签为“原价”；不展示 JP 或含税。

## 跨端生产者与消费者（实施前检索确认）

| 端 | 生产者/消费者 | 处理 |
| --- | --- | --- |
| merchant_app | MerchantSalonScreen 的 `_services` 加载、编辑、保存与 MerchantSalonRepository 的 GET/PATCH `/merchant/salon` | 增加一位小数折扣输入；仍发送原有售价，空值发送 null |
| hot_hair_service | merchant 路由校验，Salon 和 pendingContent 内的 serviceSchema | 可选字段与边界校验，旧请求继续通过 |
| hot_hair_service | serviceForStorage/servicePayload、applyDirectSalonContent、buildContentDraft、applyPendingContent | 覆盖即时更新、待审核草稿、审核通过、商家响应、公共详情、理发师 salonServices 的存储和输出；旧请求省略保留 |
| hot_hair_service | 后台套餐推广审核、public promoted-services 图片推荐 | 只操作推广字段或图片，不改变折扣语义 |
| hot_hair_service | 种子/旧格式迁移、旧 fixtures | 不要求新增字段，旧数据保持缺省，无需补造原价 |
| hot_hair_service | client-bookings 报价、预约、订单快照 | 仍只取 priceFen，不对现有售价再打折 |
| hot_hair_mp | 店铺热门套餐、动态关联套餐、首页经典套餐推荐 | 共用 service-price 展示售价、折扣、划线原价 |
| hot_hair_mp | 理发师、预约页、确认页、订单 | 忽略新增展示字段，保留原有交易逻辑 |
| merchant_app | 后台与订单页面 | Map 读取，不增加折扣必填规则，不改变订单金额 |

## 兼容、部署与回滚

1. 先部署后端，允许缺省/null/合法整数，并验证旧版商家实际套餐结构与旧版预约请求继续通过。
2. 更新商家端后再更新小程序（两客户端顺序互换也兼容）；旧套餐仍只显示售价，商家设置后显示折扣。
3. 无数据库迁移，不删除旧字段、不改 priceFen。无需收缩兼容层。
4. 回滚任一客户端不影响结算；后端保留可选字段兼容。若必须回滚后端到不认识折扣的版本，先回滚商家编辑入口，期间避免编辑套餐，否则旧后端的规范化可能丢弃新增展示字段。回滚后端前备份套餐数据。

## 验证

- `src/routes/service-discount.test.js`：使用真实 Mongoose 子文档验证旧套餐 PATCH、设置/省略/清除折扣、边界拒绝、公共 payload 与审核草稿。
- `src/routes/joint-contracts.test.js`：旧版预约实际请求结构及结算兼容。
- 小程序 `tests/service-price.test.js`：折扣、原价分位舍入、旧套餐、零价、清除与组件更新。
- 商家端 `test/service_discount_test.dart`：一位小数解析与范围校验，`test/widget_test.dart`：现有套餐编辑与保存链路。
- 本地验证结果见本次交付；未进行线上发布或微信真机验收。
