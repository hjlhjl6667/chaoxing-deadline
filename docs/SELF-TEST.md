# 首次使用自测清单

> **为什么需要这份清单**：脚本里的 ICS 生成、时间解析、转义、折行等纯逻辑都有自动化测试覆盖（`node test/ics.test.mjs`，67 项断言）。但**接口部分无法离线验证**——它依赖你的账号、你的学校、你的课程数据，只能在你自己的浏览器里跑一遍才算数。
>
> 下面的步骤按顺序走，每步都写了「预期」和「失败怎么办」。全程约 3 分钟。

---

## 第 1 步 · 纯逻辑先跑通（不需要登录）

```bash
node test/ics.test.mjs
```

**预期**：`✓ 全部 67 项断言通过`

**失败**：说明脚本源码被改坏了，或 Node 版本过低（需 ≥ 18，因为用了 `TextEncoder`）。

---

## 第 2 步 · 日历效果先看（不需要登录）

把 `examples/demo.ics` 导入手机或电脑日历。

**预期**：出现 5 个事件，标题形如 `[数据结构] 实验二：二叉树遍历与哈夫曼编码`，每个事件带 3 个闹钟（提前 3 天 / 1 天 / 2 小时）。点开事件能看到「课程 / 类型 / 截止 / 直达链接」。

**失败**：
- 日历打不开 → 文件可能被文本编辑器改过换行符，重新 `node tools/gen-demo.mjs` 生成
- 能打开但没有闹钟 → 部分安卓日历 App 导入时会丢弃 VALARM，换用系统自带日历或 Google Calendar 验证

> 这一步过了，说明「导出 → 导入 → 提醒」这条链路是通的。后面就是在验证数据抓得对不对。

---

## 第 3 步 · 脚本能起来

装好脚本后打开 <https://i.chaoxing.com>（确认已登录）。

**预期**：右下角出现蓝色 📅 圆形按钮，不遮挡页面其他元素。控制台无红色报错。

**失败**：
- 无按钮 → 检查 Tampermonkey 里脚本是否启用；在非 `chaoxing.com` 域名下脚本不会运行
- 控制台报 `GM_xmlhttpRequest is not defined` → 用的脚本管理器权限不足，换 Tampermonkey

---

## 第 4 步 · 课程列表能取到

在控制台执行：

```js
await window.__CXD__.API.courses()
```

**预期**：返回数组，元素形如

```js
{ courseId: '262350078', classId: '143971539', cpi: '354331126',
  name: '形势与政策', teacher: '张三', isretire: false, endDate: '2028-03-30 12:58' }
```

数量应与你学习通里实际课程数一致。

**失败**：
- 抛「未获取到课程列表，请确认已登录学习通」→ 登录态失效，重新登录
- 返回空数组 → 打开 F12 → Network → 手动访问 `https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1`，看返回的 JSON 结构是否和 [`docs/API.md`](API.md) 一致

---

## 第 5 步 · 单门课的令牌能提到（最易失败的一步）

```js
const c = (await window.__CXD__.API.courses())[0]
await window.__CXD__.API.courseTokens(c)
```

**预期**：`{ enc: '32位hex', stuenc: '32位hex' }`

**失败**：
- 抛「未能提取 workEnc」→ 平台课程页结构变了。手动访问
  `https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid={courseId}&clazzid={classId}&vc=1&cpi={cpi}&ismooc2=1&v=2`，
  F12 搜 `workEnc`，看它现在长什么样，然后补一条正则到 `API._pickEnc` 的候选列表里
- `stuenc` 是空字符串 → 部分账号/学校不返回该参数。脚本会省略它继续请求，若因此「无权限」，说明你的环境确实需要它

---

## 第 6 步 · 作业列表解析正确（关键校验）

```js
const c = (await window.__CXD__.API.courses())[0]
const items = await window.__CXD__.API.allWorks(c)
console.table(items.map(i => ({ 标题: i.title, 状态: i.status, 分类: i.category,
  截止: i.deadline && new Date(i.deadline).toLocaleString(), 过期: i.expired })))
```

**预期**：
- 条目数与该课程实际作业数一致（含分页）
- `标题` 不是「（无标题作业）」
- 未交作业的 `截止` 是未来时间，且与你印象中的截止时间对得上（允许秒级误差）
- 已过期作业 `过期` 为 `true`

**失败**：
- 条目数为 0 → 作业列表页可能需要 `stuenc`，或接口返回了「无权限」HTML。在 Network 里看那条 `work/list` 请求的响应内容
- 标题全是「（无标题作业）」→ `.overHidden2` 选择器失效，打开 `li[data]` 的 innerHTML 看新的 class 名
- 截止时间差了几小时 → 检查时区；脚本按浏览器本地时区换算，`.ics` 里写的是 UTC
- 分页只抓到第一页 → 看 `#page` 区域结构是否变了

---

## 第 7 步 · 全量扫描 + 导出

点 📅 → **刷新**，等扫描完成 → 点 **导出日历**。

**预期**：
- 面板按剩余时间升序排列，24h 内标红、72h 内标橙
- 顶部三个数字（24h 内 / 72h 内 / 全部待办）合理
- 下载到 `学习通截止提醒-YYYYMMDD.ics`
- 导入手机后，日程与面板上的条目一一对应

**失败**：
- 部分课程没扫到 → 面板顶部会出现黄色警告条，写明哪门课失败、原因。可以单门课用第 6 步的代码复现
- 导出后事件数比面板少 → 正常。**没有截止时间的条目不会被导出**（日历事件必须有时间）

---

## 第 8 步 · 风控观察

扫描完成后正常使用学习通 10 分钟，观察是否被要求输入验证码。

**若触发了**：
1. 立即停止使用本脚本至少 24 小时
2. 在设置里打开「跳过已结课」，减少请求量
3. 确认没有在短时间内反复点「刷新」（结果有 5 分钟缓存，正常刷新不会重复请求）

这是自动化抓取固有的风险，脚本只能降低概率，不能消除。README 里对此有完整声明。

---

## 报问题时请附上

```js
// 在控制台执行，把输出贴到 issue 里
JSON.stringify({
  脚本版本: '1.0.0',
  课程数: (await window.__CXD__.API.courses()).length,
  警告: window.__CXD__.state.warnings,
  条目数: window.__CXD__.state.items.length,
  首条: window.__CXD__.state.items[0],
}, null, 2)
```

**不要贴** Cookie、`stuenc`、`enc`、真实姓名学号——这些等同于你的登录凭证。
