/* PM UI 公共辅助 */
(function (global) {
  'use strict';
  const SVG = 'xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

  const ICONS = {
    search: `<svg ${SVG} viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`,
    plus: `<svg ${SVG} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`,
    download: `<svg ${SVG} viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M4 20h16"/></svg>`,
    upload: `<svg ${SVG} viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>`,
    folder: `<svg ${SVG} viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>`,
    trash: `<svg ${SVG} viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>`,
    copy: `<svg ${SVG} viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/></svg>`,
    star: `<svg ${SVG} viewBox="0 0 24 24"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9z"/></svg>`,
    close: `<svg ${SVG} viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>`
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function toast(msg, type) {
    let box = document.getElementById('pm-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'pm-toast';
      box.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:999999;padding:10px 20px;border-radius:8px;color:#fff;font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);transition:opacity .25s;max-width:80vw;text-align:center';
      document.body.appendChild(box);
    }
    box.style.background = type === 'error' ? '#d63031' : (type === 'success' ? '#00b894' : '#2d3436');
    box.textContent = msg;
    box.style.opacity = '1';
    clearTimeout(box._t);
    box._t = setTimeout(() => { box.style.opacity = '0'; }, type === 'error' ? 9000 : 2600);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); resolve(); } catch (e) { reject(e); }
      ta.remove();
    });
  }

  function variables(content, values) {
    values = values || {};
    return String(content || '').replace(/\{\{([^}]+)\}\}/g, (m, key) => {
      const v = values[key.trim()];
      return v == null || v === '' ? m : v;
    });
  }

  // 智能命名：取第一行有效文本，去 Markdown 标记，超长截断
  function autoTitle(text) {
    const t = (text || '').trim();
    if (!t) return '';
    let line = t.split('\n').map((s) => s.trim()).filter(Boolean)[0] || t;
    line = line.replace(/^#+\s*/, '').replace(/[*_`>#\[\]]/g, '').trim();
    if (!line) line = t.slice(0, 30);
    if (line.length > 30) line = line.slice(0, 30) + '…';
    return line;
  }

  global.PMUI = { ICONS, esc, toast, copyText, variables, autoTitle };
})(window);
