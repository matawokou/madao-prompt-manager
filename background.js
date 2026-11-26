/* Prompt Manager v2 - background service worker */
'use strict';

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (e) {}
  try {
    chrome.contextMenus.create({
      id: 'pm-save-selection',
      title: '存为提示词',
      contexts: ['selection']
    });
  } catch (e) {}
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'pm-save-selection') return;
  try {
    const text = info.selectionText || '';
    const pending = {
      title: autoTitle(text),
      content: text,
      category: '通用',
      from: 'contextmenu',
      ts: Date.now()
    };
    // 若右键时和 ComfyUI 沾边，顺手抓最近一次生成图当封面（失败静默跳过，不阻塞保存）
    if (info.selectionText) {
      const img = await Promise.race([
        grabLatestComfyImage(tab),
        new Promise((r) => setTimeout(() => r(null), 9000))
      ]);
      if (img) pending.imgData = img;
    }
    await chrome.storage.local.set({ pm_pending_prompt: pending });
    // 跳转到管理页（已有则聚焦并触发弹窗，没有则新开）
    const url = chrome.runtime.getURL('manager.html');
    const tabs = await chrome.tabs.query({ url: url + '*' });
    if (tabs.length) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      try { await chrome.windows.update(tabs[0].windowId, { focused: true }); } catch (e) {}
    } else {
      chrome.tabs.create({ url });
    }
  } catch (e) {}
});

// 智能命名：取第一行有效文本，去 Markdown 标记，超长截断
function autoTitle(text) {
  const t = (text || '').trim();
  if (!t) return '未命名 ' + new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  let line = t.split('\n').map((s) => s.trim()).filter(Boolean)[0] || t;
  line = line.replace(/^#+\s*/, '').replace(/[*_`>#\[\]]/g, '').trim();
  if (!line) line = t.slice(0, 30);
  if (line.length > 30) line = line.slice(0, 30) + '…';
  return line;
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-manager') {
    chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
  } else if (command === 'open-sidepanel') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) await chrome.sidePanel.open({ tabId: tab.id });
    } catch (e) {}
  }
});

// 找已打开的 ComfyUI 标签页（不用 url 匹配模式——Edge 对 pattern 校验不稳定）
async function findComfyTab() {
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => {
    const u = String(t.url || '');
    return u.startsWith('http://127.0.0.1:8188') || u.startsWith('http://localhost:8188');
  });
}

