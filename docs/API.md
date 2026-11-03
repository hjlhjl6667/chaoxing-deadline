# 学习通接口速查

本项目用到的全部接口。学习通没有公开 API，以下内容来自对网页端行为的观察与社区逆向资料整理，**随时可能因平台改版而失效**。

所有请求都依赖浏览器里已有的登录 Cookie，脚本不处理登录。

| 参数 | 含义 | 来源 |
|---|---|---|
| `courseId` | 课程 ID | 课程列表接口 |
| `classId` | 班级 ID（教学班） | 课程列表接口 |
| `cpi` | 课程-人-角色索引 | 课程列表接口 |
| `workEnc` | 每门课独立的作业加密令牌，32 位 hex | 课程中间页 HTML |
| `stuenc` | 作业列表的伴随令牌，32 位 hex | 课程中间页 HTML |
| `workId` | 作业 ID | 作业列表条目 `data` 属性里的 URL |

---

## 1. 课程列表

```
GET https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1
```

返回 JSON：

```json
{
  "result": 1,
  "channelList": [
    {
      "content": {
        "id": 143971539,          // classId
        "cpi": 354331126,         // cpi
        "isretire": 0,            // 0 正常 / -1 已结课 / 1 已归档
        "endDate": "2028-03-30 12:58",
        "course": {
          "data": [
            { "id": 262350078, "name": "形势与政策", "teacherfactor": "张三" }
          ]
        }
      }
    }
  ]
}
```

> 同一门课可能出现在多个频道里，需要按 `courseId + classId` 去重。

---

## 2. 课程令牌（workEnc / stuenc）

```
GET https://mooc1.chaoxing.com/visit/stucoursemiddle
    ?courseid={courseId}&clazzid={classId}&vc=1&cpi={cpi}&ismooc2=1&v=2
```

服务端 302 到 `mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?enc=...`，最终 HTML 里藏着作业令牌。

提取方式（本项目按顺序尝试，任一命中即可）：

```js
/id=["']workEnc["'][^>]*value=["']([a-f0-9]{32})["']/i
/value=["']([a-f0-9]{32})["'][^>]*id=["']workEnc["']/i
/workEnc\s*[:=]\s*["']([a-f0-9]{32})["']/i
/enc=([a-f0-9]{32})/i                       // 兜底
```

`stuenc` 同理，`/[?&]stuenc=([a-f0-9]{32})/i` 等。

---

## 3. 作业列表

```
GET https://mooc1.chaoxing.com/mooc-ans/mooc2/work/list
    ?courseId={courseId}&classId={classId}&cpi={cpi}
    &ut=s&enc={workEnc}&t={timestamp}&stuenc={stuenc}
    &isdisplaytable=2&pageNum={n}
```

> ⚠️ **只传 `enc` 会返回「无权限」**。必须同时带 `t`（毫秒时间戳）和 `stuenc`。这是最容易踩的坑，多数文档漏写。
>
> 也有资料说路径是 `mooc1.chaoxing.com/mooc2/work/list`（不带 `mooc-ans`），若 `mooc-ans` 路径 404 可尝试回退。

### 条目结构

```html
<li data="https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?...&workId=123&answerId=456">
  <div class="tag icon-zy"></div>        <!-- 普通作业 -->
  <div class="tag icon-hp-gy"></div>     <!-- 互评作业 -->
  <div class="right-content">
    <p class="overHidden2 fl">作业标题</p>
    <p class="status fl">未交</p>
    <i class="label fl">互评</i>
  </div>
  <div class="time notOver">
    <img src="...endTime.png">剩余90小时37分钟
  </div>
</li>
```

| 选择器 | 含义 |
|---|---|
| `li[data]` 的 `data` | 作业详情页直链（含 `workId`、`answerId`、独立 `enc`） |
| `.overHidden2` | 标题（兜底：`.right-content p` 第一个、`aria-label` 按 `;` 切分） |
| `.status` | 状态文本，繁简混用 |
| `.time` | 剩余时间描述；**已过期的作业这个元素被整个移除** |
| `.time.notOver` | 未过期标记 |
| `.label` | `互评` 标记 |
| `.tag.icon-hp-gy` | 互评类型标记 |
| `#page li` | 分页，取最大纯数字即总页数 |

### 状态文本

| 状态 | 归类 |
|---|---|
| 未交 / 未提交 | `pending` |
| 待互评 / 待互評 | `peerreview` |
| 待批阅 / 待批閱 / 待批改 | `grading` |
| 已完成 / 已批改 / 已互评 / 已互評 | `done` |

### 时间

列表页**只给相对时间**：`剩余90小时37分钟`、`剩余2天3小时`、`剩余59分钟`。

绝对截止时间要反推：`deadline = 抓取时刻 + 剩余时长`。误差为页面渲染到解析之间的秒数。

想要精确值只能进详情页：

```
GET https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task
    ?courseId=&classId=&cpi=&workId=&answerId=&enc=
```

详情页里有 `作答时间: MM-DD HH:MM 至 MM-DD HH:MM`，**「至」后面那个是截止时间**。互评作业的详情页则有 `互评时间：05-08 19:39 至 05-12 16:39`（`.hpInfo`）。

每个作业多一次请求，风控风险上升，所以本项目默认不开。

---

## 4. 考试列表

```
GET https://mooc1-api.chaoxing.com/exam-ans/exam/test/examcode/examlist
```

服务端渲染表格，列序：

```
编号 | 名称 | 时间 | 时长 | 考试状态 | 作答状态 | 分数 | 方式
```

时间列形如 `2026-11-10 14:00~2026-11-10 15:30`，取后一端为截止。

> 旧路径（不带 `exam-ans`）会 302 到上面这个地址。

---

## 5. 未读通知（实验性）

```
POST https://notice.chaoxing.com/pc/notice/getNoticeList
Content-Type: application/x-www-form-urlencoded

type=&notice_type=&lastValue=&sort=0
```

返回 JSON，`notices[]` 含 `title` / `content`（即全文）/ `createrName` / `completeTime` / `isread` / `lastGetId`（游标翻页用）。

> 这组参数缺乏稳定的一手验证，随平台调整可能失效。本项目把它做成「失败不影响主流程」的独立模块。

---

## 请求节制

平台有风控，短时间大量请求会要求输入验证码。本项目的取值：

| 项 | 值 |
|---|---|
| 并发课程数 | 3 |
| 同课程翻页间隔 | 500 ms |
| 单请求超时 | 15 s |
| 重试 | 2 次（仅超时 / 网络错误 / 5xx / 429） |
| 结果缓存 | 5 分钟 |
| 课程列表缓存 | 30 分钟 |
| 已结课课程 | 默认跳过，不请求 |
