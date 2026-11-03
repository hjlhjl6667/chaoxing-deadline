// ==UserScript==
// @name         学习通作业倒计时 · 日历订阅
// @name:en      Chaoxing Deadline → Calendar
// @namespace    https://github.com/hjlhjl6667/chaoxing-deadline
// @version      1.0.0
// @description  一键扫描学习通全部课程的未交作业、待互评、待批阅、考试与未读通知，按剩余时间排序，并可导出 .ics 导入手机系统日历，到期自动提醒。不是又一个网页面板 —— 是让截止时间真正进入你的日程。
// @description:en Scan all Chaoxing assignments/exams/notices in one click, sort by time left, and export to .ics so deadlines live in your phone's calendar with real alarms.
// @author       hjlhjl6667
// @match        https://*.chaoxing.com/*
// @match        http://*.chaoxing.com/*
// @connect      chaoxing.com
// @connect      mooc1.chaoxing.com
// @connect      mooc1-api.chaoxing.com
// @connect      mooc2-ans.chaoxing.com
// @connect      notice.chaoxing.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-idle
// @noframes
// @license      MIT
// @homepageURL  https://github.com/hjlhjl6667/chaoxing-deadline
// @supportURL   https://github.com/hjlhjl6667/chaoxing-deadline/issues
// @updateURL    https://raw.githubusercontent.com/hjlhjl6667/chaoxing-deadline/main/chaoxing-deadline.user.js
// @downloadURL  https://raw.githubusercontent.com/hjlhjl6667/chaoxing-deadline/main/chaoxing-deadline.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ==========================================================================
   * 0. 配置
   * ========================================================================== */

  const CFG = {
    // 网络
    TIMEOUT: 15000,
    RETRY: 2,
    CONCURRENCY: 3,          // 同时请求的课程数，过高易触发风控
    PAGE_GAP: 500,           // 同一课程翻页间隔 ms
    // 缓存
    COURSE_TTL: 30 * 60e3,   // 课程列表缓存 30 分钟
    SCAN_TTL: 5 * 60e3,      // 扫描结果缓存 5 分钟
    // 紧急度阈值
    URGENT: 24 * 3600e3,     // 24 小时内 → 红
    SOON: 72 * 3600e3,       // 72 小时内 → 橙
    // 默认提醒偏移
    REMIND_OFFSETS: [-3 * 24 * 60, -24 * 60, -120],  // 分钟：提前 3 天 / 1 天 / 2 小时
    EVENT_DURATION_MIN: 30,
  };

  const STORE = {
    scan: 'cxd_scan_v1',
    courses: 'cxd_courses_v1',
    settings: 'cxd_settings_v1',
  };

  const DEFAULTS = {
    reminders: [-3 * 24 * 60, -24 * 60, -120],
    withExams: true,
    withNotices: true,
    includePeerReview: true,
    includeGrading: true,
    includeExpired: false,
    hideRetired: true,
    preciseMode: false,      // 走作业详情页取绝对时间（请求量大）
  };

  /* ==========================================================================
   * 1. 通用工具
   * ========================================================================== */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const pad2 = (n) => String(n).padStart(2, '0');

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function stripTags(html) {
    return String(html || '').replace(/<[^>]*>/g, '').trim();
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 并发池：限制同时运行的任务数 */
  async function pool(tasks, limit) {
    const results = new Array(tasks.length);
    let cursor = 0;
    const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
      while (cursor < tasks.length) {
        const i = cursor++;
        try {
          results[i] = { ok: true, value: await tasks[i]() };
        } catch (e) {
          results[i] = { ok: false, error: e };
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  function fmtDuration(ms) {
    if (ms == null) return '—';
    if (ms <= 0) return '已过截止';
    const d = Math.floor(ms / 86400e3);
    const h = Math.floor((ms % 86400e3) / 3600e3);
    const m = Math.floor((ms % 3600e3) / 60e3);
    if (d > 0) return `${d} 天 ${h} 小时`;
    if (h > 0) return `${h} 小时 ${m} 分`;
    return `${m} 分`;
  }

  function fmtDateTime(ms) {
    const d = new Date(ms);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /* ==========================================================================
   * 2. 时间解析（可测试区）
   * ========================================================================== */

  /* @testable:start time */
  const TimeParser = {
    /**
     * 解析学习通的相对时间描述，返回剩余毫秒数。
     * 支持："剩余90小时37分钟" / "剩余2天3小时" / "剩余59分钟" / "剩余3天" / "即将结束"
     * 返回 null 表示无法解析。
     */
    parseRemaining(text) {
      if (!text) return null;
      const s = String(text).replace(/\s+/g, '');
      if (/已结束|已过期|已截止/.test(s)) return 0;
      if (/即将结束|马上截止/.test(s)) return 60e3;

      const day = /(\d+)\s*天/.exec(s);
      const hour = /(\d+)\s*(?:小时|时)/.exec(s);
      const min = /(\d+)\s*分/.exec(s);
      const sec = /(\d+)\s*秒/.exec(s);

      if (!day && !hour && !min && !sec) return null;

      let ms = 0;
      if (day) ms += parseInt(day[1], 10) * 86400e3;
      if (hour) ms += parseInt(hour[1], 10) * 3600e3;
      if (min) ms += parseInt(min[1], 10) * 60e3;
      if (sec) ms += parseInt(sec[1], 10) * 1000;
      return ms;
    },

    /**
     * 解析绝对时间窗口文本，返回截止时刻（毫秒）。
     * 支持："作答时间: 05-08 19:39 至 05-12 16:39" / "2026-11-10 14:00~2026-11-10 15:30"
     * 只有 "至" / "~" 之后的那一端才是截止时间。
     */
    parseDeadlineWindow(text, now) {
      if (!text) return null;
      const s = String(text);
      const base = now instanceof Date ? now : new Date(now || Date.now());
      const year = base.getFullYear();

      // 形如 2026-11-10 14:00 或 05-12 16:39
      const re = /(\d{4})?[-/]?(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})/g;
      const found = [];
      let m;
      while ((m = re.exec(s)) !== null) {
        const y = m[1] ? parseInt(m[1], 10) : year;
        const mo = parseInt(m[2], 10) - 1;
        const d = parseInt(m[3], 10);
        const hh = parseInt(m[4], 10);
        const mm = parseInt(m[5], 10);
        found.push(new Date(y, mo, d, hh, mm, 0, 0).getTime());
      }
      if (!found.length) return null;
      // 取最后出现的那个时间作为截止点
      let dl = found[found.length - 1];
      // 无年份时，若结果早于当前时间超过半年，视为跨年
      if (!/\d{4}/.test(s) && dl < base.getTime() - 180 * 86400e3) {
        dl = new Date(base.getFullYear() + 1, new Date(dl).getMonth(), new Date(dl).getDate(),
          new Date(dl).getHours(), new Date(dl).getMinutes()).getTime();
      }
      return dl;
    },
  };
  /* @testable:end time */

  /* ==========================================================================
   * 3. ICS 生成（可测试区）—— 本项目的核心差异化能力
   * ========================================================================== */

  /* @testable:start ics */
  const ICS = {
    CRLF: '\r\n',

    /** 转 UTC 的 YYYYMMDDTHHMMSSZ */
    fmtUTC(ms) {
      const d = new Date(ms);
      return (
        d.getUTCFullYear() +
        pad2(d.getUTCMonth() + 1) +
        pad2(d.getUTCDate()) +
        'T' +
        pad2(d.getUTCHours()) +
        pad2(d.getUTCMinutes()) +
        pad2(d.getUTCSeconds()) +
        'Z'
      );
    },

    /** RFC 5545 TEXT 转义：反斜杠、分号、逗号、换行 */
    esc(t) {
      return String(t == null ? '' : t)
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r\n|\r|\n/g, '\\n');
    },

    /**
     * 按 RFC 5545 折行：每行不超过 75 个八位组（UTF-8 字节），
     * 续行以一个空格开头。按码点切分，不会切断多字节字符或代理对。
     */
    fold(line) {
      const enc = new TextEncoder();
      let out = [];
      let cur = '';
      let curBytes = 0;
      let limit = 75;
      for (const ch of line) {
        const b = enc.encode(ch).length;
        if (curBytes + b > limit) {
          out.push(cur);
          cur = ch;
          curBytes = b;
          limit = 74; // 续行多一个前导空格，因此可用 74 字节
        } else {
          cur += ch;
          curBytes += b;
        }
      }
      out.push(cur);
      return out.join('\r\n ');
    },

    /** 把分钟偏移转成 VALARM 的 TRIGGER 值，如 -P3D / -PT2H30M */
    triggerFromMinutes(min) {
      const n = Math.abs(parseInt(min, 10) || 0);
      const d = Math.floor(n / 1440);
      const h = Math.floor((n % 1440) / 60);
      const m = n % 60;
      let s = '';
      if (d) s += d + 'D';
      if (h || m) s += 'T' + (h ? h + 'H' : '') + (m ? m + 'M' : '');
      if (!s) s = 'T0M';
      return '-' + 'P' + s;
    },

    /** 单个事件的完整 VEVENT 块（未折行） */
    eventLines(item, nowMs, opts) {
      const o = opts || {};
      const durMin = o.durationMin == null ? 30 : o.durationMin;
      const dl = item.deadline;
      const L = [];
      L.push('BEGIN:VEVENT');
      L.push('UID:' + this.esc(item.uid));
      L.push('DTSTAMP:' + this.fmtUTC(nowMs));
      L.push('DTSTART:' + this.fmtUTC(dl));
      L.push('DTEND:' + this.fmtUTC(dl + durMin * 60e3));
      L.push('SUMMARY:' + this.esc(o.summary || item.title));
      if (o.description) L.push('DESCRIPTION:' + this.esc(o.description));
      if (item.url) L.push('URL:' + String(item.url).replace(/[\r\n]/g, ''));
      if (o.categories) L.push('CATEGORIES:' + this.esc(o.categories));
      L.push('TRANSP:TRANSPARENT');
      L.push('STATUS:CONFIRMED');
      L.push('SEQUENCE:0');

      const reminders = o.reminders || [];
      for (const r of reminders) {
        if (!r) continue;
        L.push('BEGIN:VALARM');
        L.push('ACTION:DISPLAY');
        L.push('DESCRIPTION:' + this.esc(o.alarmText || item.title));
        L.push('TRIGGER:' + this.triggerFromMinutes(r));
        L.push('END:VALARM');
      }
      L.push('END:VEVENT');
      return L;
    },

    /**
     * 生成完整 VCALENDAR。
     * @param {Array} items  含 {uid,title,deadline,url,...} 的条目
     * @param {Object} opt   { now, calName, reminders, durationMin, descOf, summaryOf, categoriesOf }
     * @returns {string} .ics 文本
     */
    buildCalendar(items, opt) {
      const o = opt || {};
      const now = o.now || Date.now();
      const calName = o.calName || '学习通截止提醒';
      const head = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//chaoxing-deadline//Chaoxing Deadline to Calendar//CN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:' + this.esc(calName),
        'X-WR-TIMEZONE:Asia/Shanghai',
        'X-WR-CALDESC:' + this.esc(o.calDesc || '由学习通作业倒计时脚本导出'),
      ];
      const body = [];
      for (const it of items) {
        if (!it || !it.deadline) continue;
        const lines = this.eventLines(it, now, {
          durationMin: o.durationMin == null ? 30 : o.durationMin,
          reminders: o.reminders || [],
          summary: o.summaryOf ? o.summaryOf(it) : it.title,
          description: o.descOf ? o.descOf(it) : '',
          categories: o.categoriesOf ? o.categoriesOf(it) : '',
        });
        for (const ln of lines) body.push(this.fold(ln));
      }
      const tail = ['END:VCALENDAR'];
      return head.map((l) => this.fold(l)).concat(body, tail).join(this.CRLF) + this.CRLF;
    },
  };
  /* @testable:end ics */

  /* ==========================================================================
   * 4. 网络层
   * ========================================================================== */

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opts.method || 'GET',
        url: opts.url,
        headers: opts.headers || {},
        data: opts.data,
        timeout: CFG.TIMEOUT,
        onload: (r) => resolve(r),
        ontimeout: () => reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })),
        onerror: (e) => reject(Object.assign(new Error('NETWORK'), { code: 'NETWORK', raw: e })),
      });
    });
  }

  /** 带重试与状态码校验的请求 */
  async function fetchText(url, opts) {
    const o = opts || {};
    let lastErr = null;
    for (let attempt = 0; attempt <= CFG.RETRY; attempt++) {
      try {
        const r = await gmRequest({ method: o.method, url, headers: o.headers, data: o.data });
        if (r.status >= 200 && r.status < 300) {
          return { text: r.responseText || '', finalUrl: r.finalUrl || url, status: r.status };
        }
        if (r.status >= 500 || r.status === 429) {
          lastErr = new Error('HTTP ' + r.status);
          await sleep(600 * (attempt + 1));
          continue;
        }
        throw Object.assign(new Error('HTTP ' + r.status), { code: 'HTTP', status: r.status });
      } catch (e) {
        if (e.code === 'HTTP') throw e;
        lastErr = e;
        if (attempt < CFG.RETRY) await sleep(600 * (attempt + 1));
      }
    }
    throw lastErr || new Error('REQUEST_FAILED');
  }

  async function fetchJson(url, opts) {
    const { text } = await fetchText(url, opts);
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('响应不是合法 JSON（可能登录态已失效）');
    }
  }

  /* ==========================================================================
   * 5. 学习通接口
   * ========================================================================== */

  const API = {
    /** 课程列表 */
    async courses() {
      const cached = GM_getValue(STORE.courses, null);
      if (cached && Date.now() - cached.at < CFG.COURSE_TTL) return cached.list;

      const data = await fetchJson(
        'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1'
      );

      if (!data || !Array.isArray(data.channelList)) {
        throw new Error('未获取到课程列表，请确认已登录学习通');
      }

      const seen = new Set();
      const list = [];
      for (const ch of data.channelList) {
        const c = ch && ch.content;
        if (!c || !c.course || !Array.isArray(c.course.data)) continue;
        const course = c.course.data[0];
        if (!course || !course.id) continue;
        const key = course.id + ':' + c.id;
        if (seen.has(key)) continue; // 同一课程可能出现在多个频道，去重
        seen.add(key);
        list.push({
          courseId: String(course.id),
          classId: String(c.id),
          cpi: String(c.cpi || ''),
          name: String(course.name || '未命名课程'),
          teacher: String(course.teacherfactor || ''),
          isretire: c.isretire === -1 || c.isretire === 1,
          endDate: c.endDate || '',
        });
      }

      GM_setValue(STORE.courses, { at: Date.now(), list });
      return list;
    },

    /** 取某课程的 workEnc 与 stuenc */
    async courseTokens(course) {
      const url =
        'https://mooc1.chaoxing.com/visit/stucoursemiddle' +
        `?courseid=${course.courseId}&clazzid=${course.classId}&vc=1&cpi=${course.cpi}` +
        '&ismooc2=1&v=2';
      const { text, finalUrl } = await fetchText(url);

      const enc = this._pickEnc(text, finalUrl);
      const stuenc = this._pickStuenc(text, finalUrl);
      if (!enc) throw new Error('未能提取 workEnc（课程页结构可能已变更）');
      return { enc, stuenc };
    },

    _pickEnc(html, finalUrl) {
      const patterns = [
        /id=["']workEnc["'][^>]*value=["']([a-f0-9]{32})["']/i,
        /value=["']([a-f0-9]{32})["'][^>]*id=["']workEnc["']/i,
        /workEnc\s*[:=]\s*["']([a-f0-9]{32})["']/i,
        /enc=([a-f0-9]{32})/i,
      ];
      for (const re of patterns) {
        const m = re.exec(html);
        if (m) return m[1];
      }
      const m2 = /enc=([a-f0-9]{32})/i.exec(finalUrl || '');
      return m2 ? m2[1] : null;
    },

    _pickStuenc(html, finalUrl) {
      const patterns = [
        /[?&]stuenc=([a-f0-9]{32})/i,
        /stuenc["']?\s*[:=]\s*["']([a-f0-9]{32})["']/i,
        /id=["']stuenc["'][^>]*value=["']([a-f0-9]{32})["']/i,
      ];
      for (const re of patterns) {
        const m = re.exec(html);
        if (m) return m[1];
      }
      return '';
    },

    /** 作业列表（单页 HTML） */
    async workPage(course, tokens, pageNum) {
      const base =
        'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/list' +
        `?courseId=${course.courseId}&classId=${course.classId}&cpi=${course.cpi}` +
        `&ut=s&enc=${tokens.enc}&t=${Date.now()}` +
        (tokens.stuenc ? `&stuenc=${tokens.stuenc}` : '') +
        '&isdisplaytable=2' +
        (pageNum ? `&pageNum=${pageNum}` : '');
      const { text } = await fetchText(base);
      return text;
    },

    /** 解析作业列表页 HTML → 条目数组 + 总页数 */
    parseWorkPage(html, course, tokens) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const now = Date.now();
      const items = [];

      let nodes = doc.querySelectorAll('li[data]');
      if (!nodes.length) nodes = doc.querySelectorAll('.work-list li, #workList li');

      for (const li of nodes) {
        const href = li.getAttribute('data') || '';
        if (!href) continue;

        let title = '';
        const tEl = li.querySelector('.overHidden2') || li.querySelector('.right-content p');
        if (tEl) title = tEl.textContent.trim();
        if (!title) {
          const aria = li.getAttribute('aria-label') || '';
          title = aria.split(';')[0].trim();
        }
        if (!title) title = '（无标题作业）';

        const sEl = li.querySelector('.status');
        const status = sEl ? sEl.textContent.trim() : '';

        const timeEl = li.querySelector('.time');
        const timeText = timeEl ? timeEl.textContent.replace(/\s+/g, ' ').trim() : '';
        const notOver = !!(timeEl && timeEl.classList && timeEl.classList.contains('notOver'));

        const isPeer =
          /互评/.test((li.querySelector('.label') || {}).textContent || '') ||
          !!li.querySelector('.tag.icon-hp-gy');

        // 分类
        let category = 'done';
        if (/未交|未提交/.test(status)) category = 'pending';
        else if (/待互评|待互評/.test(status)) category = 'peerreview';
        else if (/待批阅|待批閱|待批改/.test(status)) category = 'grading';
        else if (/已完成|已批改|已互评|已互評/.test(status)) category = 'done';
        else if (/互评/.test(status)) category = 'peerreview';

        // 截止时间：优先相对描述反推
        let deadline = null;
        let deadlineSource = 'unknown';
        const remain = TimeParser.parseRemaining(timeText);
        if (remain != null) {
          deadline = now + remain;
          deadlineSource = 'relative';
        } else {
          const abs = TimeParser.parseDeadlineWindow(timeText, now);
          if (abs) {
            deadline = abs;
            deadlineSource = 'absolute';
          }
        }

        // 已过期：状态仍是未交但没有 .time 元素
        const expired = deadline == null && category === 'pending' && !notOver;

        const workId = (/workId=(\d+)/.exec(href) || [])[1] || hash(title + href);

        items.push({
          uid: `cxd-hw-${course.courseId}-${course.classId}-${workId}@chaoxing-deadline`,
          kind: 'homework',
          courseId: course.courseId,
          classId: course.classId,
          courseName: course.name,
          title,
          status,
          category,
          deadline,
          deadlineSource,
          expired,
          isPeer,
          url: href.startsWith('http') ? href : 'https://mooc1.chaoxing.com' + href,
          rawTimeText: timeText,
        });
      }

      // 总页数
      let totalPages = 1;
      const pageBox = doc.querySelector('#page');
      if (pageBox) {
        pageBox.querySelectorAll('li').forEach((li) => {
          const t = li.textContent.trim();
          if (/^\d+$/.test(t)) totalPages = Math.max(totalPages, parseInt(t, 10));
        });
      }

      return { items, totalPages };
    },

    /** 某课程全部作业（自动翻页） */
    async allWorks(course) {
      const tokens = await this.courseTokens(course);
      const firstHtml = await this.workPage(course, tokens, 1);
      const first = this.parseWorkPage(firstHtml, course, tokens);
      let items = first.items;

      for (let p = 2; p <= first.totalPages && p <= 20; p++) {
        await sleep(CFG.PAGE_GAP);
        const html = await this.workPage(course, tokens, p);
        items = items.concat(this.parseWorkPage(html, course, tokens).items);
      }
      return items;
    },

    /** 考试列表 */
    async exams() {
      const url = 'https://mooc1-api.chaoxing.com/exam-ans/exam/test/examcode/examlist';
      const { text } = await fetchText(url);
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const rows = doc.querySelectorAll('table tr');
      const now = Date.now();
      const items = [];
      let idx = 0;

      for (const tr of rows) {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 4) continue;

        const cells = Array.from(tds).map((td) => td.textContent.replace(/\s+/g, ' ').trim());
        // 列序：编号 / 名称 / 时间 / 时长 / 考试状态 / 作答状态 / 分数 / 方式
        const name = cells[1];
        const timeText = cells[2] || '';
        const examState = cells[4] || '';
        const answerState = cells[5] || '';
        if (!name || /^名称$/.test(name)) continue;

        const finished = /已完成|已提交|已交/.test(answerState);
        if (finished) continue;

        const deadline = TimeParser.parseDeadlineWindow(timeText, now);
        const href = tr.querySelector('a[href]');
        const url = href ? new URL(href.getAttribute('href'), 'https://mooc1.chaoxing.com').href : '';

        items.push({
          uid: `cxd-exam-${hash(name + timeText + idx++)}@chaoxing-deadline`,
          kind: 'exam',
          courseName: '',
          title: name,
          status: examState || answerState,
          category: 'pending',
          deadline,
          deadlineSource: deadline ? 'absolute' : 'unknown',
          expired: deadline != null && deadline < now,
          url,
          rawTimeText: timeText,
        });
      }
      return items;
    },

    /** 未读通知（实验性：接口参数随平台调整，失败不影响主流程） */
    async notices() {
      const body = new URLSearchParams({
        type: '',
        notice_type: '',
        lastValue: '',
        sort: '0',
      }).toString();

      const { text } = await fetchText('https://notice.chaoxing.com/pc/notice/getNoticeList', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: body,
      });

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return [];
      }

      const list = (data && (data.notices || (data.data && data.data.notices))) || [];
      if (!Array.isArray(list)) return [];

      return list
        .filter((n) => {
          const read = n.isread;
          return read === false || read === 0 || read === '0' || read === 'false';
        })
        .map((n, i) => {
          let dl = null;
          const t = n.completeTime || n.createTime;
          if (t) {
            const parsed = typeof t === 'number' ? t : Date.parse(String(t).replace(/-/g, '/'));
            if (!isNaN(parsed)) dl = parsed;
          }
          return {
            uid: `cxd-nc-${hash(String(n.title || '') + i)}@chaoxing-deadline`,
            kind: 'notice',
            courseName: String(n.createrName || ''),
            title: String(n.title || '未读通知'),
            status: '未读',
            category: 'notice',
            deadline: dl,
            deadlineSource: dl ? 'absolute' : 'unknown',
            expired: false,
            url: 'https://notice.chaoxing.com/',
            rawTimeText: String(n.completeTime || ''),
          };
        });
    },
  };

  /* ==========================================================================
   * 6. 聚合扫描
   * ========================================================================== */

  async function scanAll(settings, onProgress) {
    const warnings = [];
    let items = [];

    const courses = await API.courses();
    const targets = settings.hideRetired ? courses.filter((c) => !c.isretire) : courses.slice();
    const retriedCount = courses.length - targets.length;

    onProgress && onProgress({ stage: 'courses', done: 0, total: targets.length });

    let done = 0;
    const tasks = targets.map((course) => async () => {
      const r = await API.allWorks(course);
      done++;
      onProgress && onProgress({ stage: 'works', done, total: targets.length, course: course.name });
      return r;
    });

    const results = await pool(tasks, CFG.CONCURRENCY);
    results.forEach((r, i) => {
      if (r.ok) {
        items = items.concat(r.value);
      } else {
        warnings.push({
          course: targets[i].name,
          message: r.error && r.error.message ? r.error.message : String(r.error),
        });
      }
    });

    if (settings.withExams) {
      onProgress && onProgress({ stage: 'exams' });
      try {
        const ex = await API.exams();
        items = items.concat(ex);
      } catch (e) {
        warnings.push({ course: '考试', message: e.message || String(e) });
      }
    }

    if (settings.withNotices) {
      onProgress && onProgress({ stage: 'notices' });
      try {
        const nc = await API.notices();
        items = items.concat(nc);
      } catch (e) {
        warnings.push({ course: '通知', message: e.message || String(e) });
      }
    }

    items = filterItems(items, settings);

    // 排序：有截止时间的按时间升序，无时间的排最后
    items.sort((a, b) => {
      if (a.deadline && b.deadline) return a.deadline - b.deadline;
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      return String(a.title).localeCompare(String(b.title), 'zh');
    });

    return { items, warnings, scannedAt: Date.now(), courseCount: targets.length, retiredSkipped: retriedCount };
  }

  function filterItems(items, s) {
    return items.filter((it) => {
      if (it.kind === 'homework') {
        if (it.category === 'pending' && !it.expired) return true;
        if (it.category === 'pending' && it.expired) return !!s.includeExpired;
        if (it.category === 'peerreview') return !!s.includePeerReview && !it.expired;
        if (it.category === 'grading') return !!s.includeGrading;
        return false;
      }
      if (it.kind === 'exam') return true;
      if (it.kind === 'notice') return true;
      return false;
    });
  }

  /* ==========================================================================
   * 7. 导出
   * ========================================================================== */

  const KIND_LABEL = { homework: '作业', exam: '考试', notice: '通知' };

  function summaryOf(it) {
    const left = it.deadline ? fmtDuration(it.deadline - Date.now()) : '无截止时间';
    return `[${it.courseName || KIND_LABEL[it.kind]}] ${it.title}`;
  }

  function descOf(it) {
    const lines = [];
    lines.push(`课程：${it.courseName || '—'}`);
    lines.push(`类型：${KIND_LABEL[it.kind] || it.kind}`);
    if (it.status) lines.push(`状态：${it.status}`);
    if (it.deadline) lines.push(`截止：${fmtDateTime(it.deadline)}`);
    if (it.rawTimeText) lines.push(`平台原文：${it.rawTimeText}`);
    if (it.url) lines.push(`直达：${it.url}`);
    lines.push('');
    lines.push('由「学习通作业倒计时」导出');
    return lines.join('\n');
  }

  function buildIcs(items, settings) {
    const withDeadline = items.filter((it) => it.deadline);
    return ICS.buildCalendar(withDeadline, {
      now: Date.now(),
      calName: '学习通截止提醒',
      calDesc: '由学习通作业倒计时脚本导出，共 ' + withDeadline.length + ' 项',
      durationMin: CFG.EVENT_DURATION_MIN,
      reminders: settings.reminders,
      summaryOf,
      descOf,
      categoriesOf: (it) => KIND_LABEL[it.kind] || '',
    });
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  }

  function memoText(items) {
    const lines = ['# 学习通待办清单', '', `导出时间：${new Date().toLocaleString('zh-CN')}`, ''];
    const groups = { homework: '作业', exam: '考试', notice: '通知' };
    for (const k of ['homework', 'exam', 'notice']) {
      const sub = items.filter((i) => i.kind === k);
      if (!sub.length) continue;
      lines.push(`## ${groups[k]}（${sub.length}）`, '');
      for (const it of sub) {
        const left = it.deadline ? `${fmtDateTime(it.deadline)} · 剩 ${fmtDuration(it.deadline - Date.now())}` : '无截止时间';
        lines.push(`- [ ] **${it.courseName || '—'}** ${it.title} —— ${left}`);
        if (it.url) lines.push(`  ${it.url}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  /* ==========================================================================
   * 8. UI
   * ========================================================================== */

  function injectStyle() {
    GM_addStyle(`
.cxd-fab{position:fixed;right:22px;bottom:26px;z-index:2147483000;width:52px;height:52px;border-radius:50%;
  background:linear-gradient(135deg,#4f7cff,#3457d5);color:#fff;display:flex;align-items:center;justify-content:center;
  font-size:22px;cursor:pointer;box-shadow:0 6px 20px rgba(52,87,213,.35);user-select:none;
  transition:transform .16s ease,box-shadow .16s ease;font-family:system-ui,-apple-system,"PingFang SC",sans-serif}
.cxd-fab:hover{transform:translateY(-2px);box-shadow:0 10px 26px rgba(52,87,213,.45)}
.cxd-fab .cxd-badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;
  background:#e5484d;color:#fff;font-size:11px;line-height:20px;text-align:center;font-weight:600;border:2px solid #fff}
.cxd-fab .cxd-badge.hide{display:none}

.cxd-panel{position:fixed;right:22px;bottom:90px;z-index:2147483001;width:400px;max-height:72vh;
  background:#fff;border-radius:14px;box-shadow:0 18px 50px rgba(15,23,42,.18),0 2px 8px rgba(15,23,42,.08);
  display:none;flex-direction:column;overflow:hidden;border:1px solid #e6e9f0;
  font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1a2233}
.cxd-panel.open{display:flex}

.cxd-head{display:flex;align-items:center;gap:8px;padding:14px 16px 12px;border-bottom:1px solid #eef1f6}
.cxd-head h1{margin:0;font-size:14px;font-weight:600;letter-spacing:.2px;flex:1}
.cxd-head .cxd-sub{font-size:11px;color:#8b95a7;font-weight:400;margin-top:2px}
.cxd-icon-btn{border:0;background:transparent;cursor:pointer;color:#8b95a7;font-size:18px;line-height:1;
  padding:4px 6px;border-radius:6px}
.cxd-icon-btn:hover{background:#f2f4f8;color:#3b4557}

.cxd-stats{display:flex;gap:6px;padding:10px 16px 0}
.cxd-stat{flex:1;background:#f7f9fc;border-radius:9px;padding:8px 10px;text-align:center}
.cxd-stat b{display:block;font-size:17px;line-height:1.2}
.cxd-stat span{font-size:10.5px;color:#8b95a7}
.cxd-stat.red b{color:#e5484d}
.cxd-stat.orange b{color:#e08b0a}
.cxd-stat.blue b{color:#3457d5}

.cxd-tabs{display:flex;gap:4px;padding:10px 12px 8px;overflow-x:auto;scrollbar-width:none}
.cxd-tabs::-webkit-scrollbar{display:none}
.cxd-tab{flex:0 0 auto;border:0;background:#f2f4f8;color:#5b6478;font-size:11.5px;padding:5px 10px;
  border-radius:20px;cursor:pointer;white-space:nowrap;font-family:inherit}
.cxd-tab.on{background:#3457d5;color:#fff}
.cxd-tab .n{opacity:.65;margin-left:3px}

.cxd-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:2px 10px 10px}
.cxd-empty{text-align:center;color:#9aa4b6;font-size:12.5px;padding:36px 12px;line-height:1.7}
.cxd-warn{background:#fff8e6;border:1px solid #f7e2b0;color:#8a6314;font-size:11px;border-radius:8px;
  padding:8px 10px;margin:4px 6px 8px;line-height:1.6}

.cxd-item{display:flex;gap:9px;padding:9px 8px;border-radius:9px;cursor:default}
.cxd-item:hover{background:#f7f9fc}
.cxd-dot{flex:0 0 auto;width:5px;border-radius:3px;background:#cfd6e4;margin-top:2px}
.cxd-item.u .cxd-dot{background:#e5484d}
.cxd-item.s .cxd-dot{background:#e08b0a}
.cxd-item.n .cxd-dot{background:#30a46c}
.cxd-item.dim{opacity:.5}
.cxd-body{flex:1;min-width:0}
.cxd-title{font-size:12.5px;line-height:1.45;color:#1a2233;display:block;text-decoration:none;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cxd-title:hover{color:#3457d5;text-decoration:underline}
.cxd-meta{font-size:10.5px;color:#8b95a7;margin-top:3px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.cxd-tag{background:#eef1f6;color:#5b6478;padding:1px 5px;border-radius:4px;font-size:10px}
.cxd-tag.exam{background:#fdeaea;color:#c93b40}
.cxd-tag.notice{background:#eaf3fd;color:#2b6cb0}
.cxd-tag.peer{background:#f3ebfd;color:#7a45c4}
.cxd-left{font-size:11px;font-weight:600;white-space:nowrap}
.cxd-item.u .cxd-left{color:#e5484d}
.cxd-item.s .cxd-left{color:#e08b0a}
.cxd-item.n .cxd-left{color:#30a46c}
.cxd-item.dim .cxd-left{color:#9aa4b6}

.cxd-foot{border-top:1px solid #eef1f6;padding:9px 12px;display:flex;gap:6px;background:#fbfcfe}
.cxd-btn{flex:1 1 0;border:1px solid #dfe4ee;background:#fff;color:#3b4557;font-size:11.5px;padding:7px 6px;
  border-radius:8px;cursor:pointer;font-family:inherit;transition:.14s;white-space:nowrap}
.cxd-btn:hover{border-color:#3457d5;color:#3457d5}
.cxd-btn.primary{background:#3457d5;border-color:#3457d5;color:#fff}
.cxd-btn.primary:hover{background:#2b49b8}
.cxd-btn:disabled{opacity:.5;cursor:not-allowed}

.cxd-progress{font-size:11px;color:#8b95a7;padding:10px 16px;text-align:center}

.cxd-settings{padding:12px 16px;overflow-y:auto;font-size:12px}
.cxd-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;
  border-bottom:1px dashed #eef1f6}
.cxd-row:last-child{border-bottom:0}
.cxd-row label{color:#3b4557}
.cxd-row .hint{font-size:10.5px;color:#9aa4b6;display:block;margin-top:2px}
.cxd-switch{position:relative;width:36px;height:20px;flex:0 0 auto;cursor:pointer}
.cxd-switch input{opacity:0;width:0;height:0;position:absolute}
.cxd-switch i{position:absolute;inset:0;background:#cfd6e4;border-radius:20px;transition:.18s}
.cxd-switch i:before{content:"";position:absolute;width:16px;height:16px;left:2px;top:2px;
  background:#fff;border-radius:50%;transition:.18s;box-shadow:0 1px 3px rgba(0,0,0,.2)}
.cxd-switch input:checked + i{background:#3457d5}
.cxd-switch input:checked + i:before{transform:translateX(16px)}

.cxd-rem{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px}
.cxd-rem button{border:1px solid #dfe4ee;background:#fff;color:#5b6478;font-size:11px;padding:4px 9px;
  border-radius:14px;cursor:pointer;font-family:inherit}
.cxd-rem button.on{background:#3457d5;border-color:#3457d5;color:#fff}
@media (max-width:520px){
  .cxd-panel{right:8px;left:8px;width:auto;bottom:84px;max-height:76vh}
  .cxd-fab{right:14px;bottom:18px}
}
`);
  }

  const state = {
    items: [],
    warnings: [],
    filter: 'all',
    loading: false,
    view: 'list',
    scannedAt: 0,
    timer: null,
  };

  function loadSettings() {
    const s = GM_getValue(STORE.settings, null);
    return Object.assign({}, DEFAULTS, s || {});
  }
  function saveSettings(s) {
    GM_setValue(STORE.settings, s);
  }

  function urgencyClass(it) {
    if (!it.deadline) return 'n';
    const left = it.deadline - Date.now();
    if (left <= 0) return 'n dim';
    if (left <= CFG.URGENT) return 'u';
    if (left <= CFG.SOON) return 's';
    return 'n';
  }

  function buildUI() {
    const fab = document.createElement('div');
    fab.className = 'cxd-fab';
    fab.innerHTML =
    '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M16 3v4M8 3v4M3 10.5h18"/>' +
    '</svg><span class="cxd-badge hide">0</span>';

    const panel = document.createElement('div');
    panel.className = 'cxd-panel';
    panel.innerHTML = `
      <div class="cxd-head">
        <div style="flex:1">
          <h1>学习通 · 截止倒计时</h1>
          <div class="cxd-sub" id="cxd-sub">点击「刷新」开始扫描</div>
        </div>
        <button class="cxd-icon-btn" id="cxd-set-btn" title="设置">⚙</button>
        <button class="cxd-icon-btn" id="cxd-close" title="关闭">×</button>
      </div>
      <div class="cxd-stats">
        <div class="cxd-stat red"><b id="cxd-s-urgent">0</b><span>24h 内</span></div>
        <div class="cxd-stat orange"><b id="cxd-s-week">0</b><span>72h 内</span></div>
        <div class="cxd-stat blue"><b id="cxd-s-all">0</b><span>全部待办</span></div>
      </div>
      <div class="cxd-tabs" id="cxd-tabs"></div>
      <div class="cxd-list" id="cxd-list"></div>
      <div class="cxd-foot">
        <button class="cxd-btn primary" id="cxd-ics">导出日历</button>
        <button class="cxd-btn" id="cxd-md">复制清单</button>
        <button class="cxd-btn" id="cxd-refresh">刷新</button>
      </div>
    `;

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    fab.addEventListener('click', () => {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) {
        render();
        if (!state.items.length && !state.loading) refresh();
      }
    });
    $('#cxd-close').addEventListener('click', () => panel.classList.remove('open'));
    $('#cxd-refresh').addEventListener('click', () => refresh());
    $('#cxd-set-btn').addEventListener('click', () => toggleSettings());
    $('#cxd-ics').addEventListener('click', onExportIcs);
    $('#cxd-md').addEventListener('click', onCopyMemo);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') panel.classList.remove('open');
    });

    // 倒计时每 30 秒刷新一次
    state.timer = setInterval(() => {
      if (panel.classList.contains('open') && state.view === 'list') renderList();
    }, 30000);
  }

  function toggleSettings() {
    state.view = state.view === 'settings' ? 'list' : 'settings';
    render();
  }

  function render() {
    if (state.view === 'settings') return renderSettings();
    renderList();
    renderTabs();
    renderStats();
  }

  function renderStats() {
    const now = Date.now();
    const pend = state.items.filter((i) => !i.expired);
    const urgent = pend.filter((i) => i.deadline && i.deadline - now <= CFG.URGENT && i.deadline > now);
    const week = pend.filter((i) => i.deadline && i.deadline - now <= CFG.SOON && i.deadline > now);
    $('#cxd-s-urgent').textContent = urgent.length;
    $('#cxd-s-week').textContent = week.length;
    $('#cxd-s-all').textContent = pend.length;

    const badge = $('.cxd-fab .cxd-badge');
    if (urgent.length) {
      badge.textContent = urgent.length;
      badge.classList.remove('hide');
    } else {
      badge.classList.add('hide');
    }

    const sub = $('#cxd-sub');
    if (state.loading) sub.textContent = '正在扫描…';
    else if (state.scannedAt) {
      const t = new Date(state.scannedAt);
      sub.textContent = `上次扫描 ${pad2(t.getHours())}:${pad2(t.getMinutes())} · ${state.items.length} 项`;
    } else sub.textContent = '点击「刷新」开始扫描';
  }

  const TABS = [
    { k: 'all', label: '全部' },
    { k: 'pending', label: '未交' },
    { k: 'peerreview', label: '待互评' },
    { k: 'grading', label: '待批阅' },
    { k: 'exam', label: '考试' },
    { k: 'notice', label: '通知' },
    { k: 'expired', label: '已过期' },
  ];

  function matchTab(it, k) {
    if (k === 'all') return true;
    if (k === 'exam') return it.kind === 'exam';
    if (k === 'notice') return it.kind === 'notice';
    if (k === 'expired') return !!it.expired;
    if (it.kind !== 'homework') return false;
    if (k === 'pending') return it.category === 'pending' && !it.expired;
    return it.category === k;
  }

  function renderTabs() {
    const box = $('#cxd-tabs');
    box.innerHTML = '';
    for (const t of TABS) {
      const n = state.items.filter((i) => matchTab(i, t.k)).length;
      if (!n && t.k !== 'all') continue;
      const b = document.createElement('button');
      b.className = 'cxd-tab' + (state.filter === t.k ? ' on' : '');
      b.innerHTML = `${t.label}<span class="n">${n}</span>`;
      b.addEventListener('click', () => {
        state.filter = t.k;
        renderTabs();
        renderList();
      });
      box.appendChild(b);
    }
  }

  function renderList() {
    const box = $('#cxd-list');
    if (state.loading && !state.items.length) {
      box.innerHTML = '<div class="cxd-progress">正在扫描全部课程，请稍候…</div>';
      return;
    }
    if (!state.items.length) {
      box.innerHTML = `<div class="cxd-empty">${
        state.scannedAt ? '没有符合条件的待办 🎉' : '还没有扫描过<br>点击下方「刷新」开始'
      }</div>`;
      return;
    }

    const shown = state.items.filter((i) => matchTab(i, state.filter));
    box.innerHTML = '';

    if (state.warnings.length) {
      const w = document.createElement('div');
      w.className = 'cxd-warn';
      w.innerHTML =
        '⚠ 部分课程未取到：' +
        state.warnings.slice(0, 3).map((x) => `${x.course}（${x.message}）`).join('；') +
        (state.warnings.length > 3 ? ` 等 ${state.warnings.length} 项` : '');
      box.appendChild(w);
    }

    if (!shown.length) {
      const e = document.createElement('div');
      e.className = 'cxd-empty';
      e.textContent = '该分类下暂无条目';
      box.appendChild(e);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const it of shown) {
      const row = document.createElement('div');
      row.className = 'cxd-item ' + urgencyClass(it);

      const left = it.deadline
        ? it.deadline > Date.now()
          ? fmtDuration(it.deadline - Date.now())
          : '已截止'
        : '—';

      const tagCls = it.kind === 'exam' ? 'exam' : it.kind === 'notice' ? 'notice' : '';
      const kindTag =
        it.kind === 'exam'
          ? '<span class="cxd-tag exam">考试</span>'
          : it.kind === 'notice'
          ? '<span class="cxd-tag notice">通知</span>'
          : it.isPeer
          ? '<span class="cxd-tag peer">互评</span>'
          : '';

      row.innerHTML = `
        <div class="cxd-dot"></div>
        <div class="cxd-body">
          <a class="cxd-title" href="${it.url || '#'}" target="_blank" rel="noopener"
             title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</a>
          <div class="cxd-meta">
            ${kindTag}
            ${it.courseName ? `<span>${escapeHtml(it.courseName)}</span>` : ''}
            ${it.status ? `<span class="cxd-tag">${escapeHtml(it.status)}</span>` : ''}
            ${it.deadline ? `<span>${fmtDateTime(it.deadline)}</span>` : ''}
          </div>
        </div>
        <div class="cxd-left">${left}</div>
      `;
      frag.appendChild(row);
    }
    box.appendChild(frag);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderSettings() {
    const s = loadSettings();
    const box = $('#cxd-list');
    const tabs = $('#cxd-tabs');
    tabs.innerHTML = '';
    box.innerHTML = `
      <div class="cxd-settings">
        <div class="cxd-row">
          <div><label>启用提醒</label><span class="hint">选中的提前量会写进日历事件的闹钟</span></div>
        </div>
        <div class="cxd-rem" id="cxd-rem">
          ${[
            [-15, '15 分钟'],
            [-60, '1 小时'],
            [-120, '2 小时'],
            [-24 * 60, '1 天'],
            [-3 * 24 * 60, '3 天'],
          ]
            .map(
              ([v, t]) =>
                `<button data-v="${v}" class="${s.reminders.includes(v) ? 'on' : ''}">${t}</button>`
            )
            .join('')}
        </div>
        ${switchRow('withExams', '包含考试', '考试列表也一并导出', s.withExams)}
        ${switchRow('includePeerReview', '包含待互评', '别人作业等你评的，也有截止时间', s.includePeerReview)}
        ${switchRow('includeGrading', '包含待批阅', '已提交但老师还没批的', s.includeGrading)}
        ${switchRow('withNotices', '包含未读通知', '实验性：接口可能随平台调整而失效', s.withNotices)}
        ${switchRow('includeExpired', '包含已过期', '默认隐藏，避免干扰', s.includeExpired)}
        ${switchRow('hideRetired', '跳过已结课', '减少无效请求，降低风控风险', s.hideRetired)}
        <div class="cxd-row" style="padding-top:12px">
          <button class="cxd-btn primary" id="cxd-set-back">返回列表</button>
        </div>
      </div>
    `;

    box.querySelectorAll('.cxd-rem button').forEach((b) => {
      b.addEventListener('click', () => {
        const v = parseInt(b.dataset.v, 10);
        const cur = loadSettings();
        const i = cur.reminders.indexOf(v);
        if (i >= 0) cur.reminders.splice(i, 1);
        else cur.reminders.push(v);
        cur.reminders.sort((a, b2) => b2 - a);
        saveSettings(cur);
        b.classList.toggle('on');
      });
    });

    box.querySelectorAll('.cxd-switch input').forEach((inp) => {
      inp.addEventListener('change', () => {
        const cur = loadSettings();
        cur[inp.dataset.k] = inp.checked;
        saveSettings(cur);
      });
    });

    $('#cxd-set-back').addEventListener('click', () => {
      state.view = 'list';
      render();
      refresh();
    });
  }

  function switchRow(key, title, hint, val) {
    return `
      <div class="cxd-row">
        <div><label>${title}</label><span class="hint">${hint}</span></div>
        <label class="cxd-switch">
          <input type="checkbox" data-k="${key}" ${val ? 'checked' : ''}>
          <i></i>
        </label>
      </div>`;
  }

  /* ==========================================================================
   * 9. 行为
   * ========================================================================== */

  async function refresh(force) {
    if (state.loading) return;
    const s = loadSettings();

    if (!force) {
      const cached = GM_getValue(STORE.scan, null);
      if (cached && Date.now() - cached.at < CFG.SCAN_TTL) {
        state.items = cached.items;
        state.warnings = cached.warnings || [];
        state.scannedAt = cached.at;
        render();
        return;
      }
    }

    state.loading = true;
    render();
    try {
      const res = await scanAll(s, (p) => {
        const sub = $('#cxd-sub');
        if (!sub) return;
        if (p.stage === 'courses') sub.textContent = '正在获取课程列表…';
        else if (p.stage === 'works')
          sub.textContent = `正在扫描作业 ${p.done}/${p.total}：${p.course || ''}`;
        else if (p.stage === 'exams') sub.textContent = '正在获取考试列表…';
        else if (p.stage === 'notices') sub.textContent = '正在获取未读通知…';
      });
      state.items = res.items;
      state.warnings = res.warnings;
      state.scannedAt = res.scannedAt;
      GM_setValue(STORE.scan, { at: res.scannedAt, items: res.items, warnings: res.warnings });
    } catch (e) {
      state.warnings = [{ course: '扫描', message: e.message || String(e) }];
      console.error('[chaoxing-deadline]', e);
    } finally {
      state.loading = false;
      render();
    }
  }

  function onExportIcs() {
    const s = loadSettings();
    const items = state.items.filter((i) => i.deadline);
    if (!items.length) {
      alert('当前没有带截止时间的条目。先点「刷新」扫描一次。');
      return;
    }
    const ics = buildIcs(state.items, s);
    const d = new Date();
    const name = `学习通截止提醒-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}.ics`;
    download(name, ics, 'text/calendar');
  }

  async function onCopyMemo() {
    const text = memoText(state.items);
    try {
      await navigator.clipboard.writeText(text);
      const btn = $('#cxd-md');
      const old = btn.textContent;
      btn.textContent = '已复制 ✓';
      setTimeout(() => (btn.textContent = old), 1500);
    } catch (e) {
      download('学习通待办清单.md', text, 'text/markdown');
    }
  }

  /* ==========================================================================
   * 10. 启动
   * ========================================================================== */

  function boot() {
    // 只在顶层窗口注入，学习通课程页有大量 iframe
    try {
      if (window.top !== window.self) return;
    } catch (e) {
      return;
    }
    if (document.getElementById('cxd-fab')) return;

    injectStyle();
    buildUI();
    render();

    // 自动用缓存渲染一次，让面板打开即有内容
    const cached = GM_getValue(STORE.scan, null);
    if (cached) {
      state.items = cached.items || [];
      state.warnings = cached.warnings || [];
      state.scannedAt = cached.at || 0;
      render();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 调试入口：控制台可访问
  window.__CXD__ = { API, ICS, TimeParser, scanAll, state, buildIcs, getSettings: loadSettings };
})();
