'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const I = PMUI.ICONS;
  let all = [], cats = [], catOrder = [], currentCat = '全部', sortNewest = true, editing = null, cleanCands = [];
  let thumbMap = {};
  let batchMode = false, selectedIds = new Set();
  let lastSelId = null;           // Shift 范围选择的锚点（上次点击的卡片 id）
  let eImgFile = null;            // 编辑中待保存的封面 File
  let eImgData = null;            // 编辑中待保存的封面 dataURL（ComfyUI 自动截图带过来的）
  let eImgRemove = false;         // 是否移除封面
  let moveTarget = null;          // 移动菜单目标提示词 id（或 'batch'）
  let nsfwOn = false, nsfwModel = null;
  const NSFH_MARK_KEY = 'pm_nsfw_marks';
  let cleanScope = '全部';          // 清理超短：当前范围（分类名或'全部'）
  let cleanLen = 10;                // 清理超短：字符数阈值（可自定义，持久化）

  function log(msg) {
    const el = $('log');
    el.style.display = 'block';
    el.textContent += new Date().toLocaleTimeString() + ' ' + msg + '\n';
    el.scrollTop = el.scrollHeight;
  }

  // ---------- 主题：深色 / 浅色 ----------
  function applyTheme(dark) {
    document.body.classList.toggle('dark', dark);
    $('btn-theme').textContent = dark ? '☀️' : '🌙';
    $('btn-theme').title = dark ? '切到浅色' : '切到深色';
  }

  // ---------- 初始化 ----------
  async function init() {
    try {
      const info = await PMStorage.init();
      try { thumbMap = await PMStorage.getAllThumbs(); } catch (e) { thumbMap = {}; }
      await refresh();
      $('dbinfo').textContent = 'Prompt Manager';
      const fs = await PMStorage.getFolderStatus();
      updateFolderUI(fs);
      const s = (await PMStorage.getSettings()) || {};
      $('auto-backup-toggle').checked = !!s.autoBackupEnabled;
      // 主题 & 清理阈值：恢复上次设置
      const prefs = await new Promise((r) => chrome.storage.local.get(['pm_theme', 'pm_clean_len'], (x) => r(x)));
      applyTheme(prefs.pm_theme === 'dark');
      cleanLen = Math.max(1, parseInt(prefs.pm_clean_len, 10) || 10);
      const pending = await new Promise((r) => chrome.storage.local.get('pm_pending_prompt', (x) => r(x.pm_pending_prompt)));
      if (pending) {
        await chrome.storage.local.remove('pm_pending_prompt');
        openEditor(Object.assign({ category: '通用' }, pending));
      }
      // 右键收藏时管理页已打开：实时监听，直接弹新建窗口
      chrome.storage.onChanged.addListener(async (changes, area) => {
        if (area !== 'local' || !changes.pm_pending_prompt || !changes.pm_pending_prompt.newValue) return;
        const pp = changes.pm_pending_prompt.newValue;
        await chrome.storage.local.remove('pm_pending_prompt');
        openEditor(Object.assign({ category: '通用' }, pp));
      });
    } catch (e) {
      $('stats').textContent = '初始化失败：' + e.message;
      log('初始化失败：' + e.message);
    }
  }

  function updateFolderUI(fs) {
    $('btn-folder').textContent = fs.connected ? ('文件夹：' + fs.name) : '连接文件夹';
    $('fs-dot').className = 'dot' + (fs.connected ? ' on' : '');
    $('fs-text').textContent = fs.connected ? fs.name : '未连接文件夹';
  }

  async function refresh() {
    all = await PMStorage.getAll();
    const rawCats = (await PMStorage.getCategories()) || [];
    const rawOrder = (await PMStorage.getCatOrder()) || [];
    cats = [...new Set(rawCats)];       // 去重防脏数据
    catOrder = [...new Set(rawOrder)];  // 去重防脏数据
    let changed = rawCats.length !== cats.length || rawOrder.length !== catOrder.length;
    cats.forEach((c) => { if (!catOrder.includes(c)) { catOrder.push(c); changed = true; } });
    if (changed) {
      await PMStorage.setCategories(cats);
      await PMStorage.setCatOrder(catOrder);
    }
    renderCats();
    render();
  }

  // ---------- 分类 ----------
  function orderedCats() {
    const used = new Set(all.map((p) => p.category || '通用'));
    const allCats = Array.from(new Set(cats.concat(Array.from(used))));
    const ordered = [...new Set(catOrder)].filter((c) => allCats.includes(c));
    allCats.forEach((c) => { if (!ordered.includes(c)) ordered.push(c); });
    return ordered;
  }

  function catCount(c) { return all.filter((p) => (p.category || '通用') === c).length; }

  const expandedCats = new Set();   // 手动展开的父分类（有子分类的默认折叠）

  function renderCats() {
    const list = orderedCats();
    const tops = list.filter((c) => !c.includes('/'));
    const childMap = {};
    list.forEach((c) => {
      if (c.includes('/')) {
        const p = c.split('/')[0];
        (childMap[p] = childMap[p] || []).push(c);
      }
    });
    const rows = [{ name: '全部', n: all.length, isAll: true, isChild: false }];
    tops.forEach((c) => {
      const kids = childMap[c] || [];
      const n = catCount(c) + kids.reduce((s, k) => s + catCount(k), 0);
      const collapsed = kids.length > 0 && !expandedCats.has(c);
      rows.push({ name: c, n, isAll: false, isChild: false, collapsible: kids.length > 0, collapsed });
      if (!collapsed) kids.forEach((k) => rows.push({ name: k, n: catCount(k), isAll: false, isChild: true, display: k.split('/')[1] }));
    });
    $('cats').innerHTML = rows.map((r) => `
      <div class="cat${r.name === currentCat ? ' on' : ''}${r.isChild ? ' child' : ''}" data-cat="${PMUI.esc(r.name)}">
        <span class="cat-toggle${r.collapsible ? '' : ' none'}" data-toggle="${r.collapsible ? 1 : 0}">${r.collapsible ? (r.collapsed ? '▶' : '▼') : ''}</span>
        <span class="cat-name" title="${PMUI.esc(r.name)}（右键管理）">${PMUI.esc(r.display || r.name)}</span>
        <span class="n">${r.n}</span>
      </div>`).join('');
    $('cats').querySelectorAll('.cat').forEach((el) => {
      el.addEventListener('click', (e) => {
        // 点箭头 → 折叠/展开，不切换分类
        const tgl = e.target.closest('.cat-toggle');
        if (tgl && tgl.dataset.toggle === '1') {
          const c = el.dataset.cat;
          if (expandedCats.has(c)) expandedCats.delete(c); else expandedCats.add(c);
          renderCats();
          return;
        }
        currentCat = el.dataset.cat; renderCats(); render();
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showCatMenu(e, el.dataset.cat, el.dataset.cat === '全部', el.dataset.cat.includes('/'));
      });
    });
    // 编辑弹窗的分类下拉
    const sel = $('e-cat');
    const cur = sel.value;
    sel.innerHTML = list.map((c) => `<option value="${PMUI.esc(c)}">${PMUI.esc(c)}</option>`).join('');
    if (cur && list.includes(cur)) sel.value = cur;
  }

  // ---------- 分类右键菜单 ----------
  function showCatMenu(ev, cat, isAll, isChild) {
    const menu = $('cat-menu');
    const items = [];
    if (isAll) {
      items.push({ label: '新建分类', act: 'newTop' });
      items.push({ label: '按关键词归组…', act: 'groupBy' });
      items.push({ label: '清理超短提示词…', act: 'cleanShort' });
    } else if (isChild) {
      items.push({ label: '重命名', act: 'rename' });
      items.push({ label: '提升为一级分类', act: 'promote' });
      items.push({ label: '清理超短提示词…', act: 'cleanShort' });
      items.push({ label: '删除分类', act: 'del', danger: true });
      items.push({ sep: true });
      items.push({ label: '上移', act: 'up' });
      items.push({ label: '下移', act: 'down' });
    } else {
      items.push({ label: '新建子分类', act: 'newChild' });
      items.push({ label: '重命名', act: 'rename' });
      items.push({ label: '移动为子分类…', act: 'moveUnder' });
      items.push({ label: '合并到…', act: 'merge' });
      items.push({ label: '清理超短提示词…', act: 'cleanShort' });
      items.push({ label: '删除分类', act: 'del', danger: true });
      items.push({ sep: true });
      items.push({ label: '上移', act: 'up' });
      items.push({ label: '下移', act: 'down' });
    }
    menu.innerHTML = items.map((it, i) => it.sep
      ? '<div class="sep"></div>'
      : `<div class="mi${it.danger ? ' danger' : ''}" data-i="${i}">${it.label}</div>`).join('');
    menu.style.display = 'block';
    menu.style.left = Math.min(ev.clientX, window.innerWidth - 200) + 'px';
    menu.style.top = Math.min(ev.clientY, window.innerHeight - 260) + 'px';
    menu.querySelectorAll('.mi').forEach((el) => el.addEventListener('click', async () => {
      const it = items[parseInt(el.dataset.i, 10)];
      menu.style.display = 'none';
      await handleCatMenu(it.act, cat);
    }));
  }
  // 按当前范围 + 阈值重新扫描超短提示词，刷新清单
  async function runCleanScan() {
    cleanLen = Math.max(1, parseInt($('clean-len').value, 10) || 10);
    await chrome.storage.local.set({ pm_clean_len: cleanLen });
    const scopeAll = cleanScope === '全部';
    cleanCands = all.filter((p) =>
      (scopeAll || (p.category || '通用') === cleanScope) && (p.content || '').trim().length <= cleanLen
    );
    $('clean-info').textContent = '范围：' + (scopeAll ? '全部分类' : cleanScope) + ' · 共 ' + cleanCands.length + ' 条（内容≤' + cleanLen + '字），默认全选，去掉勾即保留';
    $('clean-list').innerHTML = cleanCands.length
      ? cleanCands.map((p) => `
        <label class="ci">
          <input type="checkbox" checked data-id="${PMUI.esc(p.id)}">
          <span class="t">${PMUI.esc(p.title || '未命名')}</span>
          <span class="c">${p.content && p.content.trim() ? PMUI.esc(p.content.trim()) : '（无内容）'}</span>
          <span class="cat-tag">${PMUI.esc(p.category || '通用')}</span>
        </label>`).join('')
      : '<div style="padding:18px;text-align:center;color:var(--muted)">该范围内没有符合条件的提示词——调大阈值再点「重新扫描」</div>';
    $('clean-toggle').textContent = '全不选';
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#cat-menu')) $('cat-menu').style.display = 'none';
    if (!e.target.closest('#card-menu')) $('card-menu').style.display = 'none';
  });

  async function handleCatMenu(act, cat) {
    if (act === 'cleanShort') {
      // 批量删除内容超短的提示词；阈值可自定义（弹窗内可改，重新扫描），先列清单勾选，确认后再删
      cleanScope = cat;
      $('clean-len').value = cleanLen;
      await runCleanScan();
      $('clean-modal').classList.add('show');
      return;
    }
    if (act === 'groupBy') {
      // 批量归组：名称含关键词的一级分类 → 统一挂到新父分类下
      const kw = prompt('输入关键词：名称包含该词的一级分类都会被归组。\n例如输入「背景」，A背景科技类 会变成 背景/A背景科技类', '背景');
      if (!kw || !kw.trim()) return;
      const parent = prompt('父分类名称（不存在会自动新建）：', kw.trim());
      if (!parent || !parent.trim()) return;
      const p = parent.trim();
      const tops = orderedCats().filter((c) => !c.includes('/') && c.includes(kw.trim()) && c !== p);
      if (!tops.length) { PMUI.toast('没有名称包含「' + kw.trim() + '」的一级分类'); return; }
      const blocked = tops.filter((c) => orderedCats().some((x) => x.startsWith(c + '/')));
      const movable = tops.filter((c) => !blocked.includes(c));
      if (!movable.length) { PMUI.toast('匹配到的分类都带子分类，无法移动'); return; }
      let msg = '将把以下 ' + movable.length + ' 个分类移到「' + p + '」下：\n' + movable.map((c) => '  ' + c + '（' + catCount(c) + ' 条）').join('\n');
      if (blocked.length) msg += '\n\n跳过（带子分类）：' + blocked.join('、');
      if (!confirm(msg)) return;
      // 父分类不存在则新建
      if (!orderedCats().includes(p)) {
        await persistCategories(cats.concat([p]));
        catOrder.push(p);
        await PMStorage.setCatOrder(catOrder);
      }
      const renamed = movable.map((c) => p + '/' + c);
      for (const c of movable) {
        const nn = p + '/' + c;
        for (const pr of all) { if ((pr.category || '通用') === c) { pr.category = nn; await PMStorage.save(pr); } }
      }
      await persistCategories(cats.map((x) => movable.includes(x) ? p + '/' + x : x));
      catOrder = catOrder.map((x) => movable.includes(x) ? p + '/' + x : x);
      // 排序：全部新子分类紧跟父分类
      const co = catOrder.filter((x) => !renamed.includes(x));
      const pi = co.indexOf(p);
      co.splice(pi + 1, 0, ...renamed);
      catOrder = co;
      await PMStorage.setCatOrder(catOrder);
      await refresh();
      if (document.getElementById('cat-modal').classList.contains('show')) renderCatManage();
      PMUI.toast('已把 ' + movable.length + ' 个分类归到「' + p + '」下', 'success');
      return;
    }
    if (act === 'newTop') {
      const name = prompt('新分类名称：');
      if (!name || !name.trim()) return;
      const n = name.trim();
      if (orderedCats().includes(n)) { PMUI.toast('分类已存在'); return; }
      await persistCategories(cats.concat([n]));
      catOrder.push(n);
      await PMStorage.setCatOrder(catOrder);
      currentCat = n;
      renderCats(); render();
      PMUI.toast('已新建分类：' + n, 'success');
    } else if (act === 'newChild') {
      const parent = cat.includes('/') ? cat.split('/')[0] : cat;
      const sub = prompt('「' + parent + '」下的子分类名称：');
      if (!sub || !sub.trim()) return;
      const full = parent + '/' + sub.trim();
      if (orderedCats().includes(full)) { PMUI.toast('子分类已存在'); return; }
      await persistCategories(cats.concat([full]));
      const co = catOrder.filter((c) => c !== full);
      const lastIdx = co.reduce((acc, c, i) => (c === parent || c.startsWith(parent + '/')) ? i : acc, -1);
      co.splice(lastIdx + 1, 0, full);
      catOrder = co;
      await PMStorage.setCatOrder(catOrder);
      currentCat = full;
      renderCats(); render();
      PMUI.toast('已新建子分类：' + full, 'success');
    } else if (act === 'rename') {
      const nn = prompt('重命名「' + cat + '」为：', cat);
      if (!nn || !nn.trim() || nn.trim() === cat) return;
      const newName = nn.trim();
      for (const p of all) { if ((p.category || '通用') === cat) { p.category = newName; await PMStorage.save(p); } }
      await persistCategories(cats.map((x) => x === cat ? newName : x));
      catOrder = catOrder.map((x) => x === cat ? newName : x);
      await PMStorage.setCatOrder(catOrder);
      if (currentCat === cat) currentCat = newName;
      await refresh();
      PMUI.toast('已重命名为「' + newName + '」', 'success');
    } else if (act === 'merge') {
      const targets = orderedCats().filter((c) => c !== cat);
      if (!targets.length) return;
      // 打开点选弹窗（列表 + 下拉选择目标）
      $('merge-src').textContent = '「' + cat + '」（' + catCount(cat) + ' 条）';
      $('merge-target').innerHTML = targets.map((c) =>
        `<option value="${PMUI.esc(c)}">${PMUI.esc(c)}（${catCount(c)}）</option>`).join('');
      $('merge-modal').dataset.src = cat;
      $('merge-modal').classList.add('show');
    } else if (act === 'moveUnder') {
      // 挂到其它一级分类下面成为子分类
      const tops = orderedCats().filter((c) => !c.includes('/') && c !== cat);
      if (!tops.length) { PMUI.toast('没有其它一级分类可作父分类'); return; }
      const hasChildren = orderedCats().some((c) => c.startsWith(cat + '/'));
      if (hasChildren) { PMUI.toast('「' + cat + '」下已有子分类，无法再嵌套'); return; }
      $('catmove-src').textContent = '「' + cat + '」（' + catCount(cat) + ' 条）';
      $('catmove-target').innerHTML = tops.map((c) =>
        `<option value="${PMUI.esc(c)}">${PMUI.esc(c)}（${catCount(c)}）</option>`).join('');
      $('catmove-modal').dataset.src = cat;
      $('catmove-modal').classList.add('show');
    } else if (act === 'promote') {
      // 子分类提升为一级
      const base = cat.split('/').pop();
      if (orderedCats().includes(base)) { PMUI.toast('一级分类里已存在「' + base + '」'); return; }
      const nn = prompt('提升后的名称：', base);
      if (!nn || !nn.trim()) return;
      const newName = nn.trim();
      if (orderedCats().includes(newName)) { PMUI.toast('分类「' + newName + '」已存在'); return; }
      for (const p of all) { if ((p.category || '通用') === cat) { p.category = newName; await PMStorage.save(p); } }
      await persistCategories(cats.map((x) => x === cat ? newName : x));
      catOrder = catOrder.map((x) => x === cat ? newName : x);
      await PMStorage.setCatOrder(catOrder);
      if (currentCat === cat) currentCat = newName;
      await refresh();
      PMUI.toast('已提升为一级分类「' + newName + '」', 'success');
    } else if (act === 'del') {
      const isChild = cat.includes('/');
      const n = catCount(cat);
      const dest = isChild ? cat.split('/')[0] : '通用';
      if (!confirm('删除分类「' + cat + '」？' + n + ' 条提示词将移到「' + dest + '」。')) return;
      for (const p of all) { if ((p.category || '通用') === cat) { p.category = dest; await PMStorage.save(p); } }
      await persistCategories(cats.filter((x) => x !== cat));
      catOrder = catOrder.filter((x) => x !== cat);
      await PMStorage.setCatOrder(catOrder);
      if (currentCat === cat) currentCat = dest;
      await refresh();
      PMUI.toast('已删除「' + cat + '」，' + n + ' 条移到「' + dest + '」', 'success');
    } else if (act === 'up' || act === 'down') {
      await moveCatOrder(cat, act);
    }
  }

  async function moveCatOrder(name, dir) {
    const list = orderedCats();
    const isChild = name.includes('/');
    const sibs = isChild
      ? list.filter((c) => c.startsWith(name.split('/')[0] + '/'))
      : list.filter((c) => !c.includes('/'));
    const i = sibs.indexOf(name);
    const j = i + (dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= sibs.length) return;
    const a = sibs[i], b = sibs[j];
    const co = catOrder.slice();
    co[co.indexOf(a)] = b;
    co[co.indexOf(b)] = a;
    catOrder = co;
    await PMStorage.setCatOrder(catOrder);
    renderCats();
  }

  async function persistCategories(next) {
    cats = [...new Set(next)];
    await PMStorage.setCategories(cats);
    catOrder = [...new Set(catOrder)].filter((c) => cats.includes(c));
    cats.forEach((c) => { if (!catOrder.includes(c)) catOrder.push(c); });
    await PMStorage.setCatOrder(catOrder);
  }

  // ---------- 渲染 ----------
  function render() {
    const q = $('q').value.trim().toLowerCase();
    let items = all.filter((p) => currentCat === '全部' || (p.category || '通用') === currentCat);
    if (q) items = items.filter((p) => [p.title, p.content, (p.tags || []).join(' '), p.note].join(' ').toLowerCase().includes(q));
    items.sort((a, b) => {
      if (a.favorite && !b.favorite) return -1;
      if (!a.favorite && b.favorite) return 1;
      return sortNewest ? (b.updatedAt || 0) - (a.updatedAt || 0) : (a.updatedAt || 0) - (b.updatedAt || 0);
    });

    $('stats').textContent = '显示 ' + items.length + ' / ' + all.length + ' 条 · 数据库 ' + PMStorage.getDBName();
    $('empty').style.display = items.length ? 'none' : 'block';
    $('grid').innerHTML = items.map((p) => {
      let thumb = '';
      const fn = p.coverImage && p.coverImage.fileName;
      if (fn) {
        const stem = String(fn).split('/').pop().replace(/\.[^.]+$/, '');
        if (thumbMap[stem]) thumb = thumbMap[stem];
      }
      // 上传 / ComfyUI 自动截图封面：按 blobId 键匹配（此前只认 fileName，上传封面从不显示）
      const bid = p.coverImage && p.coverImage.blobId;
      if (!thumb && bid && thumbMap[bid]) thumb = thumbMap[bid];
      const imgHtml = thumb
        ? `<img class="thumb" src="${thumb}" alt="" loading="lazy">`
        : `<div class="noimg">无缩略图</div>`;
      const cb = `<input type="checkbox" class="selcb" data-act="sel" ${selectedIds.has(p.id) ? 'checked' : ''} title="选中以便批量操作（按住 Shift 点另一张卡=范围选择）">`;
      return `
      <div class="item${selectedIds.has(p.id) ? ' selected' : ''}" data-id="${PMUI.esc(p.id)}">
        ${cb}
        <button class="fav${p.favorite ? ' on' : ''}" data-act="fav" title="收藏">★</button>
        ${imgHtml}
        <div class="body">
          <h3>${PMUI.esc(p.title || '未命名')}</h3>
          <div class="content">${PMUI.esc(p.content || '')}</div>
          <div class="meta">
            <button class="catbtn" data-act="move" title="移动到其它分类">${PMUI.esc(p.category || '通用')} ⇄</button>
            ${(p.tags || []).slice(0, 3).map((t) => `<span class="badge">${PMUI.esc(t)}</span>`).join('')}
          </div>
        </div>
      </div>`;
    }).join('');

    $('grid').querySelectorAll('.item').forEach((el) => {
      el.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const p = all.find((x) => x.id === el.dataset.id);
        if (!p) return;
        const act = btn.dataset.act;
        if (act === 'fav') {
          p.favorite = !p.favorite; await PMStorage.save(p); await refresh();
        } else if (act === 'sel') {
          const gridIds = Array.from($('grid').querySelectorAll('.item')).map((el) => el.dataset.id);
          if (e.shiftKey && lastSelId && gridIds.includes(lastSelId) && lastSelId !== p.id) {
            // Shift 范围选择：把锚点到当前卡之间的所有卡全部勾选
            const a = gridIds.indexOf(lastSelId), b = gridIds.indexOf(p.id);
            const [lo, hi] = a < b ? [a, b] : [b, a];
            const range = new Set(gridIds.slice(lo, hi + 1));
            range.forEach((id) => selectedIds.add(id));
            $('grid').querySelectorAll('.item').forEach((el) => {
              if (range.has(el.dataset.id)) {
                const c = el.querySelector('.selcb');
                if (c) c.checked = true;
                el.classList.add('selected');
              }
            });
            PMUI.toast('已选中 ' + range.size + ' 张卡片（Shift 范围）', 'success');
          } else {
            if (btn.checked) selectedIds.add(p.id); else selectedIds.delete(p.id);
          }
          lastSelId = p.id;       // 每次普通点击都更新锚点
          updateBatchUI();
        } else if (act === 'move') {
          openMoveMenu(btn, p.id);
        }
      });
      // 右键卡片 → 弹出操作菜单（复制/发送/编辑/移动/删除）
      el.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        const p = all.find((x) => x.id === el.dataset.id);
        if (!p) return;
        showCardMenu(e, p);
      });
    });
  }

  // ---------- 卡片右键菜单 ----------
  function showCardMenu(ev, p) {
    const menu = $('card-menu');
    const items = [
      { label: I.copy + ' 复制', act: 'copy' },
      { label: '→ ComfyUI（替换）', act: 'comfy' },
      { label: '→ ComfyUI（追加）', act: 'comfyappend' },
      { label: '编辑', act: 'edit' },
      { label: '移动到…', act: 'move' },
      { sep: true },
      { label: I.trash + ' 删除', act: 'del', danger: true }
    ];
    menu.innerHTML = items.map((it, i) => it.sep
      ? '<div class="sep"></div>'
      : `<div class="mi${it.danger ? ' danger' : ''}" data-i="${i}">${it.label}</div>`).join('');
    menu.style.display = 'block';
    menu.style.left = Math.min(ev.clientX, window.innerWidth - 200) + 'px';
    menu.style.top = Math.min(ev.clientY, window.innerHeight - 240) + 'px';
    menu.querySelectorAll('.mi').forEach((el) => el.addEventListener('click', async () => {
      const act = items[parseInt(el.dataset.i, 10)].act;
      menu.style.display = 'none';
      if (act === 'copy') {
        await PMUI.copyText(PMUI.variables(p.content, {})); PMUI.toast('已复制', 'success');
      } else if (act === 'comfy') {
        await sendToComfy(p.content, 'replace');
      } else if (act === 'comfyappend') {
        await sendToComfy(p.content, 'append');
      } else if (act === 'edit') {
        openEditor(p);
      } else if (act === 'move') {
        // 延迟一拍再打开，避开文档级"点空白处关闭 move-menu"的逻辑
        setTimeout(() => openMoveMenu(
          { getBoundingClientRect: () => ({ left: ev.clientX, right: ev.clientX, bottom: ev.clientY }) },
          p.id
        ), 0);
      } else if (act === 'del') {
        if (!confirm('确定删除「' + (p.title || '未命名') + '」？')) return;
        await PMStorage.remove(p.id); await refresh(); PMUI.toast('已删除');
      }
    }));
  }

  // ---------- 移动分类菜单（树形 + 可折叠） ----------
  function openMoveMenu(anchor, targetId) {
    moveTarget = targetId;
    const menu = $('move-menu');
    const list = orderedCats();
    const tops = list.filter((c) => !c.includes('/'));
    const childMap = {};
    list.forEach((c) => {
      if (c.includes('/')) {
        const p = c.split('/')[0];
        (childMap[p] = childMap[p] || []).push(c);
      }
    });
    const rows = [];
    tops.forEach((c) => {
      const kids = childMap[c] || [];
      if (kids.length) {
        const collapsed = !expandedCats.has('menu:' + c);
        const total = catCount(c) + kids.reduce((s, k) => s + catCount(k), 0);
        rows.push(`<div class="mi grp" data-grp="${PMUI.esc(c)}">${collapsed ? '▶' : '▼'} ${PMUI.esc(c)} (${total})</div>`);
        if (!collapsed) kids.forEach((k) =>
          rows.push(`<div class="mi sub" data-cat="${PMUI.esc(k)}">└ ${PMUI.esc(k.split('/')[1])} (${catCount(k)})</div>`));
      } else {
        rows.push(`<div class="mi" data-cat="${PMUI.esc(c)}">${PMUI.esc(c)} (${catCount(c)})</div>`);
      }
    });
    menu.innerHTML = rows.join('');
    menu.style.display = 'block';
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - 180) + 'px';
    menu.style.top = (r.bottom + 4 + window.scrollY) + 'px';
    // 分组行：只折叠/展开，不关菜单
    menu.querySelectorAll('.mi.grp').forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation();   // 重渲染会把被点的元素摘出 DOM，冒泡到 document 会被误判成"点外部"而关菜单
      const g = el.dataset.grp;
      if (expandedCats.has('menu:' + g)) expandedCats.delete('menu:' + g); else expandedCats.add('menu:' + g);
      // 记住菜单位置，重新渲染
      const left = menu.style.left, top = menu.style.top;
      openMoveMenu(anchor, targetId);
      menu.style.left = left; menu.style.top = top;
    }));
    // 分类行：执行移动并关菜单
    menu.querySelectorAll('.mi[data-cat]').forEach((el) => el.addEventListener('click', async () => {
      const cat = el.dataset.cat;
      if (moveTarget === 'batch') {
        let n = 0;
        for (const p of all) {
          if (selectedIds.has(p.id)) { p.category = cat; await PMStorage.save(p); n++; }
        }
        PMUI.toast('已移动 ' + n + ' 条到「' + cat + '」', 'success');
      } else {
        const p = all.find((x) => x.id === moveTarget);
        if (p) { p.category = cat; await PMStorage.save(p); PMUI.toast('已移动到「' + cat + '」', 'success'); }
      }
      menu.style.display = 'none';
      await refresh();
    }));
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#move-menu') && !e.target.closest('[data-act="move"]') && !e.target.closest('#btn-batch-move')) {
      $('move-menu').style.display = 'none';
    }
  });

  // ---------- 批量操作 ----------
  function updateBatchUI() {
    $('batch-n').textContent = selectedIds.size;
    $('batchbar').classList.toggle('show', selectedIds.size > 0);   // 勾了任意一项就出批量栏
  }
  $('btn-batch-exit').addEventListener('click', () => {
    selectedIds.clear();
    render(); updateBatchUI();
  });
  $('btn-batch-selectall').addEventListener('click', () => {
    const q = $('q').value.trim().toLowerCase();
    let items = all.filter((p) => currentCat === '全部' || (p.category || '通用') === currentCat);
    if (q) items = items.filter((p) => [p.title, p.content, (p.tags || []).join(' ')].join(' ').toLowerCase().includes(q));
    items.forEach((p) => selectedIds.add(p.id));
    render(); updateBatchUI();
  });
  $('btn-batch-copy').addEventListener('click', async () => {
    if (!selectedIds.size) { PMUI.toast('先勾选要复制的项'); return; }
    const picked = all.filter((p) => selectedIds.has(p.id));
    const text = picked.map((p) => PMUI.variables(p.content, {})).join('\n\n');
    await PMUI.copyText(text);
    PMUI.toast('已复制 ' + picked.length + ' 条内容', 'success');
  });
  $('btn-batch-delete').addEventListener('click', async () => {
    if (!selectedIds.size) { PMUI.toast('先勾选要删除的项'); return; }
    if (!confirm('确定删除所选 ' + selectedIds.size + ' 条？')) return;
    for (const id of selectedIds) await PMStorage.remove(id);
    selectedIds.clear();
    await refresh(); updateBatchUI();
    PMUI.toast('已删除', 'success');
  });
  $('btn-batch-move').addEventListener('click', (e) => {
    if (!selectedIds.size) { PMUI.toast('先勾选要移动的项'); return; }
    moveTarget = 'batch';
    openMoveMenu(e.target, 'batch');
  });

  // ---------- 编辑器 ----------
  function updateVarHint() {
    const vars = [...new Set(($('e-content').value.match(/\{\{([^}]+)\}\}/g) || []).map((s) => s.slice(2, -2).trim()))];
    $('e-varhint').textContent = vars.length ? '检测到变量：' + vars.join('、') : '';
  }
  function updateImagePreview() {
    if (eImgFile) {
      const url = URL.createObjectURL(eImgFile);
      $('e-img-preview').src = url;
      $('e-img-preview').style.display = 'block';
      $('e-img-rm').style.display = 'inline-block';
    } else if (eImgData) {
      $('e-img-preview').src = eImgData;
      $('e-img-preview').style.display = 'block';
      $('e-img-rm').style.display = 'inline-block';
    } else if (editing && editing.coverImage && !eImgRemove) {
      const fn = editing.coverImage.fileName;
      const stem = fn ? String(fn).split('/').pop().replace(/\.[^.]+$/, '') : null;
      const src = (editing.coverImage.dataUrl) || (stem && thumbMap[stem]);
      if (src) {
        $('e-img-preview').src = src;
        $('e-img-preview').style.display = 'block';
        $('e-img-rm').style.display = 'inline-block';
        return;
      }
      $('e-img-preview').style.display = 'none';
      $('e-img-rm').style.display = 'none';
    } else {
      $('e-img-preview').style.display = 'none';
      $('e-img-rm').style.display = 'none';
    }
  }

  let titleTouched = false;   // 用户手动改过标题后不再自动覆盖

  function openEditor(p) {
    editing = p || null;
    eImgFile = null; eImgRemove = false;
    eImgData = (p && p.imgData) || null;   // ComfyUI 右键保存自动带来的封面
    titleTouched = !!(p && p.title);
    $('edit-title-h').textContent = p && p.id ? '编辑提示词' : '新建提示词';
    const content = (p && p.content) || '';
    $('e-title').value = (p && p.title) || PMUI.autoTitle(content) || '';
    $('e-content').value = content;
    // 分类下拉：确保当前分类在选项里
    const cat = (p && p.category) || '通用';
    const sel = $('e-cat');
    if (cat && !Array.from(sel.options).some((o) => o.value === cat)) {
      sel.insertAdjacentHTML('afterbegin', `<option value="${PMUI.esc(cat)}">${PMUI.esc(cat)}</option>`);
    }
    sel.value = cat;
    $('e-tags').value = (p && (p.tags || []).join(', ')) || '';
    updateVarHint();
    updateImagePreview();
    $('edit-modal').classList.add('show');
  }

  async function saveEditor() {
    const payload = {
      id: editing && editing.id,
      title: $('e-title').value.trim() || PMUI.autoTitle($('e-content').value) || '未命名',
      content: $('e-content').value,
      category: $('e-cat').value || '通用',
      tags: $('e-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      favorite: editing ? !!editing.favorite : false
    };
    // 封面处理
    if (eImgFile) {
      const buf = await eImgFile.arrayBuffer();
      const blob = new Blob([buf], { type: eImgFile.type || 'image/png' });
      const imgId = 'img-' + (payload.id || String(Date.now()));
      await PMStorage.putImage(imgId, blob);
      payload.coverImage = { blobId: imgId };
      thumbMap[imgId] = URL.createObjectURL(blob);
    } else if (eImgData && !eImgRemove) {
      // ComfyUI 自动截图（dataURL）转 Blob 存入缩略图库
      try {
        const bin = atob(eImgData.split(',')[1]);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const blob = new Blob([arr], { type: 'image/jpeg' });
        const imgId = 'img-' + (payload.id || String(Date.now()));
        await PMStorage.putImage(imgId, blob);
        payload.coverImage = { blobId: imgId };
        thumbMap[imgId] = URL.createObjectURL(blob);
      } catch (e) { /* dataURL 损坏则不设封面 */ }
    } else if (eImgRemove) {
      payload.coverImage = null;
    } else if (editing && editing.coverImage) {
      payload.coverImage = editing.coverImage;
    }
    await PMStorage.save(payload);
    $('edit-modal').classList.remove('show');
    await refresh();
    PMUI.toast('已保存', 'success');
  }

  $('e-content').addEventListener('input', () => {
    updateVarHint();
    // 自动命名：标题为空（且用户没手动改过）时跟随内容生成
    if (!titleTouched && !$('e-title').value.trim()) {
      $('e-title').value = PMUI.autoTitle($('e-content').value) || '';
    }
  });
  $('e-title').addEventListener('input', () => { titleTouched = true; });
  $('e-cat').addEventListener('change', () => { titleTouched = titleTouched; });

  // 发送到 ComfyUI：后台脚本在 ComfyUI 标签页内同源调用 LM 接口（主），画布填充（兜底）
  function fetchT(url, opt, ms) {
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), ms || 8000);
    return fetch(url, Object.assign({ signal: ctl.signal }, opt || {})).finally(() => clearTimeout(tid));
  }
  async function sendToComfy(text, mode) {
    mode = mode || 'replace';
    const content = PMUI.variables(text, {});
    let err = '';
    try {
      const r = await chrome.runtime.sendMessage({ type: 'pm-send-comfyui', text: content, mode });
      const res = r && r.result;
      if (r && r.ok && res && res.ok) {
        PMUI.toast('已发送到 ComfyUI（' + (res.filled || '') + '）', 'success'); return;
      }
      err = (res && res.error) || (r && r.error) || '未知';
    } catch (e) { err = e.message; }
    PMUI.toast('发送失败：' + err, 'error');
    // 失败现场自动回传诊断（静默）
    pmDiagRun().then((out) => pmDiagPost(out)).catch(() => {});
  }

  // ---------- ComfyUI 通道诊断 ----------
  async function pmDiagRun() {
    const out = { 时间: new Date().toLocaleString(), 扩展版本: chrome.runtime.getManifest().version, 页面: 'manager' };
    // 后台脚本存活/版本
    try {
      const r = await chrome.runtime.sendMessage({ type: 'pm-ping' });
      out.后台脚本 = r && r.ok ? ('响应正常 v' + r.swVersion) : '无响应（旧代码或SW休眠失败）';
    } catch (e) { out.后台脚本 = '失联:' + e.message; }
    // LM 注册表
    try {
      const t0 = Date.now();
      const j = await (await fetchT('http://127.0.0.1:8188/api/lm/get-registry')).json();
      if (j && j.success) {
        const nodes = Object.values(j.data.nodes);
        const act = nodes.filter((n) => (n.widget_names || []).includes('text') && n.mode === 0);
        out.LM注册表 = 'OK(' + (Date.now() - t0) + 'ms)';
        out.活跃文本节点 = act.map((n) => n.id + ':' + (n.title || n.type_name)).join(', ') || '无';
      } else out.LM注册表 = '返回失败:' + JSON.stringify(j).slice(0, 100);
    } catch (e) { out.LM注册表 = '失败:' + e.message; }
    // LM 更新接口可达性（空体探测，不会写画布）
    try {
      const r = await fetchT('http://127.0.0.1:8188/api/lm/update-node-widget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      out.LM更新接口 = '可达(HTTP ' + r.status + ')';
    } catch (e) { out.LM更新接口 = '失败:' + e.message; }
    // ComfyUI 标签页
    try {
      const tabs = await chrome.tabs.query({ url: '*://127.0.0.1:8188/*' });
      out.ComfyUI标签页 = tabs.length ? '已开(' + tabs.length + '个)' : '未开';
    } catch (e) { out.ComfyUI标签页 = '查询失败:' + e.message; }
    return out;
  }
  async function pmDiagPost(out) {
    try {
      await fetchT('http://127.0.0.1:8766/pm-diag', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(out, null, 2) }, 3000);
      return true;
    } catch (e) { return false; }
  }
  async function runDiagModal() {
    $('diag-modal').classList.add('show');
    $('diag-out').textContent = '检测中…';
    const out = await pmDiagRun();
    out['结果回传'] = (await pmDiagPost(out)) ? '已发送给助手' : '本地收集器未运行';
    const lines = Object.entries(out).map(([k, v]) => k + '：' + v).join('\n');
    $('diag-out').textContent = lines;
  }
  $('btn-diag').addEventListener('click', runDiagModal);
  $('diag-close').addEventListener('click', () => $('diag-modal').classList.remove('show'));
  $('diag-copy').addEventListener('click', async () => {
    await PMUI.copyText($('diag-out').textContent);
    PMUI.toast('诊断结果已复制', 'success');
  });
  $('e-comfy').addEventListener('click', () => sendToComfy($('e-content').value, 'replace'));
  $('e-comfy-append').addEventListener('click', () => sendToComfy($('e-content').value, 'append'));
  $('e-img-btn').addEventListener('click', () => $('e-img').click());
  $('e-img').addEventListener('change', (e) => {
    if (e.target.files[0]) { eImgFile = e.target.files[0]; eImgData = null; eImgRemove = false; updateImagePreview(); }
    e.target.value = '';
  });
  $('e-img-rm').addEventListener('click', () => { eImgFile = null; eImgData = null; eImgRemove = true; updateImagePreview(); });
  $('e-content').addEventListener('paste', (e) => {
    const items = (e.clipboardData || {}).items || [];
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        eImgFile = it.getAsFile(); eImgData = null; eImgRemove = false; updateImagePreview();
        PMUI.toast('已粘贴图片，保存后生效', 'success');
        break;
      }
    }
  });

  // ---------- 分类管理弹窗 ----------
  let cmTarget = null;   // 正在重命名的分类
  function openCatModal() {
    renderCatManage();
    $('cat-modal').classList.add('show');
  }
  function renderCatManage() {
    const list = orderedCats();
    $('cm-list').innerHTML = list.map((c) => `
      <div class="cmr" data-cat="${PMUI.esc(c)}">
        <span class="n">${catCount(c)}</span>
        <input class="input" value="${PMUI.esc(c)}" data-role="name">
        <button class="btn sm" data-role="rename">重命名</button>
        <button class="btn sm" data-role="merge">合并</button>
        <button class="btn sm err" data-role="delete">删除</button>
      </div>`).join('');
    $('cm-list').querySelectorAll('.cmr').forEach((el) => {
      const c = el.dataset.cat;
      el.querySelector('[data-role="rename"]').addEventListener('click', async () => {
        const nn = el.querySelector('[data-role="name"]').value.trim();
        if (!nn || nn === c) return;
        for (const p of all) { if ((p.category || '通用') === c) { p.category = nn; await PMStorage.save(p); } }
        await persistCategories(cats.map((x) => x === c ? nn : x));
        catOrder = catOrder.map((x) => x === c ? nn : x);
        await PMStorage.setCatOrder(catOrder);
        if (currentCat === c) currentCat = nn;
        await refresh(); renderCatManage();
        PMUI.toast('已重命名为「' + nn + '」', 'success');
      });
      el.querySelector('[data-role="merge"]').addEventListener('click', () => {
        $('merge-src').textContent = c;
        $('merge-target').innerHTML = orderedCats().filter((x) => x !== c)
          .map((x) => `<option value="${PMUI.esc(x)}">${PMUI.esc(x)} (${catCount(x)})</option>`).join('');
        $('merge-modal').dataset.src = c;
        $('merge-modal').classList.add('show');
      });
      el.querySelector('[data-role="delete"]').addEventListener('click', async () => {
        const n = catCount(c);
        if (!confirm('删除分类「' + c + '」？' + n + ' 条提示词将移到「通用」。')) return;
        for (const p of all) { if ((p.category || '通用') === c) { p.category = '通用'; await PMStorage.save(p); } }
        await persistCategories(cats.filter((x) => x !== c));
        if (currentCat === c) currentCat = '全部';
        await refresh(); renderCatManage();
        PMUI.toast('已删除分类「' + c + '」', 'success');
      });
    });
  }
  $('btn-cat-manage').addEventListener('click', openCatModal);
  // 主题切换：存偏好，下次打开保持
  $('btn-theme').addEventListener('click', async () => {
    const dark = !document.body.classList.contains('dark');
    applyTheme(dark);
    await chrome.storage.local.set({ pm_theme: dark ? 'dark' : 'light' });
  });
  $('btn-cat-manage2').addEventListener('click', openCatModal);
  $('cm-close').addEventListener('click', () => { $('cat-modal').classList.remove('show'); refresh(); });
  $('cm-del-empty').addEventListener('click', async () => {
    const empties = orderedCats().filter((c) => catCount(c) === 0 && cats.includes(c));
    if (!empties.length) { PMUI.toast('没有空分类'); return; }
    if (!confirm('删除 ' + empties.length + ' 个空分类？\n' + empties.join('、'))) return;
    await persistCategories(cats.filter((c) => !empties.includes(c)));
    await refresh(); renderCatManage();
    PMUI.toast('已删除 ' + empties.length + ' 个空分类', 'success');
  });
  $('merge-cancel').addEventListener('click', () => $('merge-modal').classList.remove('show'));
  $('merge-ok').addEventListener('click', async () => {
    const src = $('merge-modal').dataset.src;
    const dst = $('merge-target').value;
    if (!src || !dst) return;
    for (const p of all) { if ((p.category || '通用') === src) { p.category = dst; await PMStorage.save(p); } }
    await persistCategories(cats.filter((x) => x !== src));
    catOrder = catOrder.filter((x) => x !== src);
    await PMStorage.setCatOrder(catOrder);
    if (currentCat === src) currentCat = dst;
    $('merge-modal').classList.remove('show');
    await refresh();
    if (document.getElementById('cat-modal').classList.contains('show')) renderCatManage();
    PMUI.toast('已合并到「' + dst + '」', 'success');
  });
  $('catmove-cancel').addEventListener('click', () => $('catmove-modal').classList.remove('show'));
  $('catmove-ok').addEventListener('click', async () => {
    const src = $('catmove-modal').dataset.src;
    const parent = $('catmove-target').value;
    if (!src || !parent) return;
    const newName = parent + '/' + src;
    // 提示词跟着改分类
    for (const p of all) { if ((p.category || '通用') === src) { p.category = newName; await PMStorage.save(p); } }
    // 分类列表改名（保留原一级名，不重排其它）
    await persistCategories(cats.map((x) => x === src ? newName : x));
    // 排序：挪到父分类现有子分类之后
    const co = catOrder.map((x) => x === src ? newName : x).filter((x) => x !== newName);
    const lastIdx = co.reduce((acc, c, i) => (c === parent || c.startsWith(parent + '/')) ? i : acc, -1);
    co.splice(lastIdx + 1, 0, newName);
    catOrder = co;
    await PMStorage.setCatOrder(catOrder);
    if (currentCat === src) currentCat = newName;
    $('catmove-modal').classList.remove('show');
    await refresh();
    if (document.getElementById('cat-modal').classList.contains('show')) renderCatManage();
    PMUI.toast('已移动为「' + newName + '」的子分类', 'success');
  });
  // ---- 清理超短提示词弹窗（阈值可自定义）----
  $('clean-cancel').addEventListener('click', () => $('clean-modal').classList.remove('show'));
  $('clean-rescan').addEventListener('click', () => runCleanScan());
  $('clean-len').addEventListener('keydown', (e) => { if (e.key === 'Enter') runCleanScan(); });
  $('clean-toggle').addEventListener('click', () => {
    const boxes = Array.from($('clean-list').querySelectorAll('input[type=checkbox]'));
    const allOn = boxes.every((b) => b.checked);
    boxes.forEach((b) => { b.checked = !allOn; });
    $('clean-toggle').textContent = allOn ? '全选' : '全不选';
  });
  $('clean-ok').addEventListener('click', async () => {
    const ids = new Set(Array.from($('clean-list').querySelectorAll('input[type=checkbox]:checked')).map((b) => b.dataset.id));
    if (!ids.size) { PMUI.toast('没有勾选任何条目'); return; }
    const targets = cleanCands.filter((p) => ids.has(p.id));
    for (const p of targets) await PMStorage.remove(p.id);
    $('clean-modal').classList.remove('show');
    await refresh();
    if (document.getElementById('cat-modal').classList.contains('show')) renderCatManage();
    PMUI.toast('已删除 ' + targets.length + ' 条超短提示词', 'success');
  });

  // 分类排序：字母序 / 数量序
  $('btn-sort-alpha').addEventListener('click', async () => {
    catOrder = orderedCats().slice().sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    await PMStorage.setCatOrder(catOrder);
    renderCats(); PMUI.toast('已按字母排序', 'success');
  });
  $('btn-sort-count').addEventListener('click', async () => {
    catOrder = orderedCats().slice().sort((a, b) => catCount(b) - catCount(a));
    await PMStorage.setCatOrder(catOrder);
    renderCats(); PMUI.toast('已按数量排序', 'success');
  });

  // ---------- 新建 / 删除分类已改为侧栏右键菜单 ----------

  // ---------- 导入导出 ----------
  $('btn-import').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const clear = confirm('导入前清空现有数据？\n\n确定 = 清空后导入（推荐恢复备份）\n取消 = 追加，按 id 覆盖同项');
      const r = await PMStorage.importJSON(text, { clearFirst: clear, onProgress: (d, t) => log('导入 ' + d + '/' + t) });
      await refresh();
      log('导入完成：本次 ' + r.imported + ' 条，库内共 ' + r.total + ' 条');
      PMUI.toast('导入完成：' + r.total + ' 条', 'success');
    } catch (err) {
      log('导入失败：' + err.message);
      PMUI.toast('导入失败：' + err.message, 'error');
    }
    e.target.value = '';
  });

  $('btn-export').addEventListener('click', () => $('export-modal').classList.add('show'));
  $('exp-cancel').addEventListener('click', () => $('export-modal').classList.remove('show'));
  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }
  $('exp-json').addEventListener('click', async () => {
    const data = await PMStorage.exportJSON();
    download('prompt-manager-export-' + new Date().toISOString().slice(0, 10) + '.json',
      JSON.stringify(data, null, 2), 'application/json');
    $('export-modal').classList.remove('show');
    PMUI.toast('已导出 ' + data.prompts.length + ' 条', 'success');
  });
  $('exp-csv').addEventListener('click', async () => {
    const data = await PMStorage.exportJSON();
    const esc2 = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
    const lines = ['title,category,tags,content,favorite,updatedAt'];
    data.prompts.forEach((p) => {
      lines.push([esc2(p.title), esc2(p.category || ''), esc2((p.tags || []).join(';')),
        esc2(p.content), p.favorite ? '1' : '0',
        p.updatedAt ? new Date(p.updatedAt).toISOString() : ''].join(','));
    });
    download('prompt-manager-export-' + new Date().toISOString().slice(0, 10) + '.csv',
      '\uFEFF' + lines.join('\r\n'), 'text/csv');
    $('export-modal').classList.remove('show');
    PMUI.toast('已导出 CSV ' + data.prompts.length + ' 条', 'success');
  });

  // ---------- 文件夹 ----------
  $('btn-folder').addEventListener('click', async () => {
    try {
      const fs = await PMStorage.getFolderStatus();
      if (fs.connected) {
        if (!confirm('断开文件夹「' + fs.name + '」？')) return;
        await PMStorage.disconnectFolder();
        PMUI.toast('已断开');
      } else {
        const name = await PMStorage.chooseFolder();
        PMUI.toast('已连接 ' + name, 'success');
      }
      updateFolderUI(await PMStorage.getFolderStatus());
    } catch (err) { PMUI.toast(err.message, 'error'); }
  });
  $('btn-sync').addEventListener('click', async () => {
    try {
      const r = await PMStorage.syncFromFolder();
      await refresh();
      log('同步完成：新增 ' + r.loaded + '，更新 ' + r.updated + '，失败 ' + r.failed);
      PMUI.toast('同步完成：' + r.total + ' 条', 'success');
    } catch (err) { log('同步失败：' + err.message); PMUI.toast(err.message, 'error'); }
  });
  $('btn-export-folder').addEventListener('click', async () => {
    try {
      const r = await PMStorage.exportToFolder();
      log('导出到文件夹：' + r.categories + ' 个分类，' + r.total + ' 条');
      PMUI.toast('已导出 ' + r.total + ' 条', 'success');
    } catch (err) { log('导出失败：' + err.message); PMUI.toast(err.message, 'error'); }
  });

  // ---------- 自动备份 ----------
  $('auto-backup-toggle').addEventListener('change', async (e) => {
    await PMStorage.saveSettings({ autoBackupEnabled: e.target.checked });
    PMUI.toast(e.target.checked ? '自动备份已开启：每次保存/删除后导出到 E:\\PromptManager-Backups' : '自动备份已关闭');
  });

  // ---------- NSFW 审查 ----------
  $('btn-nsfw').addEventListener('click', async () => {
    nsfwOn = !nsfwOn;
    $('btn-nsfw').textContent = '内容审查：' + (nsfwOn ? '开' : '关');
    $('btn-nsfw').classList.toggle('err', nsfwOn);
    if (nsfwOn) {
      PMUI.toast('内容审查已开启：自动识别敏感图并模糊');
      if (!nsfwModel) {
        try {
          nsfwModel = await nsfwjs.load(chrome.runtime.getURL('lib/nsfwjs/mobilenet_v2.model.min.js'));
          log('NSFW 模型已加载');
        } catch (e) { log('NSFW 模型加载失败：' + e.message); }
      }
      scanNsfw();
    } else {
      render();
    }
  });

  async function scanNsfw() {
    if (!nsfwOn || !nsfwModel) return;
    const flagged = new Set();
    const jobs = [];
    $('grid').querySelectorAll('.item').forEach((el) => {
      const img = el.querySelector('img.thumb');
      if (!img) return;
      const id = el.dataset.id;
      jobs.push((async () => {
        try {
          const pred = await nsfwModel.classify(img);
          const porn = (pred.find((x) => x.className === 'Porn') || {}).probability || 0;
          const hentai = (pred.find((x) => x.className === 'Hentai') || {}).probability || 0;
          if (porn > 0.5 || hentai > 0.5) flagged.add(id);
        } catch (e) {}
      })());
    });
    await Promise.all(jobs);
    flagged.forEach((id) => {
      const img = $('grid').querySelector('.item[data-id="' + id + '"] .thumb');
      if (img) {
        img.style.filter = 'blur(14px)';
        img.title = '疑似敏感内容（点击恢复）';
        img.addEventListener('click', () => { img.style.filter = ''; }, { once: true });
      }
    });
    if (flagged.size) log('NSFW 审查：标记 ' + flagged.size + ' 张疑似敏感图');
  }

  // ---------- 其它 ----------
  $('q').addEventListener('input', render);
  $('btn-sort').addEventListener('click', () => {
    sortNewest = !sortNewest;
    $('btn-sort').textContent = '排序：' + (sortNewest ? '最新' : '最早');
    render();
  });
  $('btn-new').addEventListener('click', () => openEditor(null));
  $('e-cancel').addEventListener('click', () => $('edit-modal').classList.remove('show'));
  $('e-save').addEventListener('click', saveEditor);

  $('btn-clear').addEventListener('click', async () => {
    if (!confirm('确定清空全部 ' + all.length + ' 条提示词？此操作不可撤销（可从备份重新导入）。')) return;
    await PMStorage.clearPrompts();
    await refresh();
    PMUI.toast('已清空');
  });

  init();
})();
