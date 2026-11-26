'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  let all = [];

  async function init() {
    try {
      const info = await PMStorage.init();
      all = await PMStorage.getAll();
      $('count').textContent = all.length + ' 条';
      render('');
    } catch (e) {
      $('status').textContent = '读取失败：' + e.message;
      $('count').textContent = '错误';
    }
  }

  function render(q) {
    q = (q || '').trim().toLowerCase();
    const list = $('list');
    const items = q
      ? all.filter((p) => [p.title, p.content, (p.tags || []).join(' ')].join(' ').toLowerCase().includes(q))
      : all.slice(0, 40);
    if (!items.length) {
      list.innerHTML = '<div id="status">' + (q ? '没有匹配的提示词' : '还没有提示词') + '</div>';
      return;
    }
    list.innerHTML = items.slice(0, 60).map((p) => `
      <div class="item" data-id="${PMUI.esc(p.id)}">
        <h4>${PMUI.esc(p.title || '未命名')}</h4>
        <p>${PMUI.esc(p.content || '')}</p>
        <div class="row">
          <span class="badge">${PMUI.esc(p.category || '通用')}</span>
          <button class="btn" data-act="copy">${PMUI.ICONS.copy} 复制</button>
          <button class="btn" data-act="insert">插入输入框</button>
        </div>
      </div>`).join('');
    list.querySelectorAll('.item').forEach((el) => {
      el.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const p = all.find((x) => x.id === el.dataset.id);
        if (!p) return;
        const text = PMUI.variables(p.content, {});
        if (btn.dataset.act === 'copy') {
          await PMUI.copyText(text);
          PMUI.toast('已复制');
        } else {
          const r = await chrome.runtime.sendMessage({ type: 'pm-insert', text });
          PMUI.toast(r && r.inserted ? '已插入到输入框' : (r && r.ok ? '请点击要粘贴的输入框' : '插入失败'));
        }
      });
    });
  }

  $('q').addEventListener('input', (e) => render(e.target.value));
  $('open-manager').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') }));
  $('open-side').addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) await chrome.sidePanel.open({ tabId: tab.id });
    } catch (e) {}
    window.close();
  });
  init();
})();
