/**
 * 生成一份示例 .ics，用于在手机上先行验证「导入日历 → 收到提醒」这条链路。
 * 复用主脚本里同一份 ICS 实现，不复制逻辑。
 *
 * 运行：node tools/gen-demo.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = readFileSync(join(root, 'chaoxing-deadline.user.js'), 'utf8');

function extract(source, name) {
  const re = new RegExp(
    `/\\* @testable:start ${name} \\*/([\\s\\S]*?)/\\* @testable:end ${name} \\*/`
  );
  const m = re.exec(source);
  if (!m) throw new Error(`未找到 @testable 区段: ${name}`);
  return m[1];
}

const code = `const pad2 = (n) => String(n).padStart(2, '0');` + extract(src, 'ics');
const { ICS } = vm.runInNewContext(
  code + '\n;({ ICS })',
  { TextEncoder, Date, console, String, Number, Math, Array, JSON }
);

/* --------- 构造一批贴近真实的示例数据（时间相对当前，导入即可看到效果） --------- */
const now = Date.now();
const H = 3600e3;
const D = 24 * H;

/** 取某个时间点之后的最近一个整点，让示例看起来像真实课表 */
function nextHour(ms) {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.getTime();
}

function fmt(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const items = [
  {
    uid: 'demo-hw-gaoshu-1@chaoxing-deadline',
    title: '第三章 导数与微分 课后习题',
    courseName: '高等数学 A（上）',
    deadline: nextHour(now + 5 * H),
    url: 'https://mooc1.chaoxing.com/',
  },
  {
    uid: 'demo-hw-ds-2@chaoxing-deadline',
    title: '实验二：二叉树遍历与哈夫曼编码',
    courseName: '数据结构',
    deadline: nextHour(now + 26 * H),
    url: 'https://mooc1.chaoxing.com/',
  },
  {
    uid: 'demo-hw-en-3@chaoxing-deadline',
    title: 'Unit 5 Writing Task: Argumentative Essay',
    courseName: '大学英语（三）',
    deadline: nextHour(now + 2 * D + 8 * H),
    url: 'https://mooc1.chaoxing.com/',
  },
  {
    uid: 'demo-exam-4@chaoxing-deadline',
    title: '线性代数 期中考试',
    courseName: '线性代数',
    deadline: nextHour(now + 6 * D + 3 * H),
    url: 'https://mooc1.chaoxing.com/',
  },
  {
    uid: 'demo-hw-maogai-5@chaoxing-deadline',
    title: '专题四 学习心得（不少于 800 字）',
    courseName: '毛泽东思想和中国特色社会主义理论体系概论',
    deadline: nextHour(now + 11 * D),
    url: 'https://mooc1.chaoxing.com/',
  },
];

const ics = ICS.buildCalendar(items, {
  now,
  calName: '学习通截止提醒（示例）',
  calDesc: '这是 chaoxing-deadline 的示例日历，用于验证导入与提醒效果。真实数据请用脚本导出。',
  durationMin: 30,
  reminders: [-3 * 24 * 60, -24 * 60, -120],
  summaryOf: (it) => `[${it.courseName}] ${it.title}`,
  descOf: (it) =>
    [
      `课程：${it.courseName}`,
      `类型：作业`,
      `截止：${fmt(it.deadline)}`,
      '',
      '由「学习通作业倒计时」导出',
    ].join('\n'),
  categoriesOf: () => '作业',
});

mkdirSync(join(root, 'examples'), { recursive: true });
const out = join(root, 'examples', 'demo.ics');
writeFileSync(out, ics, 'utf8');

const kb = (Buffer.byteLength(ics, 'utf8') / 1024).toFixed(1);
console.log(`已生成 ${out}`);
console.log(`  事件数：${items.length} 个`);
console.log(`  大小：${kb} KB`);
console.log(`  首个截止：${fmt(items[0].deadline)}`);
