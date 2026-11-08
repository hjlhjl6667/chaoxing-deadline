/**
 * 待批阅过期过滤的测试。同样从发布文件里抽 @testable 区段，测的就是发的。
 *
 * 运行：node test/grading.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'chaoxing-deadline.user.js');

const src = readFileSync(SRC, 'utf8');
const m = /\/\* @testable:start grading \*\/([\s\S]*?)\/\* @testable:end grading \*\//.exec(src);
if (!m) throw new Error('未找到 @testable 区段: grading');

const code = 'const DAY_MS = 864e5;\n' + m[1];
const { gradingAgeDays, pickVisible } = vm.runInNewContext(
  code + '\n;({ gradingAgeDays, pickVisible })',
  { Date, Math, Number, Array, String }
);

let pass = 0;
const H = 3600e3;
const D = 24 * H;
const NOW = Date.parse('2026-11-08T12:00:00+08:00');

function ok(name, cond, extra) {
  if (!cond) {
    console.error(`  ✗ ${name}${extra ? '  → ' + extra : ''}`);
    process.exitCode = 1;
  } else {
    pass++;
    console.log(`  ✓ ${name}`);
  }
}

const grading = (uid, ageDays) => ({
  uid,
  kind: 'homework',
  category: 'grading',
  deadline: ageDays == null ? null : NOW - ageDays * D,
});
const pending = (uid, ageDays) => ({
  uid,
  kind: 'homework',
  category: 'pending',
  deadline: NOW + (ageDays == null ? 3 : ageDays) * D,
});

/* ---------------------------------- 年龄 ---------------------------------- */
ok('有截止时间时，按截止时间算年龄', Math.abs(gradingAgeDays(grading('a', 40), {}, NOW) - 40) < 1e-9);
ok('截止时间在未来时，年龄取 0 而不是负数', gradingAgeDays({ deadline: NOW + 5 * D }, {}, NOW) === 0);
ok('没有截止时间时，回落到首次扫到的时间', gradingAgeDays({ uid: 'x', deadline: null }, { x: NOW - 45 * D }, NOW) === 45);
ok('两者都没有时视为 0，不会被误杀', gradingAgeDays({ uid: 'y', deadline: null }, {}, NOW) === 0);

/* --------------------------------- 过滤 --------------------------------- */
const seen = { b: NOW - 100 * D, c: NOW - 2 * D };
const list = [
  grading('a', 5),      // 刚交，保留
  grading('b', null),   // 没截止时间，但 100 天前就扫到了 → 隐藏
  grading('c', null),   // 没截止时间，2 天前才出现 → 保留
  grading('d', 31),     // 超过 30 天 → 隐藏
  grading('e', 29),     // 差一天 → 保留
  pending('p', null),   // 未交作业不受影响
  { uid: 'ex', kind: 'exam', category: 'pending', deadline: NOW + D },
];

const v30 = pickVisible(list, 30, seen, NOW);
ok('30 天：隐藏 2 条超期待批阅', v30.length === 5, `实际 ${v30.length}`);
ok('30 天：31 天的被隐藏', !v30.some((i) => i.uid === 'd'));
ok('30 天：100 天前扫到、无截止时间的被隐藏', !v30.some((i) => i.uid === 'b'));
ok('30 天：29 天的保留', v30.some((i) => i.uid === 'e'));
ok('30 天：2 天前出现的无时间条目保留', v30.some((i) => i.uid === 'c'));
ok('30 天：未交作业不受影响', v30.some((i) => i.uid === 'p'));
ok('30 天：考试不受影响', v30.some((i) => i.uid === 'ex'));

const v0 = pickVisible(list, 0, seen, NOW);
ok('0 天表示不限制，全部保留', v0.length === list.length);

const v14 = pickVisible(list, 14, seen, NOW);
ok('14 天：2 天前出现的那条仍在，31/100 天的被隐藏',
  v14.some((i) => i.uid === 'c') && !v14.some((i) => i.uid === 'd') && !v14.some((i) => i.uid === 'b'));

const v60 = pickVisible(list, 60, seen, NOW);
ok('60 天：31 天的回来了，100 天的仍隐藏',
  v60.some((i) => i.uid === 'd') && !v60.some((i) => i.uid === 'b'));

const vNull = pickVisible(list, null, seen, NOW);
ok('限制值为空当作不限制', vNull.length === list.length);

console.log(`\n  ${pass} 项断言通过`);