// 抓 ComfyUI 最近一次生成成功的输出图，压成缩略图 dataURL；拿不到返回 null
// 只读接口（/history、/view），不动队列不触发生成
async function grabLatestComfyImage(fromTab) {
  try {
    // 优先用右键所在标签页（本来就是 ComfyUI 时省一次查找），否则全局找
    let tab = fromTab && String(fromTab.url || '').startsWith('http://127.0.0.1:8188') ? fromTab
      : (fromTab && String(fromTab.url || '').startsWith('http://localhost:8188') ? fromTab : null);
    if (!tab) tab = await findComfyTab();
    if (!tab) return null;
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',   // 主世界同源 fetch，绕 CORS（与发送提示词同一条通道）
      func: async () => {
        try {
          const hist = await fetch('http://127.0.0.1:8188/history?max_items=12', { cache: 'no-store' }).then((r) => r.json());
          const entries = Object.entries(hist || {});
          if (!entries.length) return null;
          // prompt[0] 是执行序号，升序追加 → 倒序取最新的成功且带图的任务
          entries.sort((a, b) => ((b[1].prompt || [])[0] || 0) - ((a[1].prompt || [])[0] || 0));
          for (const [, e] of entries) {
            const st = e.status || {};
            if (st.status_str !== 'success' && !st.completed) continue;
            const outputs = e.outputs || {};
            let picked = null;
            // 优先 SaveImage 的正式输出（type=output），其次预览图（temp）
            for (const o of Object.values(outputs)) {
              for (const im of o.images || []) {
                if (im.type === 'output') { picked = im; break; }
              }
              if (picked) break;
            }
            if (!picked) {
              for (const o of Object.values(outputs)) {
                for (const im of o.images || []) { picked = im; break; }
                if (picked) break;
              }
            }
            if (!picked) continue;
            const qs = 'filename=' + encodeURIComponent(picked.filename) +
              '&subfolder=' + encodeURIComponent(picked.subfolder || '') +
              '&type=' + encodeURIComponent(picked.type || 'output');
            const blob = await fetch('http://127.0.0.1:8188/view?' + qs, { cache: 'no-store' }).then((r) => r.blob());
            const bmp = await createImageBitmap(blob);
            const scale = Math.min(1, 480 / (bmp.width || 1));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round((bmp.width || 1) * scale));
            c.height = Math.max(1, Math.round((bmp.height || 1) * scale));
            c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
            const url = c.toDataURL('image/jpeg', 0.82);
            if (bmp.close) bmp.close();
            return url;
          }
          return null;
        } catch (e) { return null; }
      }
    });
    const r = results && results[0] && results[0].result;
    return typeof r === 'string' && r.startsWith('data:image') ? r : null;
  } catch (e) { return null; }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'pm-ping') {
    reply({ ok: true, swVersion: chrome.runtime.getManifest().version });
    return;
  }
  if (msg.type === 'pm-send-comfyui') {
    (async () => {
      const text = String(msg.text || '');
      const mode = msg.mode === 'append' ? 'append' : 'replace';
      // 找 ComfyUI 标签页；没有就后台新开一个等它加载
      let tab = await findComfyTab();
      if (!tab) {
        const nt = await chrome.tabs.create({ url: 'http://127.0.0.1:8188', active: false });
        await new Promise((r) => setTimeout(r, 6000));
        tab = await chrome.tabs.get(nt.id);
      }
      const tabId = tab.id;
      let lastErr = null;
      // 页面没加载完时最多重试 5 次、每次间隔 2 秒
      for (let i = 0; i < 5; i++) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',   // 必须进主世界：同源 fetch + 读页面全局
            func: async (t, md) => {
              // ===== 通道 A：在 ComfyUI 页面内同源调用 Lora Manager 接口（无 CORS 问题）=====
              try {
                const reg = await fetch('http://127.0.0.1:8188/api/lm/get-registry').then((r) => r.json());
                if (reg && reg.success && reg.data && reg.data.nodes) {
                  const entries = Object.values(reg.data.nodes);
                  const hasText = (n) => (n.widget_names || []).includes('text') ||
                    (n.capabilities && n.capabilities.has_text_widget);
                  let pool = entries.filter((n) => hasText(n) && (n.mode === undefined || n.mode === 0));
                  if (!pool.length) pool = entries.filter(hasText);
                  const score = (n) => {
                    const s = ((n.title || '') + ' ' + (n.type_name || '') + ' ' + (n.comfy_class || '')).toLowerCase();
                    let v = 0;
                    if (/positive|正向/.test(s)) v += 6;
                    if (/prompt|multiline|多行/.test(s)) v += 3;
                    if (/negative|反向|negative/.test(s)) v -= 6;
                    if (/text\s*multiline|textencode|cliptextencode/i.test((n.type_name || '') + ' ' + (n.comfy_class || ''))) v += 2;
                    return v;
                  };
                  pool.sort((a, b) => score(b) - score(a));
                  const target = pool[0];
                  if (target) {
                    const ref = { node_id: target.id };
                    if (target.graph_id) ref.graph_id = target.graph_id;
                    const up = await fetch('http://127.0.0.1:8188/api/lm/update-node-widget', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'inject_text', value: t, mode: md, node_ids: [ref] })
                    }).then((r) => r.json());
                    if (up && up.success) {
                      return { ok: true, filled: (target.title || target.type_name) + '（LM通道·' + (md === 'append' ? '追加' : '替换') + '）' };
                    }
                    return { ok: false, error: 'LM更新失败: ' + JSON.stringify(up).slice(0, 120) };
                  }
                  return { ok: false, error: 'LM注册表里没有文本节点' };
                }
                // 注册表不可用 → 继续走画布填充
              } catch (e) { /* LM 接口不在/失败 → 画布路径 */ }

              // ===== 通道 B：LiteGraph 画布 API =====
              const app = window.app || (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app);
              let graphErr = '';
              if (app && app.graph && app.graph._nodes) {
                const nodes = app.graph._nodes || [];
                const hits = [];
                for (const n of nodes) {
                  const type = String(n.type || '');
                  if (!/CLIPTextEncode|TextEncode|Prompt|Text\s*Multiline/i.test(type)) continue;
                  for (const w of (n.widgets || [])) {
                    if (w.name === 'text' && typeof w.value === 'string') {
                      hits.push({ w, node: n, title: n.title || n.type });
                    }
                  }
                }
                if (hits.length) {
                  const empty = hits.find((h) => !h.w.value.trim());
                  const target = empty || hits[0];
                  target.w.value = t;
                  if (target.w.onInput) try { target.w.onInput(t); } catch (e) {}
                  if (target.w.callback) try { target.w.callback(t); } catch (e) {}
                  if (target.node.onResize) try { target.node.onResize(); } catch (e) {}
                  if (app.graph.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
                  return { ok: true, filled: target.title + '（画布通道）', total: hits.length };
                }
                graphErr = '画布里没找到提示词输入框';
              }
              // ===== 通道 C：DOM 文本框兜底 =====
              const tas = Array.from(document.querySelectorAll(
                '[data-testid="dom-widget-textarea"], textarea.comfy-multiline-input, textarea[placeholder*="rompt" i], .comfy-widget textarea'
              )).filter((el) => !el.disabled && el.offsetParent !== null);
              if (tas.length) {
                const empty = tas.find((el) => !el.value.trim());
                const el2 = empty || tas[0];
                el2.value = t;
                el2.dispatchEvent(new Event('input', { bubbles: true }));
                el2.dispatchEvent(new Event('change', { bubbles: true }));
                return { ok: true, filled: '提示词输入框（DOM通道）', total: tas.length };
              }
              return { ok: false, error: graphErr || (app ? 'ComfyUI 画布未加载' : 'ComfyUI 未就绪（页面可能还没加载完）') };
            },
            args: [text, mode]
          });
          const res = results && results[0] && results[0].result;
          // 成功，或是「没找到输入框」这类重试也无解的错误 → 直接返回
          if (res && (res.ok || !/未就绪|未加载/.test(res.error || ''))) {
            if (res && res.ok) {
              // 把 ComfyUI 标签调到前台，方便确认和排队
              try {
                await chrome.tabs.update(tabId, { active: true });
                const t2 = await chrome.tabs.get(tabId);
                await chrome.windows.update(t2.windowId, { focused: true });
              } catch (e) {}
            }
            reply({ ok: true, result: res });
            return;
          }
          lastErr = res || { ok: false, error: 'ComfyUI 未就绪' };
          await new Promise((r) => setTimeout(r, 2000));
        } catch (e) {
          // 注入异常（页面还没加载完）→ 短暂等待后重试
          lastErr = { ok: false, error: e.message };
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      reply({ ok: true, result: lastErr });
    })();
    return true;
  }
  if (msg.type === 'pm-insert') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) { reply({ ok: false, error: '没有活动标签页' }); return; }
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (text) => {
            const el = document.activeElement;
            const editable = el && (el.tagName === 'TEXTAREA' ||
              (el.tagName === 'INPUT' && /text|search/.test(el.type || '')) ||
              el.isContentEditable);
            if (!editable) return false;
            if (el.isContentEditable) {
              const sel = window.getSelection();
              if (sel && sel.rangeCount) {
                const r = sel.getRangeAt(0);
                r.deleteContents();
                r.insertNode(document.createTextNode(text));
                r.collapse(false);
                sel.removeAllRanges();
                sel.addRange(r);
              } else {
                el.textContent = (el.textContent || '') + text;
              }
            } else {
              const start = el.selectionStart == null ? el.value.length : el.selectionStart;
              const end = el.selectionEnd == null ? el.value.length : el.selectionEnd;
              el.value = el.value.slice(0, start) + text + el.value.slice(end);
              const pos = start + text.length;
              el.setSelectionRange(pos, pos);
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            el.focus();
            return true;
          },
          args: [String(msg.text || '')]
        });
        reply({ ok: true, inserted: !!(results && results[0] && results[0].result) });
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});
