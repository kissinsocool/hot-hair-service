# 套餐折扣与价格展示

## 字段与语义

- `services[].priceFen` 始终是实际售价（分），预约、报价校验、支付和订单快照继续使用该字段，不再次打折。
- 新增可选的 `services[].originalPriceFen`：商家输入的原价（非负整数，单位分），独立保存，不从售价反算。
- `services[].discountTenths`：整数 1–100，代表 0.1–10.0 折；缺省或 null 表示不打折。新商家端提交 `priceFen = round(originalPriceFen * (discountTenths ?? 100) / 100)`，四舍五入到分。
- 原价 280、9.0 折保存为 originalPriceFen=28000、discountTenths=90、priceFen=25200。小程序显示 -10%、¥252、划线原价 ¥280。
- 商家端输入框明确标注“原价”。清除折扣后售价恢复为原价；重复编辑/保存从独立原价计算，不累计打折。
- 只有存在独立原价且确有降价时才显示折扣和划线原价。旧数据没有原价时只显示已保存的售价，避免反算虚构原价。
- 价格符号使用 ¥；标签为“原价”；不展示 JP 或含税。

## 跨端生产者与消费者（实施前检索确认）

| 端 | 生产者/消费者 | 处理 |
| --- | --- | --- |
| merchant_app | MerchantSalonScreen 的 `_services` 加载、编辑、保存与 MerchantSalonRepository 的 GET/PATCH `/merchant/salon` | 输入独立原价和一位小数折扣，发送原价、折扣及计算后的售价；清除折扣发送 null |
| hot_hair_service | merchant 路由校验，Salon 和 pendingContent 内的 serviceSchema | 原价可选，校验金额及折扣一致性，旧请求继续通过 |
| hot_hair_service | serviceForStorage/servicePayload、applyDirectSalonContent、buildContentDraft、applyPendingContent | 覆盖即时更新、待审核草稿、审核通过、商家响应、公共详情、理发师 salonServices 的存储和输出；旧请求未改变售价时省略保留；改变售价与原价/折扣不一致时清除旧展示元数据，保留实际售价 |
| hot_hair_service | 后台套餐推广审核、public promoted-services 图片推荐 | 只操作推广字段或图片，不改变折扣语义 |
| hot_hair_service | 种子/旧格式迁移、旧 fixtures | 不要求新增字段，旧数据保持缺省，无需补造原价 |
| hot_hair_service | client-bookings 报价、预约、订单快照 | 仍只取 priceFen，不对现有售价再打折 |
| hot_hair_mp | 店铺热门套餐、动态关联套餐、首页经典套餐推荐 | 共用 service-price 展示售价、折扣、划线原价 |
| hot_hair_mp | 理发师、预约页、确认页、订单 | 忽略新增展示字段，保留原有交易逻辑 |
| merchant_app | 后台与订单页面 | Map 读取，不增加折扣必填规则，不改变订单金额 |

## 兼容、部署与回滚

1. 先部署后端：原价字段可选，旧版商家只传 priceFen 仍有效。未修改售价时保留原价；旧客户端漏传或回传旧原价后修改售价，若已不满足原价/折扣关系，保留售价并清除过期原价与折扣元数据。新原价与售价不一致的请求拒绝。旧版预约请求无需原价或折扣字段。
2. 更新商家端，再更新小程序。新商家端读取没有独立原价的套餐时，将输入框中的已有价格作为待确认原价，计算折后价；保存才提交修改。因此此前误将原价280存成售价280的9折套餐，需要在新版商家端确认原价与折扣后重新保存，之后保存 originalPriceFen=28000、priceFen=25200。
3. 不批量重算线上历史数据：无法仅凭旧 priceFen 判断它原本是实际售价还是误填的原价，自动重算会改变商家的实际收费。通过商家确认保存逐条迁移。历史订单快照不改，新预约继续按服务当前售价计费，价格变动由现有确认机制提示。
4. 回滚客户端时，已保存的 priceFen 仍为正确售价。旧商家端编辑时“价格”仍按售价解释，不能把回滚客户端当作原价编辑器使用。若后端也需回滚，先停用新版原价编辑入口、备份原价数据；旧后端可能丢弃原价字段，但实际售价不变。
5. 不新增必填、不删除旧兼容；未设置折扣的旧套餐金额不变。

## 验证

- `src/routes/service-discount.test.js`：使用真实 Mongoose 子文档验证旧套餐 PATCH、设置/省略/清除折扣、边界拒绝、公共 payload 与审核草稿。
- `src/routes/joint-contracts.test.js`：旧版预约实际请求结构及结算兼容。
- 小程序 `tests/service-price.test.js`：原价280/9折显示252与280、旧套餐不反算、零价、清除与组件更新。
- 商家端 `test/service_discount_test.dart`：一位小数解析、分位舍入与重复保存，`test/widget_test.dart`：实际输入280/9折、保存252、原价回显280及清除恢复280。
- 本地验证结果见本次交付；未进行线上发布或微信真机验收。
