/* Prompt Manager v2 - 内容脚本：轻量注入工具栏 + 快捷键调用 */
(function () {
  'use strict';
  if (window.__pmInjected) return;
  window.__pmInjected = true;

  function toast(msg) {
    let t = document.getElementById('pm-inline-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'pm-inline-toast';
      t.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;background:#2d3436;color:#fff;padding:9px 16px;border-radius:8px;font:13px/1.5 "Microsoft YaHei",sans-serif;box-shadow:0 3px 12px rgba(0,0,0,.3)';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    clearTimeout(t._h);
    t._h = setTimeout(() => t.remove(), 2200);
  }

  // 接收来自 popup / sidepanel 的插入请求（content 侧兜底，主路径在 background）
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg) return;
    if (msg.type === 'pm-toast') { toast(String(msg.text || '')); reply && reply({ ok: true }); }
  });
})();
