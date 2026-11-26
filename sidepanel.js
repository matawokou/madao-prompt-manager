'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  let all = [], cats = [], currentCat = '全部', editing = null;

  async function init() {
    try {
      await PMStorage.init();
      all = await PMStorage.getAll();
      cats = (await PMStorage.getCategories()) || [];
      $('count').textContent = all.length + ' 条';
      renderCats();
      render();
      // 处理右键菜单存进来的待办提示词
      const pending = await new Promise((r) => chrome.storage.local.get('pm_pending_prompt', (x) => r(x.pm_pending_prompt)));
      if (pending) {
        await chrome.storage.local.remove('pm_pending_prompt');
        openEditor(Object.assign({ category: '通用' }, pending));
      }
    } catch (e) {
      $('status').textContent = '读取失败：' + e.message;
    }
  }

  function renderCats() {
    const used = new Set(all.map((p) => p.category || '通用'));
    const list = ['全部'].concat(Array.from(new Set(cats.concat(Array.from(used)))));
    $('cats').innerHTML = list.map((c) => `<span class="pill${c === currentCat ? ' on' : ''}" data-cat="${PMUI.esc(c)}">${PMUI.esc(c)}</span>`).join('');
    $('cats').querySelectorAll('.pill').forEach((el) => el.addEventListener('click', () => {
      currentCat = el.dataset.cat; renderCats(); render();
    }));
  }

  function render() {
    const q = $('q').value.trim().toLowerCase();
    let items = all.filter((p) => currentCat === '全部' || (p.category || '通用') === currentCat);
    if (q) items = items.filter((p) => [p.title, p.content, (p.tags || []).join(' ')].join(' ').toLowerCase().includes(q));
    const list = $('list');
    if (!items.length) { list.innerHTML = '<div id="status">没有匹配的提示词</div>'; return; }
    list.innerHTML = items.map((p) => `
      <div class="item" data-id="${PMUI.esc(p.id)}">
        <h4>${PMUI.esc(p.title || '未命名')}</h4>
        <p>${PMUI.esc(p.content || '')}</p>
        <div class="row">
          <span class="badge">${PMUI.esc(p.category || '通用')}</span>
          <button class="btn" data-act="copy">${PMUI.ICONS.copy}</button>
          <button class="btn" data-act="insert">插入</button>
          <button class="btn" data-act="edit">编辑</button>
        </div>
      </div>`).join('');
    list.querySelectorAll('.item').forEach((el) => el.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      const p = all.find((x) => x.id === el.dataset.id);
      if (!p) return;
      if (!btn) { await PMUI.copyText(PMUI.variables(p.content, {})); PMUI.toast('已复制'); return; }
      const act = btn.dataset.act;
      if (act === 'copy') { await PMUI.copyText(PMUI.variables(p.content, {})); PMUI.toast('已复制'); }
      else if (act === 'insert') {
        const r = await chrome.runtime.sendMessage({ type: 'pm-insert', text: PMUI.variables(p.content, {}) });
        PMUI.toast(r && r.inserted ? '已插入' : '请点输入框后再插入');
      } else if (act === 'edit') openEditor(p);
    }));
  }

  function openEditor(p) {
    editing = p || null;
    const box = document.createElement('div');
    box.id = 'pm-editor';
    box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:100;display:flex;align-items:center;justify-content:center;padding:16px';
    box.innerHTML = `<div style="background:#fff;border-radius:12px;padding:18px;width:100%;max-width:520px;max-height:90vh;overflow:auto">
      <div class="row" style="justify-content:space-between;margin-bottom:12px"><b>${p && p.id ? '编辑提示词' : '新建提示词'}</b><button class="btn" id="ed-close">${PMUI.ICONS.close}</button></div>
      <input class="input" id="ed-title" placeholder="标题" style="width:100%;margin-bottom:8px" value="${PMUI.esc(p && p.title || '')}">
      <textarea class="input" id="ed-content" placeholder="提示词内容，支持 {{变量}}" style="width:100%;height:180px;resize:vertical;margin-bottom:8px">${PMUI.esc(p && p.content || '')}</textarea>
      <input class="input" id="ed-cat" placeholder="分类" style="width:100%;margin-bottom:8px" value="${PMUI.esc(p && p.category || '通用')}">
      <input class="input" id="ed-tags" placeholder="标签，逗号分隔" style="width:100%;margin-bottom:12px" value="${PMUI.esc(p && (p.tags || []).join(', ') || '')}">
      <div class="row" style="justify-content:flex-end"><button class="btn primary" id="ed-save">保存</button></div>
    </div>`;
    document.body.appendChild(box);
    $('ed-close').onclick = () => box.remove();
    $('ed-save').onclick = async () => {
      const payload = {
        id: editing && editing.id,
        title: $('ed-title').value.trim(),
        content: $('ed-content').value,
        category: $('ed-cat').value.trim() || '通用',
        tags: $('ed-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      };
      if (editing) {
        Object.assign(editing, payload);
        await PMStorage.save(editing);
      } else {
        await PMStorage.save(payload);
      }
      box.remove();
      all = await PMStorage.getAll();
      cats = (await PMStorage.getCategories()) || [];
      renderCats(); render();
      PMUI.toast('已保存', 'success');
    };
  }

  $('q').addEventListener('input', render);
  $('new').addEventListener('click', () => openEditor(null));
  init();
})();
