/**
 * 直接对发布用的 chaoxing-deadline.user.js 做测试 —— 不复制代码，
 * 而是把标记为 @testable 的区段抽出来，在 vm 里跑，保证测的就是发的。
 *
 * 运行：node test/ics.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'chaoxing-deadline.user.js');

function extract(source, name) {
  const re = new RegExp(
    `/\\* @testable:start ${name} \\*/([\\s\\S]*?)/\\* @testable:end ${name} \\*/`
  );
  const m = re.exec(source);
  if (!m) throw new Error(`未找到 @testable 区段: ${name}`);
  return m[1];
}

const src = readFileSync(SRC, 'utf8');

// 被测代码依赖的最小外部环境
const prelude = `
  const pad2 = (n) => String(n).padStart(2, '0');
`;

const code = prelude + extract(src, 'time') + extract(src, 'ics');
const sandbox = { TextEncoder, Date, console, String, Number, Math, Array, JSON };
const { TimeParser, ICS } = vm.runInNewContext(
  code + '\n;({ TimeParser, ICS })',
  sandbox
);

/* ------------------------------ 迷你断言器 ------------------------------ */
let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    failures.push(`${label}\n    期望: ${e}\n    实际: ${a}`);
  }
}
function ok(cond, label) {
  if (cond) pass++;
  else failures.push(label);
}
function group(name, fn) {
  fn();
}

/* ------------------------------ 1. 相对时间 ------------------------------ */

group('TimeParser.parseRemaining', () => {
  eq(TimeParser.parseRemaining('剩余90小时37分钟'), 90 * 3600e3 + 37 * 60e3, '小时+分钟');
  eq(TimeParser.parseRemaining('剩余2天3小时'), 2 * 86400e3 + 3 * 3600e3, '天+小时');
  eq(TimeParser.parseRemaining('剩余3天'), 3 * 86400e3, '仅天');
  eq(TimeParser.parseRemaining('剩余59分钟'), 59 * 60e3, '仅分钟');
  eq(TimeParser.parseRemaining('剩余 12 小时 5 分'), 12 * 3600e3 + 5 * 60e3, '带空格');
  eq(TimeParser.parseRemaining('剩余30秒'), 30e3, '秒');
  eq(TimeParser.parseRemaining('已结束'), 0, '已结束');
  eq(TimeParser.parseRemaining('已过期'), 0, '已过期');
  eq(TimeParser.parseRemaining('即将结束'), 60e3, '即将结束');
  eq(TimeParser.parseRemaining(''), null, '空串');
  eq(TimeParser.parseRemaining(null), null, 'null');
  eq(TimeParser.parseRemaining('无时间信息'), null, '无法解析');
});

/* ------------------------------ 2. 绝对时间 ------------------------------ */

group('TimeParser.parseDeadlineWindow', () => {
  const now = new Date(2026, 4, 5, 10, 0, 0); // 2026-05-05 10:00

  // 学习通互评：互评时间：05-08 19:39 至 05-12 16:39 —— 取「至」后面那个
  const peer = TimeParser.parseDeadlineWindow('互评时间：05-08 19:39 至 05-12 16:39', now);
  eq(new Date(peer).getTime(), new Date(2026, 4, 12, 16, 39).getTime(), '互评窗口取截止端');

  // 考试：2026-11-10 14:00~2026-11-10 15:30
  const exam = TimeParser.parseDeadlineWindow('2026-11-10 14:00~2026-11-10 15:30', now);
  eq(new Date(exam).getTime(), new Date(2026, 10, 10, 15, 30).getTime(), '考试窗口取结束端');

  // 单个时间点
  const single = TimeParser.parseDeadlineWindow('2026-11-10 14:00', now);
  eq(new Date(single).getTime(), new Date(2026, 10, 10, 14, 0).getTime(), '单点');

  // 无年份 + 跨年（12 月看到的 1 月截止）
  const dec = new Date(2026, 11, 20, 10, 0, 0);
  const cross = TimeParser.parseDeadlineWindow('01-05 23:59', dec);
  eq(new Date(cross).getFullYear(), 2027, '无年份跨年推导');

  eq(TimeParser.parseDeadlineWindow('没有时间', now), null, '无法解析');
  eq(TimeParser.parseDeadlineWindow('', now), null, '空串');
});

/* ------------------------------ 3. 转义 ------------------------------ */

group('ICS.esc', () => {
  eq(ICS.esc('普通标题'), '普通标题', '无特殊字符');
  eq(ICS.esc('a;b'), 'a\\;b', '分号');
  eq(ICS.esc('a,b'), 'a\\,b', '逗号');
  eq(ICS.esc('a\\b'), 'a\\\\b', '反斜杠');
  eq(ICS.esc('第一行\n第二行'), '第一行\\n第二行', '换行');
  eq(ICS.esc('a\r\nb'), 'a\\nb', 'CRLF 归一');
  eq(ICS.esc(null), '', 'null');
  eq(ICS.esc(undefined), '', 'undefined');
});

/* ------------------------------ 4. 折行 ------------------------------ */

group('ICS.fold', () => {
  const enc = new TextEncoder();
  const lines = (s) => s.split('\r\n');

  // 短行原样返回
  eq(ICS.fold('SUMMARY:短标题'), 'SUMMARY:短标题', '短行不变');

  // 长英文：每行 ≤75 字节
  const longEn = 'DESCRIPTION:' + 'abcdefghij'.repeat(20);
  const foldedEn = ICS.fold(longEn);
  ok(
    lines(foldedEn).every((l) => enc.encode(l).length <= 75),
    '英文折行每行 ≤75 字节'
  );
  ok(
    lines(foldedEn)
      .slice(1)
      .every((l) => l.startsWith(' ')),
    '续行以空格开头'
  );
  eq(
    foldedEn.replace(/\r\n /g, ''),
    longEn,
    '英文折行可无损还原'
  );

  // 长中文：绝不能截断多字节字符
  const longZh = 'SUMMARY:' + '这是一段很长的中文作业标题用来测试折行逻辑'.repeat(8);
  const foldedZh = ICS.fold(longZh);
  const zhLines = lines(foldedZh);
  ok(
    zhLines.every((l) => enc.encode(l).length <= 75),
    '中文折行每行 ≤75 字节'
  );
  eq(foldedZh.replace(/\r\n /g, ''), longZh, '中文折行可无损还原');
  ok(!/\uFFFD/.test(foldedZh), '中文折行无乱码替换字符');

  // 每行都是合法 UTF-8（TextEncoder/Decoder 往返一致）
  ok(
    zhLines.every((l) => {
      const b = enc.encode(l);
      return new TextDecoder('utf-8', { fatal: false }).decode(b) === l;
    }),
    '每行 UTF-8 往返一致'
  );

  // 恰好 75 字节时不应折行
  const exact = 'X'.repeat(75);
  eq(ICS.fold(exact), exact, '恰好 75 字节不折行');

  const over = 'X'.repeat(76);
  eq(lines(ICS.fold(over)).length, 2, '76 字节折成 2 行');
});

/* ------------------------------ 5. 时间格式 ------------------------------ */

group('ICS.fmtUTC', () => {
  const ms = Date.UTC(2026, 10, 10, 6, 30, 0);
  eq(ICS.fmtUTC(ms), '20261110T063000Z', 'UTC 格式');
  eq(ICS.fmtUTC(Date.UTC(2026, 0, 1, 0, 0, 0)), '20260101T000000Z', '补零');
});

/* ------------------------------ 6. 闹钟 ------------------------------ */

group('ICS.triggerFromMinutes', () => {
  eq(ICS.triggerFromMinutes(-1440), '-P1D', '提前 1 天');
  eq(ICS.triggerFromMinutes(-4320), '-P3D', '提前 3 天');
  eq(ICS.triggerFromMinutes(-120), '-PT2H', '提前 2 小时');
  eq(ICS.triggerFromMinutes(-90), '-PT1H30M', '提前 1.5 小时');
  eq(ICS.triggerFromMinutes(-15), '-PT15M', '提前 15 分钟');
  eq(ICS.triggerFromMinutes(1440), '-P1D', '正数也取绝对值');
});

/* ------------------------------ 7. 日历整体 ------------------------------ */

group('ICS.buildCalendar', () => {
  const now = Date.UTC(2026, 10, 3, 12, 0, 0);
  const items = [
    {
      uid: 'cxd-hw-1-2-3@chaoxing-deadline',
      title: '第三章 习题; 含分号, 含逗号',
      deadline: Date.UTC(2026, 10, 5, 15, 59, 0),
      url: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?workId=3',
      courseName: '高等数学',
    },
    {
      uid: 'cxd-exam-abc@chaoxing-deadline',
      title: '期中考试',
      deadline: Date.UTC(2026, 10, 10, 6, 0, 0),
      url: '',
      courseName: '线性代数',
    },
    // 没有截止时间的条目应被跳过
    { uid: 'x', title: '无时间', deadline: null, url: '' },
  ];

  const ics = ICS.buildCalendar(items, {
    now,
    calName: '学习通截止提醒',
    reminders: [-1440, -120],
    durationMin: 30,
    summaryOf: (it) => `[${it.courseName}] ${it.title}`,
    descOf: (it) => `课程：${it.courseName}`,
  });

  ok(ics.startsWith('BEGIN:VCALENDAR\r\n'), '以 BEGIN:VCALENDAR 开头');
  ok(ics.endsWith('END:VCALENDAR\r\n'), '以 END:VCALENDAR + CRLF 结尾');
  ok(ics.includes('\r\n') && !/[^\r]\n/.test(ics), '全部使用 CRLF 换行');

  const begins = (ics.match(/BEGIN:VEVENT/g) || []).length;
  const ends = (ics.match(/END:VEVENT/g) || []).length;
  eq(begins, 2, '只生成 2 个事件（跳过无截止时间的）');
  eq(ends, begins, 'VEVENT 起止配对');

  ok(ics.includes('BEGIN:VALARM'), '包含闹钟');
  eq((ics.match(/BEGIN:VALARM/g) || []).length, 4, '2 事件 × 2 个闹钟');
  eq((ics.match(/END:VALARM/g) || []).length, 4, 'VALARM 起止配对');

  ok(ics.includes('TRIGGER:-P1D'), '含提前 1 天闹钟');
  ok(ics.includes('TRIGGER:-PT2H'), '含提前 2 小时闹钟');
  ok(ics.includes('DTSTART:20261105T155900Z'), 'DTSTART 正确');
  ok(ics.includes('DTEND:20261105T162900Z'), 'DTEND = DTSTART + 30 分钟');
  ok(ics.includes('UID:cxd-hw-1-2-3@chaoxing-deadline'), 'UID 正确');
  ok(ics.includes('VERSION:2.0'), '含 VERSION');
  ok(ics.includes('PRODID:'), '含 PRODID');

  // 标题里的分号逗号必须转义，不能被当作字段分隔符
  ok(ics.includes('SUMMARY:[高等数学] 第三章 习题\\; 含分号\\, 含逗号'), '标题特殊字符已转义');

  // 结构校验：所有折行后每行 ≤75 字节
  const enc = new TextEncoder();
  ok(
    ics.split('\r\n').every((l) => l === '' || enc.encode(l).length <= 75),
    '所有行 ≤75 字节'
  );

  // 简单解析器：验证每个 VEVENT 都能被结构化读出
  const unfolded = ics.replace(/\r\n /g, '');
  const events = unfolded.split('BEGIN:VEVENT').slice(1);
  eq(events.length, 2, '可解析出 2 个事件');
  ok(
    events.every((e) => /^UID:.+$/m.test(e) && /^DTSTART:\d{8}T\d{6}Z$/m.test(e)),
    '每个事件都有 UID 与合法 DTSTART'
  );
});

/* ------------------------------ 8. 边界：单个超长中文标题 ------------------------------ */

group('边界情况', () => {
  const now = Date.UTC(2026, 10, 3, 12, 0, 0);
  const longTitle = '【超长标题】'.repeat(30);
  const ics = ICS.buildCalendar(
    [{ uid: 'u1', title: longTitle, deadline: now + 86400e3, url: '' }],
    { now, reminders: [-60], summaryOf: (it) => it.title }
  );
  const enc = new TextEncoder();
  ok(
    ics.split('\r\n').every((l) => l === '' || enc.encode(l).length <= 75),
    '超长中文标题折行后每行仍 ≤75 字节'
  );
  const unfolded = ics.replace(/\r\n /g, '');
  ok(unfolded.includes('SUMMARY:' + longTitle), '超长标题无损还原');

  // 空列表
  const empty = ICS.buildCalendar([], { now, reminders: [] });
  ok(empty.startsWith('BEGIN:VCALENDAR'), '空列表也能生成合法日历');
  ok(!empty.includes('BEGIN:VEVENT'), '空列表无事件');
});

/* ------------------------------ 输出 ------------------------------ */

const total = pass + failures.length;
console.log(`\n  学习通倒计时 · 逻辑测试`);
console.log(`  源文件: chaoxing-deadline.user.js`);
console.log('  ' + '─'.repeat(46));
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log('  ' + '─'.repeat(46));
  console.log(`  ${pass}/${total} 通过，${failures.length} 失败\n`);
  process.exit(1);
} else {
  console.log(`  ✓ 全部 ${total} 项断言通过\n`);
}
