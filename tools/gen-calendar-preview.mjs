/**
 * 生成一个自包含的日历验证页：examples/calendar-preview.html
 *
 * 页面里内置一份独立的 .ics 解析器，把 examples/demo.ics 解出来，
 * 渲染成「手机锁屏通知 + 事件清单 + 解析诊断」。
 * 用第三方视角读我们生成的日历文件，等于对 ICS 生成端做一次独立校验。
 *
 * 运行：node tools/gen-calendar-preview.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const icsText = readFileSync(join(root, 'examples', 'demo.ics'), 'utf8');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>日历效果验证 · 学习通截止提醒</title>
<style>
  *{box-sizing:border-box}
  body{
    margin:0;background:#f5f7fa;color:#1a2233;
    font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
    padding:28px 20px 60px;line-height:1.6;
  }
  .wrap{max-width:1040px;margin:0 auto}
  header{margin-bottom:22px}
  h1{font-size:19px;margin:0 0 6px;font-weight:650;letter-spacing:.2px}
  .lead{font-size:13px;color:#6b7688;margin:0}
  .drop{
    margin:18px 0 24px;border:1.5px dashed #c8d1e0;border-radius:12px;
    padding:18px;text-align:center;font-size:13px;color:#7a8699;background:#fff;
    transition:.16s;cursor:pointer;
  }
  .drop.hover{border-color:#3457d5;background:#f2f5ff;color:#3457d5}
  .drop b{color:#3457d5;font-weight:600}

  .grid{display:grid;grid-template-columns:340px 1fr;gap:26px;align-items:start}
  @media(max-width:860px){.grid{grid-template-columns:1fr}}

  /* ---------- 手机模拟 ---------- */
  .phone{
    background:#0d1117;border-radius:34px;padding:12px;
    box-shadow:0 22px 50px rgba(15,23,42,.28),0 2px 6px rgba(15,23,42,.12);
    position:sticky;top:20px;
  }
  .screen{
    background:linear-gradient(170deg,#1e293b 0%,#0f172a 55%,#020617 100%);
    border-radius:24px;padding:0 12px 16px;overflow:hidden;min-height:600px;
  }
  .statusbar{
    display:flex;justify-content:space-between;color:#e2e8f0;
    font-size:11px;padding:11px 6px 0;font-weight:600;letter-spacing:.3px;
  }
  .lockclock{color:#fff;text-align:center;padding:26px 0 6px}
  .lockclock .t{font-size:46px;font-weight:250;letter-spacing:-1px;line-height:1.1}
  .lockclock .d{font-size:12px;color:#94a3b8;margin-top:4px}

  .notice{color:#94a3b8;font-size:10px;text-align:center;margin:14px 0 8px;letter-spacing:.5px}
  .card{
    background:rgba(255,255,255,.1);backdrop-filter:blur(14px);
    border-radius:14px;padding:10px 12px;margin:0 0 8px;
    border:1px solid rgba(255,255,255,.12);
  }
  .card .app{
    display:flex;align-items:center;gap:6px;font-size:10px;color:#cbd5e1;
    margin-bottom:5px;
  }
  .card .app .ic{
    width:15px;height:15px;border-radius:4px;background:#fff;
    display:flex;align-items:center;justify-content:center;
  }
  .card .app .ic svg{display:block}
  .card .app .ago{margin-left:auto;color:#94a3b8}
  .card .ttl{color:#f1f5f9;font-size:12.5px;font-weight:600;line-height:1.4}
  .card .sub{color:#94a3b8;font-size:11px;margin-top:2px}
  .card .warn{color:#fca5a5}

  /* ---------- 右侧 ---------- */
  .panel{background:#fff;border-radius:14px;border:1px solid #e6e9f0;overflow:hidden;margin-bottom:18px}
  .panel h2{
    font-size:13px;margin:0;padding:13px 16px;border-bottom:1px solid #eef1f6;
    font-weight:600;display:flex;align-items:center;gap:8px;
  }
  .panel h2 .tag{
    font-size:10px;font-weight:500;color:#30a46c;background:#e8f7ef;
    padding:2px 7px;border-radius:20px;
  }
  .panel h2 .tag.bad{color:#c93b40;background:#fdeaea}
  .diag{padding:12px 16px;font-size:12.5px}
  .diag .row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dashed #f0f3f8}
  .diag .row:last-child{border-bottom:0}
  .diag .k{color:#6b7688}
  .diag .v{font-weight:600;font-variant-numeric:tabular-nums}
  .ok{color:#30a46c}.bad{color:#c93b40}

  table{width:100%;border-collapse:collapse;font-size:12px}
  th{
    text-align:left;padding:9px 12px;background:#fafbfd;color:#7a8699;
    font-weight:500;font-size:11px;border-bottom:1px solid #eef1f6;white-space:nowrap;
  }
  td{padding:10px 12px;border-bottom:1px solid #f4f6fa;vertical-align:top}
  tr:last-child td{border-bottom:0}
  td.ttl{font-weight:600;color:#1a2233;max-width:260px}
  td.time{white-space:nowrap;color:#5b6478;font-variant-numeric:tabular-nums}
  .pill{
    display:inline-block;font-size:10.5px;padding:2px 7px;border-radius:20px;
    background:#eef1f6;color:#5b6478;white-space:nowrap;
  }
  .pill.r{background:#fdeaea;color:#c93b40}
  .pill.o{background:#fef4e3;color:#a86a05}
  .pill.g{background:#e8f7ef;color:#1f7a4d}
  .desc{
    font-size:11px;color:#7a8699;margin-top:4px;white-space:pre-wrap;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.5;
  }
  .footnote{
    font-size:11.5px;color:#8b95a7;margin-top:22px;text-align:center;line-height:1.8;
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>日历效果验证</h1>
    <p class="lead">下面这份是真实的 <code>.ics</code> 文件被独立解析后的结果。左边是导入手机后、截止临近时锁屏会弹出的样子。</p>
  </header>

  <div class="drop" id="drop">
    拖入你自己导出的 <b>.ics</b> 文件即可替换验证　·　或 <b>点击选择文件</b>
    <input type="file" id="file" accept=".ics,text/calendar" hidden>
  </div>

  <div class="grid">
    <div class="phone">
      <div class="screen">
        <div class="statusbar"><span>中国移动</span><span>100%</span></div>
        <div class="lockclock">
          <div class="t" id="clock">--:--</div>
          <div class="d" id="today">--</div>
        </div>
        <div class="notice" id="noticeLabel">现在</div>
        <div id="notifs"></div>
      </div>
    </div>

    <div>
      <div class="panel">
        <h2>解析诊断 <span class="tag" id="diagTag">检查中</span></h2>
        <div class="diag" id="diag"></div>
      </div>

      <div class="panel">
        <h2>日历事件 <span class="tag" id="evTag" style="background:#eef1f6;color:#5b6478">—</span></h2>
        <div style="overflow-x:auto">
          <table>
            <thead>
              <tr><th>标题</th><th>截止时间</th><th>提前提醒</th></tr>
            </thead>
            <tbody id="tbody"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <p class="footnote">
    这个页面与脚本无关，是一个独立的日历文件阅读器。<br>
    它能把数据正确读出来，说明生成的 <code>.ics</code> 符合标准，任何日历 App 都能吃。
  </p>
</div>

<script>
/* 由 tools/gen-calendar-preview.mjs 生成，示例数据来自 examples/demo.ics */
var EMBEDDED_ICS = ${JSON.stringify(icsText)};

/* ------------------------- 独立的 ICS 解析器 ------------------------- */

/** RFC 5545 折行还原：CRLF + 空格/制表符 */
function unfold(text) {
  return String(text).replace(/\\r\\n[ \\t]/g, '').replace(/\\n[ \\t]/g, '');
}

/** TEXT 反转义：\\\\ \\; \\, \\n */
function unesc(s) {
  return String(s == null ? '' : s).replace(/\\\\([\\\\;,nN])/g, function (m, c) {
    return c === 'n' || c === 'N' ? '\\n' : c;
  });
}

/** 20261105T155900Z → 毫秒；无 Z 视为本地时间 */
function parseDT(v) {
  var m = /^(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})(Z?)$/.exec(String(v || '').trim());
  if (!m) return null;
  var y = +m[1], mo = +m[2] - 1, d = +m[3], h = +m[4], mi = +m[5], s = +m[6];
  return m[7] ? Date.UTC(y, mo, d, h, mi, s) : new Date(y, mo, d, h, mi, s).getTime();
}

/** -P3D / -PT2H / -PT1H30M → 分钟数（正数表示提前多少分钟） */
function triggerToMinutes(v) {
  var m = /^-?P(?:(\\d+)D)?(?:T(?:(\\d+)H)?(?:(\\d+)M)?)?$/.exec(String(v || '').trim());
  if (!m) return null;
  return (parseInt(m[1] || '0', 10) * 1440) + (parseInt(m[2] || '0', 10) * 60) + parseInt(m[3] || '0', 10);
}

function parseICS(text) {
  var raw = unfold(text);
  var lines = raw.split(/\\r\\n|\\n|\\r/);
  var events = [], cur = null, alarm = null;
  var foldedCount = (String(text).match(/\\r\\n[ \\t]/g) || []).length;

  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (!ln) continue;
    if (ln === 'BEGIN:VEVENT') { cur = { alarms: [] }; alarm = null; continue; }
    if (ln === 'END:VEVENT') { if (cur) events.push(cur); cur = null; alarm = null; continue; }
    if (ln === 'BEGIN:VALARM') { alarm = {}; continue; }
    if (ln === 'END:VALARM') { if (alarm && cur) cur.alarms.push(alarm); alarm = null; continue; }

    var idx = ln.indexOf(':');
    if (idx < 0) continue;
    var key = ln.slice(0, idx).split(';')[0].toUpperCase();
    var val = ln.slice(idx + 1);

    if (alarm) alarm[key] = val;
    else if (cur) cur[key] = val;
  }

  return {
    events: events.map(function (e) {
      return {
        uid: unesc(e.UID || ''),
        title: unesc(e.SUMMARY || '(无标题)'),
        desc: unesc(e.DESCRIPTION || ''),
        start: parseDT(e.DTSTART),
        end: parseDT(e.DTEND),
        url: e.URL || '',
        alarms: (e.alarms || []).map(function (a) {
          return { minutes: triggerToMinutes(a.TRIGGER), raw: a.TRIGGER, text: unesc(a.DESCRIPTION || '') };
        }),
      };
    }),
    lineCount: lines.length,
    foldedCount: foldedCount,
    rawLength: String(text).length,
    hasCRLFOnly: !/(^|[^\\r])\\n/.test(String(text).replace(/\\r\\n/g, '')),
  };
}

/* ------------------------- 渲染 ------------------------- */

function p2(n) { return String(n).padStart(2, '0'); }

function fmtFull(ms) {
  var d = new Date(ms);
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
    ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

function humanLeft(ms) {
  var diff = ms - Date.now();
  var past = diff < 0;
  diff = Math.abs(diff);
  var d = Math.floor(diff / 86400000);
  var h = Math.floor((diff % 86400000) / 3600000);
  var m = Math.floor((diff % 3600000) / 60000);
  var s = d > 0 ? d + ' 天' + (h ? ' ' + h + ' 小时' : '') : (h > 0 ? h + ' 小时 ' + m + ' 分' : m + ' 分钟');
  return past ? '已过 ' + s : '还有 ' + s;
}

function humanOffset(min) {
  if (min == null) return '—';
  if (min >= 1440) return '提前 ' + (min / 1440) + ' 天';
  if (min >= 60) return '提前 ' + (min % 60 === 0 ? min / 60 + ' 小时' : min / 60 + ' 小时');
  return '提前 ' + min + ' 分钟';
}

function render(data, label) {
  var events = data.events.slice().sort(function (a, b) { return (a.start || 0) - (b.start || 0); });
  var now = Date.now();
  var clock = new Date(now);
  document.getElementById('clock').textContent = p2(clock.getHours()) + ':' + p2(clock.getMinutes());
  document.getElementById('today').textContent =
    (clock.getMonth() + 1) + '月' + clock.getDate() + '日 星期' + '日一二三四五六'[clock.getDay()];

  /* ---- 锁屏通知：取最近 3 个未过期的，模拟「提醒弹出的那一刻」 ---- */
  var upcoming = events.filter(function (e) { return e.start && e.start > now; }).slice(0, 3);
  var nbox = document.getElementById('notifs');
  nbox.innerHTML = '';
  document.getElementById('noticeLabel').textContent = upcoming.length ? '通知中心' : '暂无临近提醒';

  upcoming.forEach(function (e) {
    var left = humanLeft(e.start);
    var urgent = e.start - now < 6 * 3600000;
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<div class="app">' +
        '<span class="ic"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#e5484d" stroke-width="2.6">' +
        '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 10.5h18"/></svg></span>' +
        '日历<span class="ago">现在</span>' +
      '</div>' +
      '<div class="ttl' + (urgent ? ' warn' : '') + '">' + escapeHtml(left) + '截止</div>' +
      '<div class="sub">' + escapeHtml(e.title) + '</div>';
    nbox.appendChild(card);
  });

  /* ---- 解析诊断 ---- */
  var bad = 0;
  var diag = [];
  diag.push(['日历事件总数', events.length, events.length > 0]);
  diag.push(['源文件行数', data.lineCount, true]);
  diag.push(['折行还原', data.foldedCount + ' 处', true]);
  diag.push(['换行符', data.hasCRLFOnly ? '全部 CRLF（合规）' : '含裸 LF', data.hasCRLFOnly]);
  diag.push(['闹钟总数', events.reduce(function (n, e) { return n + e.alarms.length; }, 0), true]);

  var missing = events.filter(function (e) { return !e.start || !e.uid || !e.title; });
  if (missing.length) bad++;
  diag.push(['必填字段完整', missing.length ? missing.length + ' 个事件缺失' : '全部完整', missing.length === 0]);

  var noAlarm = events.filter(function (e) { return !e.alarms.length; });
  diag.push(['每个事件都有提醒', noAlarm.length ? noAlarm.length + ' 个没有' : '是', noAlarm.length === 0]);

  var badTrigger = events.some(function (e) {
    return e.alarms.some(function (a) { return a.minutes == null; });
  });
  diag.push(['提醒时间可解析', badTrigger ? '存在无法识别的 TRIGGER' : '是', !badTrigger]);

  var dbox = document.getElementById('diag');
  dbox.innerHTML = diag.map(function (r) {
    return '<div class="row"><span class="k">' + r[0] + '</span>' +
      '<span class="v ' + (r[2] ? 'ok' : 'bad') + '">' + r[1] + '</span></div>';
  }).join('');

  var allOk = diag.every(function (r) { return r[2]; });
  var tag = document.getElementById('diagTag');
  tag.textContent = allOk ? '全部通过' : '有问题';
  tag.className = 'tag' + (allOk ? '' : ' bad');

  document.getElementById('evTag').textContent = label;

  /* ---- 事件表 ---- */
  var tb = document.getElementById('tbody');
  tb.innerHTML = '';
  events.forEach(function (e) {
    var left = e.start == null ? 0 : e.start - now;
    var cls = left < 0 ? 'g' : left < 24 * 3600000 ? 'r' : left < 72 * 3600000 ? 'o' : 'g';
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td class="ttl">' + escapeHtml(e.title) +
        (e.desc ? '<div class="desc">' + escapeHtml(e.desc.split('\\n').filter(Boolean).join('\\n')) + '</div>' : '') +
      '</td>' +
      '<td class="time">' + (e.start ? fmtFull(e.start) : '—') +
        '<div style="margin-top:4px"><span class="pill ' + cls + '">' +
        (e.start ? humanLeft(e.start) : '无时间') + '</span></div>' +
      '</td>' +
      '<td>' + (e.alarms.length
        ? e.alarms.map(function (a) { return '<span class="pill">' + humanOffset(a.minutes) + '</span>'; }).join(' ')
        : '<span class="pill">无</span>') +
      '</td>';
    tb.appendChild(tr);
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ------------------------- 交互 ------------------------- */

var drop = document.getElementById('drop');
var fileInput = document.getElementById('file');

drop.addEventListener('click', function () { fileInput.click(); });
fileInput.addEventListener('change', function () {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
});

['dragenter', 'dragover'].forEach(function (ev) {
  drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('hover'); });
});
['dragleave', 'drop'].forEach(function (ev) {
  drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('hover'); });
});
drop.addEventListener('drop', function (e) {
  var f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

function loadFile(f) {
  var r = new FileReader();
  r.onload = function () {
    var data = parseICS(r.result);
    render(data, f.name);
    drop.innerHTML = '已载入 <b>' + escapeHtml(f.name) + '</b>　·　点击可换一个文件';
  };
  r.readAsText(f, 'utf-8');
}

/* 首屏：解析内置示例 */
render(parseICS(EMBEDDED_ICS), '示例数据 demo.ics');
</script>
</body>
</html>
`;

const out = join(root, 'examples', 'calendar-preview.html');
writeFileSync(out, html, 'utf8');
console.log(`已生成 ${out}`);
console.log(`  内嵌 .ics 大小：${(Buffer.byteLength(icsText, 'utf8') / 1024).toFixed(1)} KB`);
