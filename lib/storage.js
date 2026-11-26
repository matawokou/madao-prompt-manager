/* PM Storage v2 - IndexedDB + chrome.storage + File System Access
 * 关键点：启动时自动探测数据实际所在的库，避免"数据在一个库、代码读另一个库"。 */
(function (global) {
  'use strict';

  const CANDIDATE_DBS = ['pm_prompts_db_v2', 'pm_prompts_db'];
  const FSA_DB = 'pm_fsa_db';
  const THUMBS_DB = 'pm_thumbs_db';   // 缩略图独立固定库：不随主库切换丢失
  const K_DB_CHOSEN = 'pm_db_chosen'; // 钉死主库选择
  const K_CATEGORIES = 'pm_categories';
  const K_SETTINGS = 'pm_settings';

  let _dbName = null;
  let _dbPromise = null;
  let _thumbsPromise = null;
  let _dirHandle = null;
  let _useFolder = false;

  // 缩略图专用库（固定名字，永远同一个）
  function getThumbsDB() {
    if (_thumbsPromise) return _thumbsPromise;
    _thumbsPromise = new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('缩略图库打开超时')); } }, 8000);
      const req = indexedDB.open(THUMBS_DB, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
      };
      req.onsuccess = (e) => { done = true; clearTimeout(timer); resolve(e.target.result); };
      req.onerror = () => { done = true; clearTimeout(timer); reject(req.error); };
    });
    return _thumbsPromise;
  }

  function openNamed(name, version, timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; reject(new Error('打开数据库超时: ' + name)); }
      }, timeoutMs || 8000);
      function fin(err, db) {
        if (done) return;
        done = true; clearTimeout(timer);
        if (err) reject(err); else resolve(db);
      }
      let req;
      try { req = version ? indexedDB.open(name, version) : indexedDB.open(name); }
      catch (e) { fin(e); return; }
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('prompts')) db.createObjectStore('prompts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
      };
      req.onblocked = () => { /* 超时兜底 */ };
      req.onsuccess = (e) => fin(null, e.target.result);
      req.onerror = () => fin(req.error || new Error('open error'));
    });
  }

  function countDB(db, store) {
    return new Promise((resolve, reject) => {
      try {
        const req = db.transaction(store, 'readonly').objectStore(store).count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    });
  }

  async function getDB() {
    if (_dbPromise) return _dbPromise;
    if (!_dbName) throw new Error('PMStorage 尚未初始化');
    _dbPromise = openNamed(_dbName, 2).catch((e) => { _dbPromise = null; throw e; });
    return _dbPromise;
  }

  function tx(db, store, mode) {
    return db.transaction(store, mode).objectStore(store);
  }

  function reqPromise(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('事务中止'));
    });
  }

  const PMStorage = {
    async init() {
      // 1) 优先使用上次钉死的主库：避免按条数自动切换导致数据/缩略图「消失」
      const saved = await this._getChrome(K_DB_CHOSEN);
      let best = null, bestCount = -1;
      if (saved && CANDIDATE_DBS.includes(saved)) {
        try {
          const db = await openNamed(saved, 2, 6000);
          bestCount = await countDB(db, 'prompts');
          db.close();
          best = saved;
        } catch (e) { best = null; }
      }
      // 2) 没有钉死记录（或库坏了）才按条数探测，并钉死结果
      if (!best) {
        best = CANDIDATE_DBS[0]; bestCount = -1;
        for (const name of CANDIDATE_DBS) {
          try {
            const db = await openNamed(name, 2, 6000);
            const n = await countDB(db, 'prompts');
            db.close();
            if (n > bestCount) { bestCount = n; best = name; }
          } catch (e) { /* 该库不可用，跳过 */ }
        }
        await this._setChrome(K_DB_CHOSEN, best);
      }
      _dbName = best;
      _dbPromise = null;

      // 3) 把各旧库 images 表的缩略图合并进独立固定库（按 id 去重，缺啥补啥）
      await this._migrateThumbs();

      // 4) 恢复文件夹句柄
      await this._restoreDirHandle();

      // 5) 确保默认分类
      const cats = await this.getCategories();
      if (!cats || !cats.length) {
        await this.setCategories(['通用', '人像摄影', '风景摄影', '产品摄影', '视频提示词']);
      }
      return { dbName: _dbName, count: bestCount };
    },

    async _migrateThumbs() {
      try {
        const tdb = await getThumbsDB();
        const have = new Set((await reqPromise(tx(tdb, 'images', 'readonly').getAll())).map((r) => r && r.id));
        for (const name of CANDIDATE_DBS) {
          try {
            const db = await openNamed(name, 2, 6000);
            const rows = await reqPromise(tx(db, 'images', 'readonly').getAll());
            db.close();
            const missing = (rows || []).filter((r) => r && r.id && !have.has(r.id));
            if (missing.length) {
              const t = tdb.transaction('images', 'readwrite');
              const st = t.objectStore('images');
              missing.forEach((r) => st.put({ id: r.id, dataUrl: r.dataUrl, blob: r.blob }));
              await txDone(t);
              missing.forEach((r) => have.add(r.id));
            }
          } catch (e) { /* 该库没有 images 表，跳过 */ }
        }
      } catch (e) { /* 缩略图库打不开就先不管 */ }
    },

    getDBName() { return _dbName; },

    // ---- CRUD ----
    async getAll() {
      const db = await getDB();
      const rows = await reqPromise(tx(db, 'prompts', 'readonly').getAll());
      return (rows || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },

    async getById(id) {
      const db = await getDB();
      return await reqPromise(tx(db, 'prompts', 'readonly').get(id));
    },

    async save(prompt) {
      const db = await getDB();
      const now = Date.now();
      const p = Object.assign({}, prompt);
      if (!p.id) p.id = String(now) + '-' + Math.random().toString(16).slice(2, 10);
      p.createdAt = p.createdAt || now;
      p.updatedAt = now;
      const t = db.transaction('prompts', 'readwrite');
      t.objectStore('prompts').put(p);
      await txDone(t);
      return p;
    },

    async remove(id) {
      const db = await getDB();
      const t = db.transaction('prompts', 'readwrite');
      t.objectStore('prompts').delete(id);
      await txDone(t);
    },

    async clearPrompts() {
      const db = await getDB();
      const t = db.transaction('prompts', 'readwrite');
      t.objectStore('prompts').clear();
      await txDone(t);
    },

    // ---- 缩略图批量导入（id = 文件名去扩展名）—— 存独立固定库 ----
    async importThumbs(map) {
      const db = await getThumbsDB();
      const entries = Object.entries(map);
      const B = 100;
      let done = 0;
      while (done < entries.length) {
        const t = db.transaction('images', 'readwrite');
        const st = t.objectStore('images');
        for (const [id, dataUrl] of entries.slice(done, done + B)) {
          st.put({ id, dataUrl });
        }
        await txDone(t);
        done += B;
      }
      return done;
    },
    async getAllThumbs() {
      const db = await getThumbsDB();
      const rows = await reqPromise(tx(db, 'images', 'readonly').getAll());
      const map = {};
      (rows || []).forEach((r) => { if (r && r.dataUrl) map[r.id] = r.dataUrl; });
      return map;
    },

    // ---- 图片：写入独立固定库；读取先固定库、再回退主库（兼容迁移前的旧数据）----
    async putImage(id, blob) {
      const db = await getThumbsDB();
      const t = db.transaction('images', 'readwrite');
      t.objectStore('images').put({ id, blob });
      await txDone(t);
    },
    async getImage(id) {
      const db = await getThumbsDB();
      const rec = await reqPromise(tx(db, 'images', 'readonly').get(id));
      if (rec) return rec;
      // 旧数据兜底：主库 images 表
      const mdb = await getDB();
      return await reqPromise(tx(mdb, 'images', 'readonly').get(id));
    },
    async loadImage(cover) {
      if (!cover) return null;
      // 1) 直接内嵌
      if (cover.dataUrl) return cover.dataUrl;

      // 2) 浏览器库 images 表：fileName "_images/xxx.png" -> id "xxx"
      const stem = cover.fileName
        ? String(cover.fileName).split('/').pop().replace(/\.[^.]+$/, '')
        : null;
      const id = cover.blobId || stem;
      if (id) {
        try {
          const rec = await this.getImage(id);
          if (rec) {
            if (rec.dataUrl) return rec.dataUrl;
            if (rec.blob) return URL.createObjectURL(rec.blob);
          }
        } catch (e) {}
      }

      // 3) 本地文件夹 _images（按无扩展名匹配，兼容 .png/.webp）
      if (stem && _dirHandle && _useFolder) {
        try {
          const dir = await _dirHandle.getDirectoryHandle('_images', { create: false });
          const base = cover.fileName.split('/').pop();
          const candidates = [base, base.replace(/\.[^.]+$/, '.png'), base.replace(/\.[^.]+$/, '.webp')];
          for (const name of candidates) {
            try {
              const f = await dir.getFileHandle(name, { create: false });
              const file = await f.getFile();
              return URL.createObjectURL(file);
            } catch (e) {}
          }
        } catch (e) {}
      }
      return null;
    },

    // ---- 导入导出 ----
    async importJSON(text, options) {
      const opt = options || {};
      let data;
      try { data = JSON.parse(text); }
      catch (e) { throw new Error('JSON 解析失败: ' + e.message); }
      const prompts = Array.isArray(data) ? data : (data.prompts || []);
      if (!prompts.length) throw new Error('文件里没有提示词数据');

      if (opt.clearFirst) await this.clearPrompts();

      const db = await getDB();
      let done = 0;
      const B = 200;
      while (done < prompts.length) {
        const batch = prompts.slice(done, done + B);
        const t = db.transaction('prompts', 'readwrite');
        const st = t.objectStore('prompts');
        for (const p of batch) {
          const q = Object.assign({}, p);
          if (!q.id) q.id = String(Date.now()) + '-' + Math.random().toString(16).slice(2, 10);
          q.createdAt = q.createdAt || Date.now();
          q.updatedAt = q.updatedAt || Date.now();
          st.put(q);
        }
        await txDone(t);
        done += batch.length;
        if (opt.onProgress) opt.onProgress(done, prompts.length);
      }

      if (!opt.clearFirst && data.categories && data.categories.length) {
        const cur = await this.getCategories();
        const merged = cur.slice();
        data.categories.forEach((c) => { if (!merged.includes(c)) merged.push(c); });
        await this.setCategories(merged);
      } else if (data.categories && data.categories.length) {
        await this.setCategories(data.categories);
      }
      return { imported: prompts.length, total: await this.count() };
    },

    async exportJSON() {
      return {
        version: '2.0',
        exportedAt: Date.now(),
        categories: await this.getCategories(),
        prompts: await this.getAll()
      };
    },

    async count() {
      const db = await getDB();
      return await countDB(db, 'prompts');
    },

    // ---- 分类 / 设置 ----
    _getChrome(key) {
      return new Promise((resolve) => chrome.storage.local.get(key, (r) => resolve(r[key])));
    },
    _setChrome(key, value) {
      return new Promise((resolve) => chrome.storage.local.set({ [key]: value }, resolve));
    },
    getCategories() { return this._getChrome(K_CATEGORIES); },
    setCategories(cats) { return this._setChrome(K_CATEGORIES, cats); },
    getCatOrder() { return this._getChrome('pm_cat_order'); },
    setCatOrder(order) { return this._setChrome('pm_cat_order', order); },
    getSettings() { return this._getChrome(K_SETTINGS); },
    saveSettings(patch) {
      return this._getChrome(K_SETTINGS).then((s) => this._setChrome(K_SETTINGS, Object.assign({}, s || {}, patch)));
    },

    // ---- 文件夹同步 ----
    _fsaDB() { return openNamed(FSA_DB, 1); },
    async _saveDirHandle(handle) {
      const db = await this._fsaDB();
      const t = db.transaction('handles', 'readwrite');
      const st = t.objectStore('handles');
      st.put(handle, 'dir');   // 旧版 key
      st.put(handle, 'root');  // 新版 key
      await txDone(t);
      db.close();
    },
    _loadDirHandle() {
      return new Promise((resolve) => {
        openNamed(FSA_DB, 1).then(async (db) => {
          try {
            const st = db.transaction('handles', 'readonly').objectStore('handles');
            // 兼容旧版 key 'dir' 和新版 key 'root'
            let h = await reqPromise(st.get('dir'));
            if (!h) h = await reqPromise(st.get('root'));
            resolve(h || null);
          } catch (e) { resolve(null); }
          db.close();
        }).catch(() => resolve(null));
      });
    },
    async _restoreDirHandle() {
      const h = await this._loadDirHandle();
      if (!h) return;
      try {
        const perm = await h.queryPermission({ mode: 'readwrite' });
        _dirHandle = h;
        _useFolder = perm === 'granted';
      } catch (e) { _dirHandle = null; _useFolder = false; }
    },
    async chooseFolder() {
      if (typeof window.showDirectoryPicker !== 'function') {
        throw new Error('当前浏览器不支持文件夹访问 API');
      }
      const h = await window.showDirectoryPicker({ mode: 'readwrite' });
      await this._saveDirHandle(h);
      _dirHandle = h;
      _useFolder = true;
      await this.saveSettings({ folderEnabled: true, folderName: h.name });
      return h.name;
    },
    async requestFolderPermission() {
      if (!_dirHandle) return false;
      const perm = await _dirHandle.requestPermission({ mode: 'readwrite' });
      _useFolder = perm === 'granted';
      return _useFolder;
    },
    async getFolderStatus() {
      const s = await this.getSettings() || {};
      let connected = _useFolder;
      if (_dirHandle && !connected) {
        try { connected = (await _dirHandle.queryPermission({ mode: 'readwrite' })) === 'granted'; }
        catch (e) { connected = false; }
        _useFolder = connected;
      }
      return { connected, name: s.folderName || '', hasHandle: !!_dirHandle };
    },
    async disconnectFolder() {
      _dirHandle = null; _useFolder = false;
      await this.saveSettings({ folderEnabled: false, folderName: '' });
    },

    async syncFromFolder() {
      if (!_dirHandle || !_useFolder) throw new Error('请先连接本地文件夹');
      let loaded = 0, updated = 0, failed = 0;
      const prompts = await this.getAll();
      const byId = new Map(prompts.map((p) => [p.id, p]));

      async function walk(dir, prefix) {
        for await (const entry of dir.values()) {
          if (entry.kind === 'directory') {
            if (entry.name === '_images') continue;
            const cat = prefix ? prefix + '/' + entry.name : entry.name;
            await walk(await dir.getDirectoryHandle(entry.name), cat);
          } else if (entry.name.toLowerCase().endsWith('.json')) {
            try {
              const file = await entry.getFile();
              const text = await file.text();
              const data = JSON.parse(text);
              const arr = Array.isArray(data) ? data : (data.prompts || []);
              for (const raw of arr) {
                const p = Object.assign({}, raw);
                p.id = p.id || String(Date.now()) + '-' + Math.random().toString(16).slice(2, 10);
                const fileCat = data.category || '';
                if (!p.category || p.category === '通用') {
                  p.category = prefix || fileCat || p.category || '通用';
                }
                if (byId.has(p.id)) updated++; else loaded++;
                byId.set(p.id, p);
              }
            } catch (e) { failed++; }
          }
        }
      }
      await walk(_dirHandle, '');

      const db = await getDB();
      let done = 0;
      const all = Array.from(byId.values());
      while (done < all.length) {
        const t = db.transaction('prompts', 'readwrite');
        const st = t.objectStore('prompts');
        all.slice(done, done + 200).forEach((p) => st.put(p));
        await txDone(t);
        done += 200;
      }
      return { loaded, updated, failed, total: all.length };
    },

    async exportToFolder() {
      if (!_dirHandle || !_useFolder) throw new Error('请先连接本地文件夹');
      const data = await this.exportJSON();
      const safe = (s) => String(s || '').replace(/[\\:*?"<>|]/g, '_');
      const groups = {};
      data.prompts.forEach((p) => {
        const c = p.category || '通用';
        (groups[c] = groups[c] || []).push(p);
      });
      let files = 0;
      for (const [cat, list] of Object.entries(groups)) {
        // 支持二级分类：父/子 逐级建目录
        let dir = _dirHandle;
        for (const seg of cat.split('/')) {
          dir = await dir.getDirectoryHandle(safe(seg), { create: true });
        }
        const fh = await dir.getFileHandle('prompts.json', { create: true });
        const w = await fh.createWritable();
        await w.write(JSON.stringify({ category: cat, prompts: list }, null, 2));
        await w.close();
        files++;
      }
      const root = await _dirHandle.getFileHandle('import_bundle.json', { create: true });
      const w = await root.createWritable();
      await w.write(JSON.stringify(data, null, 2));
      await w.close();
      return { categories: Object.keys(groups).length, files, total: data.prompts.length };
    }
  };

  global.PMStorage = PMStorage;
})(window);
