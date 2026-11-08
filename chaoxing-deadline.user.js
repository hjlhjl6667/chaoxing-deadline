// ==UserScript==
// @name         学习通作业倒计时 · 日历订阅
// @name:en      Chaoxing Deadline → Calendar
// @namespace    https://github.com/hjlhjl6667/chaoxing-deadline
// @version      1.2.0
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
    MAX_PAGES: 50,           // 单课程最多翻页数，防止异常分页死循环
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
    seen: 'cxd_seen_v1',
    boot: 'cxd_boot_v1',      // 是否已经记录过一轮「首次见到」时间
  };

  const DAY_MS = 864e5;

  const DEFAULTS = {
    reminders: [-3 * 24 * 60, -24 * 60, -120],
    withExams: true,
    withNotices: true,
    includePeerReview: true,
    includeGrading: true,
    includeExpired: false,
    hideRetired: false,     // 默认扫描全部课程（含已结课），不漏课
    preciseMode: false,      // 走作业详情页取绝对时间（请求量大）
    gradingMaxAgeDays: 30,   // 待批阅超过这么多天就隐藏，0 = 不限制
  };

  /* ==========================================================================
   * 1. 通用工具
   * ========================================================================== */

  /** Shadow DOM 根节点：所有查找优先在这里，彻底避开学习通全局样式 */
  let UI_ROOT = null;
  const $ = (sel, root) => (root || UI_ROOT || document).querySelector(sel);
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
    /** 课程列表：多来源合并，尽量不漏课 */
    async courses(force) {
      const cached = GM_getValue(STORE.courses, null);
      if (!force && cached && Date.now() - cached.at < CFG.COURSE_TTL) return cached.list;

      const bag = new Map();
      const sources = [];

      const add = (c, from) => {
        if (!c || !c.courseId || !c.classId) return;
        const key = c.courseId + ':' + c.classId;
        const old = bag.get(key);
        if (old) {
          if ((!old.name || old.name === '未命名课程') && c.name) old.name = c.name;
          if (!old.cpi && c.cpi) old.cpi = c.cpi;
          if (!old.teacher && c.teacher) old.teacher = c.teacher;
          if (c.isretire) old.isretire = true;
          if (old.sources.indexOf(from) < 0) old.sources.push(from);
          return;
        }
        bag.set(key, Object.assign({}, c, { sources: [from] }));
      };

      // 来源 1：backclazzdata（主接口，返回频道列表）
      try {
        const data = await fetchJson(
          'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1'
        );
        const chs = (data && data.channelList) || [];
        for (const ch of chs) {
          const c = ch && ch.content;
          if (!c) continue;
          // 一个频道里可能挂多门课，必须全部取出（旧版只看 [0]，会漏课）
          const raw = c.course && c.course.data;
          const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
          for (const course of arr) {
            if (!course || !course.id) continue;
            add(
              {
                courseId: String(course.id),
                classId: String(c.id || course.clazzid || ''),
                cpi: String(c.cpi || ''),
                name: String(course.name || '未命名课程'),
                teacher: String(course.teacherfactor || ''),
                isretire: c.isretire === -1 || c.isretire === 1,
                endDate: c.endDate || '',
              },
              '频道'
            );
          }
        }
        sources.push('频道 ' + chs.length);
      } catch (e) {
        sources.push('频道失败');
      }

      // 来源 2：课程页 HTML，补上频道接口没返回的课
      try {
        const n0 = bag.size;
        const { text } = await fetchText('https://mooc1.chaoxing.com/visit/courselistdata', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          data: 'courseType=1&courseFolderId=0&baseEducation=0&superstarClass=0',
        });
        for (const c of this._parseCourseLinks(text)) add(c, '课程页');
        sources.push('课程页 +' + (bag.size - n0));
      } catch (e) {
        sources.push('课程页失败');
      }

      const list = Array.from(bag.values());
      if (!list.length) throw new Error('未获取到课程列表，请确认已登录学习通');

      GM_setValue(STORE.courses, { at: Date.now(), list, sources });
      return list;
    },

    /** 从任意学习通页面 HTML 里抽出 courseid / clazzid */
    _parseCourseLinks(html) {
      const out = [];
      let doc;
      try {
        doc = new DOMParser().parseFromString(html, 'text/html');
      } catch (e) {
        return out;
      }
      doc.querySelectorAll('a[href*="courseid"], a[href*="courseId"]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        const q = new URLSearchParams(href.split('?')[1] || '');
        const courseId = q.get('courseid') || q.get('courseId');
        const classId = q.get('clazzid') || q.get('classId');
        if (!courseId || !classId) return;
        out.push({
          courseId: String(courseId),
          classId: String(classId),
          cpi: String(q.get('cpi') || ''),
          name: (a.textContent || '').replace(/\s+/g, ' ').trim() || '未命名课程',
          teacher: '',
          isretire: false,
          endDate: '',
        });
      });
      return out;
    },

    /** 取某课程的 workEnc 与 stuenc（两个域名都试，不同版本课程挂在不同站点） */
    async courseTokens(course) {
      const hosts = ['https://mooc1.chaoxing.com', 'https://mooc2-ans.chaoxing.com'];
      let lastErr = null;
      for (const host of hosts) {
        try {
          const url =
            host +
            '/visit/stucoursemiddle' +
            `?courseid=${course.courseId}&clazzid=${course.classId}&vc=1&cpi=${course.cpi}` +
            '&ismooc2=1&v=2';
          const { text, finalUrl } = await fetchText(url);
          const enc = this._pickEnc(text, finalUrl);
          if (!enc) {
            lastErr = new Error('未能提取 workEnc');
            continue;
          }
          return { enc, stuenc: this._pickStuenc(text, finalUrl), host };
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('未能提取 workEnc（课程页结构可能已变更）');
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

    /** 作业列表接口路径随站点不同 */
    _workPath(host) {
      return /mooc2-ans/.test(host) ? '/mooc2/work/list' : '/mooc-ans/mooc2/work/list';
    },

    /** 作业列表（单页 HTML） */
    async workPage(course, tokens, pageNum) {
      const host = tokens.host || 'https://mooc1.chaoxing.com';
      const url =
        host +
        this._workPath(host) +
        `?courseId=${course.courseId}&classId=${course.classId}&cpi=${course.cpi}` +
        `&ut=s&enc=${tokens.enc}&t=${Date.now()}` +
        (tokens.stuenc ? `&stuenc=${tokens.stuenc}` : '') +
        '&isdisplaytable=2' +
        '&pageNum=' +
        (pageNum || 1);
      const { text } = await fetchText(url);
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

      // 总页数：数字页码 + pageNum 链接都要看
      let totalPages = 1;
      const pageBox = doc.querySelector('#page');
      if (pageBox) {
        pageBox.querySelectorAll('li').forEach((li) => {
          const t = li.textContent.trim();
          if (/^\d+$/.test(t)) totalPages = Math.max(totalPages, parseInt(t, 10));
        });
        pageBox.querySelectorAll('a[href]').forEach((a) => {
          const m = /pageNum=(\d+)/.exec(a.getAttribute('href') || '');
          if (m) totalPages = Math.max(totalPages, parseInt(m[1], 10));
        });
      }

      return { items, totalPages };
    },

    /** 某课程全部作业（自动翻页 + 换站重试） */
    async allWorks(course) {
      const tokens = await this.courseTokens(course);
      let firstHtml = await this.workPage(course, tokens, 1);
      let first = this.parseWorkPage(firstHtml, course, tokens);

      if (!first.items.length) {
        const altHost =
          tokens.host === 'https://mooc2-ans.chaoxing.com'
            ? 'https://mooc1.chaoxing.com'
            : 'https://mooc2-ans.chaoxing.com';
        try {
          const alt = { enc: tokens.enc, stuenc: tokens.stuenc, host: altHost };
          const html = await this.workPage(course, alt, 1);
          const parsed = this.parseWorkPage(html, course, alt);
          if (parsed.items.length) {
            tokens.host = altHost;
            firstHtml = html;
            first = parsed;
          }
        } catch (e) {
          /* 换站失败就按原结果走 */
        }
      }

      let items = first.items;
      const pages = Math.min(first.totalPages || 1, CFG.MAX_PAGES);

      for (let p = 2; p <= pages; p++) {
        await sleep(CFG.PAGE_GAP);
        try {
          const html = await this.workPage(course, tokens, p);
          items = items.concat(this.parseWorkPage(html, course, tokens).items);
        } catch (e) {
          break;
        }
      }

      // 去重：分页边界可能重复返回同一条
      const seen = new Set();
      const uniq = [];
      for (const it of items) {
        if (seen.has(it.uid)) continue;
        seen.add(it.uid);
        uniq.push(it);
      }

      return { items: uniq, pages, host: tokens.host, htmlLen: firstHtml.length };
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
    const diag = [];
    let items = [];

    const courses = await API.courses();
    const targets = settings.hideRetired ? courses.filter((c) => !c.isretire) : courses.slice();
    const retiredAll = courses.filter((c) => c.isretire).length;

    onProgress && onProgress({ stage: 'courses', done: 0, total: targets.length });

    let done = 0;
    const tasks = targets.map((course) => async () => {
      const r = await API.allWorks(course);
      done++;
      onProgress && onProgress({
        stage: 'works', done, total: targets.length, course: course.name,
      });
      return r;
    });

    // 单个课程失败时也要推进进度，否则进度条会卡住
    const safeTasks = tasks.map((t, i) => async () => {
      try {
        return await t();
      } catch (e) {
        done++;
        onProgress && onProgress({
          stage: 'works', done, total: targets.length, course: targets[i].name,
        });
        throw e;
      }
    });

    const results = await pool(safeTasks, CFG.CONCURRENCY);
    results.forEach((r, i) => {
      const c = targets[i];
      if (r.ok) {
        items = items.concat(r.value.items);
        diag.push({
          name: c.name,
          ok: true,
          count: r.value.items.length,
          pages: r.value.pages,
          host: r.value.host,
          retired: !!c.isretire,
        });
      } else {
        const msg = r.error && r.error.message ? r.error.message : String(r.error);
        warnings.push({ course: c.name, message: msg });
        diag.push({ name: c.name, ok: false, count: 0, pages: 0, error: msg, retired: !!c.isretire });
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

    // 待批阅作业多半没有截止时间可用，只能靠「第一次扫到它的时间」推算它躺了多久。
    // 每次扫描都用当前结果重建这张表，旧条目自然被淘汰，不会无限增长。
    const seenOld = loadSeen();
    const seenNow = Date.now();
    const booted = !!GM_getValue(STORE.boot, 0);
    const seen = {};
    items.forEach((it) => {
      if (it.kind === 'homework' && it.category === 'grading') {
        // 升级后第一次扫描时，这些作业早就躺在那儿了，没有历史可查，
        // 按「已过期 31 天」起算，让它们立刻隐藏，而不是再等一个月。
        seen[it.uid] = seenOld[it.uid] || (booted ? seenNow : seenNow - 31 * DAY_MS);
      }
    });
    GM_setValue(STORE.seen, seen);
    if (!booted) GM_setValue(STORE.boot, seenNow);

    items = filterItems(items, settings);

    // 排序分两档：还没截止的排前面（近的在前），已截止的排后面（近的在前）。
    // 待批阅 / 已过期作业的截止时间都在过去，不该挤在真正要交的作业上面。
    const sortNow = Date.now();
    const isFuture = (it) => (it.deadline && it.deadline > sortNow ? 0 : 1);
    items.sort((a, b) => {
      const tier = isFuture(a) - isFuture(b);
      if (tier) return tier;
      if (isFuture(a) === 0) return a.deadline - b.deadline;      // 未截止：越近越前
      if (a.deadline && b.deadline) return b.deadline - a.deadline; // 已截止：越近越前
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      return String(a.title).localeCompare(String(b.title), 'zh');
    });

    return {
      items,
      warnings,
      diag,
      scannedAt: Date.now(),
      courseCount: targets.length,
      totalCourses: courses.length,
      retiredAll,
      retiredSkipped: courses.length - targets.length,
    };
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

  const CSS_TEXT = `
:host{all:initial}
.cxd-fab{position:fixed;right:22px;bottom:26px;width:54px;height:54px;border-radius:18px;
  background:linear-gradient(140deg,#5b86ff,#3457d5);color:#fff;display:flex;align-items:center;
  justify-content:center;cursor:pointer;box-shadow:0 8px 24px rgba(52,87,213,.36);
  transition:transform .18s ease,box-shadow .18s ease;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.cxd-fab:hover{transform:translateY(-3px);box-shadow:0 12px 32px rgba(52,87,213,.46)}
.cxd-badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 5px;
  border-radius:10px;background:#f04438;color:#fff;font-size:11px;line-height:16px!important;
  text-align:center;font-weight:700;border:2px solid #fff;box-sizing:border-box;
  font-variant-numeric:tabular-nums}
.cxd-badge.hide{display:none}

.cxd-panel{position:fixed;right:22px;bottom:94px;width:420px;max-height:76vh;background:#fff;
  border-radius:18px;box-shadow:0 24px 64px rgba(15,23,42,.20),0 4px 14px rgba(15,23,42,.06);
  display:none;flex-direction:column;overflow:hidden;border:1px solid rgba(15,23,42,.07);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  color:#101828;font-size:13px;line-height:1.5!important;text-align:left;letter-spacing:normal}
.cxd-panel.open{display:flex}
.cxd-panel *{box-sizing:border-box}

/* 核心修复：清空学习通全局样式对按钮的污染，这是标签文字被压扁的根因 */
.cxd-panel button{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;
  align-items:center;justify-content:center;font-family:inherit;font-size:12px;
  line-height:1!important;color:inherit;white-space:nowrap;overflow:visible;text-align:center;
  vertical-align:middle;-webkit-appearance:none;appearance:none;letter-spacing:normal}

.cxd-head{display:flex;align-items:flex-start;gap:10px;padding:16px 16px 12px}
.cxd-h1{font-size:15px!important;font-weight:700;letter-spacing:.2px;line-height:1.3!important}
.cxd-sub{font-size:11.5px!important;color:#8b95a7;margin-top:3px;line-height:1.4!important;
  max-width:262px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cxd-acts{display:flex;gap:2px;margin-left:auto;flex:0 0 auto}
.cxd-ico{width:30px;height:30px;border-radius:9px;color:#8b95a7!important;padding:0!important}
.cxd-ico:hover{background:#f1f4fa;color:#334155!important}
.cxd-ico svg{display:block;pointer-events:none}

.cxd-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:0 16px 12px}
.cxd-stat{background:#f7f9fd;border:1px solid #eef2f9;border-radius:12px;padding:9px 6px;text-align:center}
.cxd-stat b{display:block;font-size:19px;line-height:1.25!important;font-weight:700;
  font-variant-numeric:tabular-nums;color:#334155}
.cxd-stat span{font-size:10.5px;color:#8b95a7;line-height:1.4!important}
.cxd-stat.red b{color:#f04438}
.cxd-stat.amber b{color:#e08b0a}
.cxd-stat.blue b{color:#3457d5}

.cxd-tabs{display:flex;gap:6px;padding:0 14px 10px;overflow-x:auto;overflow-y:hidden}
.cxd-tabs:empty{display:none;padding:0}
.cxd-tabs::-webkit-scrollbar{height:0}
.cxd-tab{height:28px!important;min-height:28px!important;padding:0 11px!important;border-radius:14px!important;
  background:#f2f5fa!important;color:#5b6478!important;font-size:12px!important;
  display:inline-flex!important;align-items:center!important;justify-content:center!important;
  line-height:1!important;white-space:nowrap!important;overflow:visible!important;
  transition:background .15s,color .15s}
.cxd-tab:hover{background:#eaeef6!important}
.cxd-tab.on{background:#3457d5!important;color:#fff!important;font-weight:600}
.cxd-tab .n{opacity:.62;margin-left:4px;font-variant-numeric:tabular-nums}
.cxd-tab.on .n{opacity:.86}

.cxd-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 8px 8px}
.cxd-list::-webkit-scrollbar{width:8px}
.cxd-list::-webkit-scrollbar-thumb{background:#dfe5ef;border-radius:4px}
.cxd-list::-webkit-scrollbar-thumb:hover{background:#cbd4e2}
.cxd-empty{text-align:center;color:#9aa4b6;font-size:12.5px!important;padding:40px 16px;line-height:1.8!important}
.cxd-warn{background:#fff8e6;border:1px solid #f7e2b0;color:#8a6314;font-size:11.5px!important;
  border-radius:10px;padding:9px 11px;margin:2px 6px 8px;line-height:1.6!important}

.cxd-item{display:flex;gap:10px;padding:10px;border-radius:12px;border:1px solid transparent;
  transition:background .14s,border-color .14s}
.cxd-item:hover{background:#f8fafd;border-color:#eef2f9}
.cxd-dot{flex:0 0 auto;width:3px;border-radius:2px;background:#d3dae6;margin:2px 0}
.cxd-item.u .cxd-dot{background:#f04438}
.cxd-item.s .cxd-dot{background:#f59e0b}
.cxd-item.n .cxd-dot{background:#12b76a}
.cxd-item.dim{opacity:.55}
.cxd-body{flex:1;min-width:0}
.cxd-title{font-size:13px!important;line-height:1.45!important;color:#101828;text-decoration:none;
  display:-webkit-box!important;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cxd-title:hover{color:#3457d5}
.cxd-meta{font-size:11px!important;color:#8b95a7;margin-top:5px;display:flex;gap:6px;flex-wrap:wrap;
  align-items:center;line-height:1.5!important}
.cxd-tag{background:#f1f4fa;color:#5b6478;padding:1px 6px;border-radius:5px;
  font-size:10.5px!important;line-height:1.7!important}
.cxd-tag.exam{background:#fdecec;color:#c93b40}
.cxd-tag.notice{background:#eaf3fd;color:#2b6cb0}
.cxd-tag.peer{background:#f4ecfe;color:#7a45c4}
.cxd-left{font-size:11.5px!important;font-weight:700;white-space:nowrap;padding-top:1px;
  font-variant-numeric:tabular-nums;flex:0 0 auto}
.cxd-item.u .cxd-left{color:#f04438}
.cxd-item.s .cxd-left{color:#e08b0a}
.cxd-item.n .cxd-left{color:#12b76a}
.cxd-item.dim .cxd-left{color:#9aa4b6}

.cxd-foot{padding:10px 12px;display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:8px;
  border-top:1px solid #eef2f9;background:#fbfcfe}
.cxd-btn{height:34px!important;border-radius:10px!important;border:1px solid #e2e8f2!important;
  background:#fff!important;color:#42506b!important;font-size:12px!important;transition:.15s}
.cxd-btn:hover{border-color:#3457d5!important;color:#3457d5!important}
.cxd-btn.primary{background:#3457d5!important;border-color:#3457d5!important;color:#fff!important;font-weight:600}
.cxd-btn.primary:hover{background:#2b49b8!important;color:#fff!important}
.cxd-btn:disabled{opacity:.5;cursor:not-allowed}

.cxd-progress{font-size:12px;color:#8b95a7;padding:34px 16px;text-align:center;line-height:1.8}
.cxd-bar{height:3px;background:#eef2f9;border-radius:2px;margin-top:12px;overflow:hidden}
.cxd-bar i{display:block;height:100%;background:linear-gradient(90deg,#5b86ff,#3457d5);
  border-radius:2px;transition:width .3s ease}

.cxd-settings{padding:4px 16px 14px;overflow-y:auto}
.cxd-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;
  border-bottom:1px solid #f1f4fa}
.cxd-row:last-child{border-bottom:0}
.cxd-row label{color:#26324a;font-size:12.5px!important;line-height:1.5!important}
.cxd-row .hint{font-size:11px!important;color:#9aa4b6;display:block;margin-top:2px;line-height:1.45!important}
.cxd-switch{position:relative;width:38px;height:22px;flex:0 0 auto;cursor:pointer;display:block}
.cxd-switch input{opacity:0;width:0;height:0;position:absolute}
.cxd-switch i{position:absolute;inset:0;background:#d7dde8;border-radius:22px;transition:.2s}
.cxd-switch i:before{content:"";position:absolute;width:18px;height:18px;left:2px;top:2px;
  background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.22)}
.cxd-switch input:checked + i{background:#3457d5}
.cxd-switch input:checked + i:before{transform:translateX(16px)}

.cxd-rem{display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 6px}
.cxd-rem button{height:30px!important;padding:0 12px!important;border:1px solid #e2e8f2!important;
  background:#fff!important;color:#5b6478!important;font-size:12px!important;border-radius:15px!important}
.cxd-rem button.on{background:#3457d5!important;border-color:#3457d5!important;color:#fff!important}

.cxd-diag{padding:2px 14px 14px}
.cxd-dsum{font-size:12px!important;color:#5b6478;line-height:1.8!important;padding:6px 2px 10px}
.cxd-dsum b{color:#101828}
.cxd-drow{display:flex;gap:10px;align-items:baseline;padding:7px 2px;border-bottom:1px solid #f4f6fa}
.cxd-dname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:#26324a;font-size:12px}
.cxd-dnum{font-variant-numeric:tabular-nums;font-weight:700;color:#12b76a;flex:0 0 auto;font-size:12px}
.cxd-dnum.zero{color:#9aa4b6}
.cxd-dnum.bad{color:#f04438}
.cxd-dwhy{font-size:10.5px;color:#9aa4b6;padding:0 2px 6px}

@media (max-width:520px){
  .cxd-panel{right:8px;left:8px;width:auto;bottom:88px;max-height:78vh}
  .cxd-fab{right:14px;bottom:18px}
}
`;

  function injectStyle(root) {
    const st = document.createElement('style');
    st.textContent = CSS_TEXT;
    root.appendChild(st);
  }

  const state = {
    items: [],
    warnings: [],
    diag: [],
    filter: 'all',
    loading: false,
    view: 'list',
    scannedAt: 0,
    courseCount: 0,
    totalCourses: 0,
    progress: { done: 0, total: 0 },
    timer: null,
  };

  function loadSeen() {
    const v = GM_getValue(STORE.seen, null);
    return v && typeof v === 'object' ? v : {};
  }

  /* @testable:start grading */
  /** 这条待批阅作业已经「躺着」多少天：优先用截止时间，其次用首次扫到它的时间 */
  function gradingAgeDays(it, seen, now) {
    if (it.deadline) return Math.max(0, (now - it.deadline) / DAY_MS);
    const first = seen[it.uid];
    if (first) return Math.max(0, (now - first) / DAY_MS);
    return 0;
  }

  /** 过滤超过 limit 天仍未批阅的作业。limit 为 0 表示不限制 */
  function pickVisible(items, limit, seen, now) {
    const days = Number(limit) || 0;
    if (!days) return items;
    return items.filter((it) => {
      if (it.kind !== 'homework' || it.category !== 'grading') return true;
      return gradingAgeDays(it, seen, now) <= days;
    });
  }
  /* @testable:end grading */

  /** 列表、标签计数、顶部统计统一走这里，设置一改立刻生效，不用重新扫 */
  function visibleItems() {
    return pickVisible(state.items, loadSettings().gradingMaxAgeDays, loadSeen(), Date.now());
  }

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

  const ICON = {
    cal:
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 10.5h18"/>' +
      '<path d="M8 15h3"/></svg>',
    cog:
      '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34' +
      ' 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.4a1.7 1.7 0 0 0-1.87.34' +
      'l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4' +
      'h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06' +
      'a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56' +
      ' 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9' +
      'a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>',
    list:
      '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    x:
      '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M18 6L6 18M6 6l12 12"/></svg>',
  };

  function buildUI() {
    // 整块 UI 挂在 Shadow DOM 里：学习通的全局 CSS 进不来，按钮不会再被压扁
    const host = document.createElement('div');
    host.id = 'cxd-host';
    host.style.cssText = 'all:initial';
    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    UI_ROOT = root;
    injectStyle(root);

    const fab = document.createElement('div');
    fab.className = 'cxd-fab';
    fab.id = 'cxd-fab';
    fab.innerHTML = ICON.cal + '<span class="cxd-badge hide">0</span>';

    const panel = document.createElement('div');
    panel.className = 'cxd-panel';
    panel.innerHTML = `
      <div class="cxd-head">
        <div style="min-width:0">
          <div class="cxd-h1">学习通 · 截止倒计时</div>
          <div class="cxd-sub" id="cxd-sub">点击「刷新」开始扫描</div>
        </div>
        <div class="cxd-acts">
          <button class="cxd-ico" id="cxd-diag-btn" title="诊断：每门课抓到多少条">${ICON.list}</button>
          <button class="cxd-ico" id="cxd-set-btn" title="设置">${ICON.cog}</button>
          <button class="cxd-ico" id="cxd-close" title="关闭">${ICON.x}</button>
        </div>
      </div>
      <div class="cxd-stats">
        <div class="cxd-stat red"><b id="cxd-s-urgent">0</b><span>24h 内</span></div>
        <div class="cxd-stat amber"><b id="cxd-s-week">0</b><span>72h 内</span></div>
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

    root.appendChild(fab);
    root.appendChild(panel);
    document.documentElement.appendChild(host);

    fab.addEventListener('click', () => {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) {
        render();
        if (!state.items.length && !state.loading) refresh();
      }
    });
    $('#cxd-close').addEventListener('click', () => panel.classList.remove('open'));
    $('#cxd-refresh').addEventListener('click', () => refresh(true));
    $('#cxd-set-btn').addEventListener('click', toggleSettings);
    $('#cxd-diag-btn').addEventListener('click', toggleDiag);
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

  function toggleDiag() {
    state.view = state.view === 'diag' ? 'list' : 'diag';
    render();
  }

  function render() {
    if (state.view === 'settings') return renderSettings();
    if (state.view === 'diag') return renderDiag();
    renderList();
    renderTabs();
    renderStats();
  }

  function renderStats() {
    const now = Date.now();
    const vis = visibleItems();
    const pend = vis.filter((i) => !i.expired);
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
    if (state.loading) {
      sub.textContent = state.progress.total
        ? `正在扫描 ${state.progress.done}/${state.progress.total} 门课程…`
        : '正在获取课程列表…';
    } else if (state.scannedAt) {
      const t = new Date(state.scannedAt);
      const hidden = state.items.length - vis.length;
      sub.textContent =
        `${pad2(t.getHours())}:${pad2(t.getMinutes())} 扫描 · ` +
        `${state.courseCount} 门课 · ${vis.length} 项` +
        (hidden ? ` · 隐藏 ${hidden} 项` : '');
      sub.title = hidden
        ? `另有 ${hidden} 项待批阅超过 ${loadSettings().gradingMaxAgeDays} 天，已隐藏（设置里可调）`
        : '';
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
    const vis = visibleItems();
    for (const t of TABS) {
      const n = vis.filter((i) => matchTab(i, t.k)).length;
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

  function renderDiag() {
    const box = $('#cxd-list');
    $('#cxd-tabs').innerHTML = '';
    const d = state.diag || [];
    if (!d.length) {
      box.innerHTML =
        '<div class="cxd-empty">还没有扫描记录<br>先点「刷新」扫一次，再回来看每门课抓到多少条</div>';
      return;
    }
    const withItems = d.filter((x) => x.ok && x.count > 0).length;
    const zero = d.filter((x) => x.ok && x.count === 0).length;
    const failed = d.filter((x) => !x.ok).length;

    box.innerHTML = `
      <div class="cxd-diag">
        <div class="cxd-dsum">
          共扫描 <b>${d.length}</b> 门课程，<b>${withItems}</b> 门抓到条目${
      zero ? `，<b>${zero}</b> 门为 0 条` : ''
    }${failed ? `，<b>${failed}</b> 门失败` : ''}。<br>
          0 条不一定有错（可能确实没作业）；但如果你确定它有，说明解析没命中，把这份诊断发到 issue 里。
        </div>
        <button class="cxd-btn primary" id="cxd-diag-copy" style="width:100%;margin-bottom:10px">复制诊断信息</button>
        ${d
          .map(
            (x) => `
          <div class="cxd-drow">
            <div class="cxd-dname" title="${escapeHtml(x.name)}">${escapeHtml(x.name)}${
              x.retired ? ' · 已结课' : ''
            }</div>
            <div class="cxd-dnum ${x.ok ? (x.count ? '' : 'zero') : 'bad'}">${
              x.ok ? x.count + ' 条' : '失败'
            }</div>
          </div>
          ${!x.ok ? `<div class="cxd-dwhy">${escapeHtml(x.error || '')}</div>` : ''}`
          )
          .join('')}
      </div>`;

    const cp = $('#cxd-diag-copy');
    if (cp) cp.addEventListener('click', onCopyDiag);
  }

  function renderList() {
    const box = $('#cxd-list');
    if (state.loading && !state.items.length) {
      const p = state.progress;
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      box.innerHTML = `<div class="cxd-progress">
        正在扫描全部课程，请稍候…<br>
        <span style="font-size:11.5px">${p.total ? p.done + ' / ' + p.total + ' 门' : '获取课程列表'}</span>
        <div class="cxd-bar"><i style="width:${pct}%"></i></div>
      </div>`;
      return;
    }
    const vis = visibleItems();
    if (!vis.length) {
      box.innerHTML = `<div class="cxd-empty">${
        state.scannedAt ? '没有符合条件的待办 🎉' : '还没有扫描过<br>点击下方「刷新」开始'
      }</div>`;
      return;
    }

    const shown = vis.filter((i) => matchTab(i, state.filter));
    box.innerHTML = '';

    if (state.warnings.length) {
      const w = document.createElement('div');
      w.className = 'cxd-warn';
      w.innerHTML =
        '⚠ 部分课程未取到：' +
        state.warnings.slice(0, 3).map((x) => `${escapeHtml(x.course)}（${escapeHtml(x.message)}）`).join('；') +
        (state.warnings.length > 3 ? ` 等 ${state.warnings.length} 项，详见「诊断」` : '');
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
        <div class="cxd-row" style="padding:6px 0 12px">
          <div><label style="font-size:13.5px">扫描与提醒设置</label><span class="hint">改动即时保存</span></div>
          <button class="cxd-btn primary" id="cxd-set-back"
                  style="height:30px!important;width:auto;padding:0 14px;flex:0 0 auto">重新扫描</button>
        </div>
        <div class="cxd-row" style="border-bottom:0;padding-bottom:0">
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
        <div class="cxd-row" style="border-bottom:0;padding-bottom:0">
          <div><label>待批阅保留时长</label><span class="hint">躺了这么久还没批的，自动从列表隐藏</span></div>
        </div>
        <div class="cxd-rem" id="cxd-grade-age">
          ${[
            [0, '不限制'],
            [14, '14 天'],
            [30, '30 天'],
            [60, '60 天'],
          ]
            .map(
              ([v, t]) =>
                `<button data-v="${v}" class="${Number(s.gradingMaxAgeDays) === v ? 'on' : ''}">${t}</button>`
            )
            .join('')}
        </div>
        ${switchRow('withNotices', '包含未读通知', '实验性：接口可能随平台调整而失效', s.withNotices)}
        ${switchRow('includeExpired', '包含已过期', '默认隐藏，避免干扰', s.includeExpired)}
        ${switchRow('hideRetired', '跳过已结课', '默认关闭：结课课程里也可能有没交的作业', s.hideRetired)}
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

    box.querySelectorAll('#cxd-grade-age button').forEach((b) => {
      b.addEventListener('click', () => {
        const cur = loadSettings();
        cur.gradingMaxAgeDays = parseInt(b.dataset.v, 10) || 0;
        saveSettings(cur);
        box
          .querySelectorAll('#cxd-grade-age button')
          .forEach((x) => x.classList.toggle('on', x === b));
        renderStats();
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
      refresh(true);
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
        state.diag = cached.diag || [];
        state.scannedAt = cached.at;
        state.courseCount = cached.courseCount || 0;
        render();
        return;
      }
    }

    state.loading = true;
    state.progress = { done: 0, total: 0 };
    render();
    try {
      const res = await scanAll(s, (p) => {
        if (p.stage === 'works') state.progress = { done: p.done, total: p.total };
        const sub = $('#cxd-sub');
        if (!sub) return;
        if (p.stage === 'courses') sub.textContent = '正在获取课程列表…';
        else if (p.stage === 'works')
          sub.textContent = `正在扫描 ${p.done}/${p.total}：${p.course || ''}`;
        else if (p.stage === 'exams') sub.textContent = '正在获取考试列表…';
        else if (p.stage === 'notices') sub.textContent = '正在获取未读通知…';
        if (state.view === 'list' && state.loading && !state.items.length) renderList();
      });
      state.items = res.items;
      state.warnings = res.warnings;
      state.diag = res.diag || [];
      state.scannedAt = res.scannedAt;
      state.courseCount = res.courseCount || 0;
      state.totalCourses = res.totalCourses || res.courseCount || 0;
      GM_setValue(STORE.scan, {
        at: res.scannedAt,
        items: res.items,
        warnings: res.warnings,
        diag: res.diag || [],
        courseCount: res.courseCount || 0,
      });
    } catch (e) {
      state.warnings = [{ course: '扫描', message: e.message || String(e) }];
      console.error('[chaoxing-deadline]', e);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function onCopyDiag() {
    const d = state.diag || [];
    const lines = [
      '学习通作业倒计时 · 诊断信息',
      '时间：' + new Date().toLocaleString('zh-CN'),
      '脚本版本：1.1.0',
      'UA：' + navigator.userAgent,
      '课程数：' + d.length,
      '',
    ];
    for (const x of d) {
      lines.push(
        (x.ok ? x.count + ' 条' : '失败') +
          '\t' +
          (x.name || '未命名') +
          (x.retired ? '（已结课）' : '') +
          (x.ok ? '' : '：' + (x.error || ''))
      );
    }
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      const btn = $('#cxd-diag-copy');
      if (btn) {
        const old = btn.textContent;
        btn.textContent = '已复制 ✓';
        setTimeout(() => (btn.textContent = old), 1500);
      }
    } catch (e) {
      download('学习通诊断.txt', text, 'text/plain');
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
    if (document.getElementById('cxd-host')) return;

    buildUI();
    render();

    // 自动用缓存渲染一次，让面板打开即有内容
    const cached = GM_getValue(STORE.scan, null);
    if (cached) {
      state.items = cached.items || [];
      state.warnings = cached.warnings || [];
      state.diag = cached.diag || [];
      state.scannedAt = cached.at || 0;
      state.courseCount = cached.courseCount || 0;
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
