/* Recipe box (/my/): make tables with AI, keep stock, cook from what you have. Talks to /api/* on the gateway. */
(() => {
  const { render, findStock, strip, esc, translateAction, collectionsFor } = window.RecipeTable;
  const t = window.t;
  const lang = window.I18N.lang;
  const root = document.getElementById('box');
  const S = { me: null, stock: [], recipes: [], cols: [], tags: [], tagMode: 'off', rot: {}, openCol: null, found: null, mode: 'url', busy: '', photo: null, scanning: [] };
  const uid = () => 'x' + Math.random().toString(36).slice(2, 10);

  async function api(path, body, method = body ? 'POST' : 'GET') {
    const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(t(d.error || 'Request failed'));
    return d;
  }
  const say = (m) => { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.append(t); setTimeout(() => t.remove(), 3500); };

  let saveT;
  const saveStock = () => { clearTimeout(saveT); saveT = setTimeout(() => api('/api/stock', S.stock, 'PUT').catch((e) => say(e.message)), 300); };

  async function fileToDataUrl(file, max = 1400) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error(t('Could not read that image.'))); i.src = url; });
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.85);
    } finally { URL.revokeObjectURL(url); }
  }

  // Runs an AI call, keeps the usage meter honest either way.
  async function ai(label, fn) {
    S.busy = label; draw();
    try { return await fn(); }
    catch (e) { say(e.message); }
    finally { S.busy = ''; S.me = await api('/api/me').catch(() => S.me); draw(); }
  }

  function open(recipe) {
    const v = root.querySelector('#viewer');
    const saved = S.recipes.some((r) => r.id === recipe.id);
    const keep = (r) => { const i = S.recipes.findIndex((x) => x.id === r.id); if (i < 0) S.recipes.push(r); else S.recipes[i] = r; draw(); };
    render(recipe, v, { stock: S.stock, collections: collectionsFor(S.cols, keep), actions: [
      saved
        ? { label: t('Delete'), run: async (r) => { if (!confirm(t('Delete this recipe?'))) return; await api('/api/recipes/' + encodeURIComponent(r.id), null, 'DELETE'); S.recipes = S.recipes.filter((x) => x.id !== r.id); v.innerHTML = ''; draw(); } }
        : { label: t('Save'), primary: true, run: async (r) => { keep(await api('/api/recipes', r)); say(t('Saved ✓')); open(r); } },
      translateAction(recipe, (tr) => { S.me.usage.used++; draw(); open(tr); }),
      { label: t('I cooked it'), run: (r) => {
        const used = r.steps.flatMap((s) => s.uses || []);
        S.stock = S.stock.map((it) => (used.some((u) => findStock([it], u.name)) ? { ...it, qty: Math.max(0, it.qty - 1) } : it)).filter((it) => it.qty > 0);
        saveStock(); say(t('Took one of each from your stock')); draw();
      } },
      { label: t('Copy for Ghost'), run: async (r, b) => {
        // Staff: paste into an HTML card in a Ghost post to publish this table.
        await navigator.clipboard.writeText(`<script type="application/recipe+json">${JSON.stringify(r).replace(/</g, '\\u003c')}</script>`).catch(() => {});
        b.textContent = t('Copied ✓');
      } },
    ].filter(Boolean) });
    v.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* Photo drop zone: drag & drop, tap/click to browse, paste, or open the camera on phones.
     The file input covers the whole zone, so it is keyboard-focusable and accepts native drops. */
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.2-1.8A2 2 0 0 1 11 3.3h2a2 2 0 0 1 1.7.9L15.9 6h1.6A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.5" r="3.5"/></svg>';
  const zone = (id, { title, hint, imgs = [], busy = '', multiple = false, small = false }) => `
    <div class="drop${small ? ' sm' : ''}${imgs.length ? ' has' : ''}${busy ? ' busy' : ''}" data-zone="${id}">
      ${imgs.length ? `
        <img src="${imgs[0]}" alt="">
        ${imgs.length > 1 ? `<span class="drop-count">+${imgs.length - 1}</span>` : ''}
        <div class="scan" aria-hidden="true"></div>
        <div class="drop-bar"><span>${esc(busy || t('Ready to read'))}</span>
          ${busy ? '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>' : `<button type="button" class="drop-x" data-clear="${id}" aria-label="${esc(t('Remove photo'))}">✕</button>`}</div>`
      : `
        <div class="drop-icon">${ICON}</div>
        <h3>${esc(title)}</h3>
        <p>${esc(hint)}</p>
        <div class="drop-btns"><label class="btn primary cam">${ICON}${esc(t('Take a photo'))}<input type="file" accept="image/*" capture="environment" ${multiple ? 'multiple' : ''} data-drop="${id}" hidden></label></div>`}
      <input class="drop-input" type="file" accept="image/*" ${multiple ? 'multiple' : ''} data-drop="${id}" aria-label="${esc(title)}" ${busy ? 'disabled' : ''}>
    </div>`;

  function setPhoto(file) {
    if (S.photo) URL.revokeObjectURL(S.photo.url);
    S.photo = file ? { file, url: URL.createObjectURL(file) } : null;
  }
  async function scanStock(files) {
    S.scanning = files.map((f) => URL.createObjectURL(f));
    await ai('scan', async () => {
      const all = [];
      for (const f of files) all.push(...(await api('/api/recognize', { image: await fileToDataUrl(f), lang })).items);
      S.found = all.map((it) => ({ ...it, pick: true }));
      if (!all.length) say(t('No ingredients recognised. Try a closer photo.'));
    });
    S.scanning.forEach((u) => URL.revokeObjectURL(u)); S.scanning = []; draw();
  }
  function takeFiles(id, files) {
    const imgs = [...files].filter((f) => f.type.startsWith('image/'));
    if (!imgs.length || S.busy) return;
    if (id === 'convert') { setPhoto(imgs[0]); S.mode = 'photo'; draw(); }
    else scanStock(imgs);
  }

  /* Collections as 3D stacks: cards recede in Z, 4 visible. Pass through with arrows/swipe/keys, click the top card to open it,
     "Open" fans the whole collection out into a grid. Passing only updates --i on existing cards, so CSS animates the move. */
  const VISIBLE = 4;
  const groups = () => {
    const g = S.cols.map((c) => ({ id: c.id, name: c.name, own: true, recipes: S.recipes.filter((r) => (r.collections || []).includes(c.id)) }));
    const loose = S.recipes.filter((r) => !(r.collections || []).length);
    return loose.length ? [...g, { id: 'unsorted', name: t('Unsorted'), recipes: loose }] : g;
  };
  const missingOf = (r) => r.steps.flatMap((s) => s.uses || []).filter((x) => !x.optional && !window.RecipeTable.isStaple(x.name) && !findStock(S.stock, x.name)).length;
  const posOf = (k, n, rot) => ((k - rot) % n + n) % n;
  const cardFace = (r) => { const m = missingOf(r); return `
    <span class="scard-emoji" aria-hidden="true">${esc(r.emoji || '🍽️')}</span>
    <span class="scard-title">${esc(r.title)}</span>
    <span class="badge ${m ? 'warn' : 'ok'}">${m ? t('Missing {n}', { n: m }) : t('You have everything')}</span>`; };
  function stackHTML(g) {
    const n = g.recipes.length, rot = S.rot[g.id] || 0;
    const cards = g.recipes.slice(0, 12).map((r, k) => { const i = posOf(k, Math.min(n, 12), rot); return `
      <button type="button" class="scard" data-rid="${esc(r.id)}" style="--i:${i}"${i ? ' tabindex="-1" aria-hidden="true"' : ''}${i >= VISIBLE ? ' data-far' : ''}>${cardFace(r)}</button>`; }).join('');
    return `
      <article class="cstack${n ? '' : ' is-empty'}" data-stack="${esc(g.id)}">
        <div class="stack-cards" tabindex="${n ? 0 : -1}" role="group" aria-label="${esc(g.name)}">
          ${cards || `<div class="scard ghost" style="--i:0"><span>${esc(t('Nothing here yet. Use "Add to collection" on any recipe table.'))}</span></div><div class="scard ghost" style="--i:1"></div><div class="scard ghost" style="--i:2"></div>`}
        </div>
        <footer class="stack-foot">
          <div><h3>${esc(g.name)}</h3><small>${esc(t('{n} recipes', { n }))}</small></div>
          <div class="stack-nav">
            ${n > 1 ? `<button type="button" class="icon-btn" data-pass="-1" aria-label="${esc(t('Previous'))}">‹</button><button type="button" class="icon-btn" data-pass="1" aria-label="${esc(t('Next'))}">›</button>` : ''}
            ${n ? `<button type="button" class="btn" data-expand>${esc(t('Open'))}</button>` : ''}
          </div>
        </footer>
      </article>`;
  }
  function pass(id, dir) {
    const el = root.querySelector(`[data-stack="${CSS.escape(id)}"]`);
    const cards = [...el.querySelectorAll('.scard[data-rid]')];
    if (cards.length < 2) return;
    S.rot[id] = (S.rot[id] || 0) + dir;
    cards.forEach((c, k) => {
      const i = posOf(k, cards.length, S.rot[id]);
      c.style.setProperty('--i', i);
      c.toggleAttribute('data-far', i >= VISIBLE);
      c.tabIndex = i ? -1 : 0;
      if (i) c.setAttribute('aria-hidden', 'true'); else c.removeAttribute('aria-hidden');
    });
  }
  function expandedHTML() {
    const g = groups().find((x) => x.id === S.openCol);
    if (!g) return '';
    return `
      <div class="col-open" id="col-open">
        <div class="col-open-head">
          <h3>${esc(g.name)} <small>${esc(t('{n} recipes', { n: g.recipes.length }))}</small></h3>
          <div class="row">
            ${g.own ? `<button type="button" class="btn" data-rename>${esc(t('Rename'))}</button><button type="button" class="btn" data-delcol>${esc(t('Delete'))}</button>` : ''}
            <button type="button" class="btn primary" data-close>${esc(t('Close'))}</button>
          </div>
        </div>
        <div class="grid fan">${g.recipes.map((r, k) => `<button type="button" class="card post-card" data-rid="${esc(r.id)}" style="--k:${k}">${cardFace(r)}</button>`).join('')}</div>
      </div>`;
  }

  /* Stock grouped under the admin's tags. Icons are drawn as CSS masks so they take the text colour and never run code. */
  const tagIcon = (svg) => `<span class="ticon" aria-hidden="true" style="${esc(`--icon:url("data:image/svg+xml,${encodeURIComponent(svg)}")`)}"></span>`;
  const tagName = (tg) => tg.names[lang] || tg.names.en || tg.id;
  function stockHTML() {
    if (!S.stock.length) return `<p class="empty">${t('Empty. Add something above.')}</p>`;
    const rows = S.stock.map((s, i) => ({ s, i }));
    const known = new Set(S.tags.map((tg) => tg.id));
    const sections = [
      ...S.tags.map((tg) => ({ tg, items: rows.filter((x) => x.s.tag === tg.id) })),
      { tg: null, items: rows.filter((x) => !known.has(x.s.tag)) },
    ].filter((x) => x.items.length);
    return sections.map(({ tg, items }) => `
      <div class="shelf">
        <h4>${tg ? tagIcon(tg.icon) : '<span class="ticon none" aria-hidden="true"></span>'}${esc(tg ? tagName(tg) : t('Other'))} <small>${items.length}</small></h4>
        <ul class="stock">${items.map(({ s, i }) => `<li>
          <span><b>${esc(s.name)}</b> ${s.note ? `<small>${esc(s.note)}</small>` : ''}</span>
          <span class="qty"><button type="button" data-bump="${i}" data-d="-1" aria-label="${esc(t('One less {name}', { name: s.name }))}">−</button>${esc(s.qty)} <small>${esc(s.unit)}</small><button type="button" data-bump="${i}" data-d="1" aria-label="${esc(t('One more {name}', { name: s.name }))}">+</button></span>
        </li>`).join('')}</ul>
      </div>`).join('');
  }

  function draw() {
    const u = S.me.usage;
    const left = Math.max(0, u.limit - u.used);
    const viewer = root.querySelector('#viewer');
    const keep = viewer && viewer.innerHTML;
    root.innerHTML = `
      <section class="card usage">
        <div><b>${esc(t('Hi {name}', { name: S.me.member.name || S.me.member.email }))}</b> · ${t(u.tier === 'paid' ? 'Pro plan' : 'Free plan')}</div>
        <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="${u.limit}" aria-valuenow="${u.used}" aria-label="${t('AI uses this month')}"><i style="width:${u.limit ? Math.min(100, (u.used / u.limit) * 100) : 100}%"></i></div>
        <small>${t('{used} of {limit} AI uses this month ({left} left)', { used: u.used, limit: u.limit, left })}${u.tier === 'free' ? ` · <a href="#/portal/account/plans">${t('Get Pro for more')}</a>` : ''}${u.bonus ? ` · <b>${t('+{n} bonus uses', { n: u.bonus })}</b>` : ''}${S.me.ai ? '' : ` · ${t('AI is off on this server')}`}</small>
      </section>

      <section class="card">
        <h2>${t('Make a table')}</h2>
        <div class="seg" role="tablist">${[['url', 'Link'], ['text', 'Paste text'], ['photo', 'Cookbook photo']].map(([k, l]) => `<button type="button" role="tab" aria-selected="${S.mode === k}" class="${S.mode === k ? 'on' : ''}" data-mode="${k}">${t(l)}</button>`).join('')}</div>
        <form id="convert" class="stack">
          ${S.mode === 'url' ? '<input name="url" type="url" required placeholder="https://a-recipe-blog.com/banana-bread" aria-label="' + t('Recipe link') + '">' : ''}
          ${S.mode === 'text' ? `<textarea name="text" rows="${S.draft ? 14 : 6}" required placeholder="${t('Paste the whole recipe here…')}" aria-label="${t('Recipe text')}">${esc(S.draft || '')}</textarea>` : ''}
          ${S.mode === 'photo' ? zone('convert', { title: t('Photo of a cookbook page'), hint: t('Drop it here, tap to browse, or paste it'), imgs: S.photo ? [S.photo.url] : [], busy: S.busy === 'convert' ? t('Building your table…') : S.busy === 'ocr' ? t('Reading…') : '' }) : ''}
          <div class="row">
            <button class="btn primary" ${S.busy ? 'disabled' : ''}>${t(S.busy === 'convert' ? 'Building your table…' : 'Make my table →')}</button>
            ${S.mode === 'photo' ? `<button class="btn" name="ocr" ${S.busy ? 'disabled' : ''}>${t(S.busy === 'ocr' ? 'Reading…' : 'Just read the text (free)')}</button>` : ''}
          </div>
        </form>
      </section>

      <section id="viewer"></section>

      <section class="collections">
        <div class="sec-head">
          <h2>${t('My collections')} <small>${S.cols.length}</small></h2>
          <button type="button" class="btn" data-newcol>+ ${esc(t('New collection'))}</button>
        </div>
        <div class="stacks">${groups().map(stackHTML).join('')}</div>
        ${expandedHTML()}
      </section>

      <section class="card">
        <div class="sec-head">
          <h2>${t('My stock')}</h2>
          ${S.tagMode !== 'off' && S.stock.length ? `<button type="button" class="btn" data-sort ${S.busy ? 'disabled' : ''}>${esc(t(S.busy === 'sort' ? 'Sorting…' : 'Sort my stock with AI'))}</button>` : ''}
        </div>
        ${zone('stock', { title: t('Snap your groceries or fridge'), hint: t('We spot every ingredient, you confirm.'), imgs: S.scanning, busy: S.busy === 'scan' ? t('Recognising…') : '', multiple: true, small: true })}
        <div class="row add-row">
          <form id="add" class="row grow"><input name="name" placeholder="${t('Add an ingredient by hand…')}" aria-label="${t('Ingredient')}"><button class="btn">${t('Add')}</button></form>
        </div>
        ${S.found ? `<div class="found"><b>${t('Recognised: untick anything wrong')}</b>
          ${S.found.map((it, i) => `<label class="line"><input type="checkbox" data-pick="${i}" ${it.pick ? 'checked' : ''}> ${esc(it.name)} <small>${esc(it.quantity)} ${esc(it.unit)} ${esc(it.note)}</small></label>`).join('')}
          <div class="row"><button type="button" class="btn primary" data-addfound>${t('Add to stock')}</button><button type="button" class="btn" data-dropfound>${t('Discard')}</button></div></div>` : ''}
        ${stockHTML()}
      </section>

      <section class="card">
        <h2>${t('Cook from my stock')}</h2>
        <form id="gen" class="stack">
          <textarea name="notes" rows="2" placeholder="${t('Optional: vegetarian, under 20 minutes, Italian…')}" aria-label="${t('Preferences')}"></textarea>
          <button class="btn primary" ${S.busy || !S.stock.length ? 'disabled' : ''}>${t(S.busy === 'gen' ? 'Cooking up an idea…' : 'Generate a recipe from everything I have')}</button>
        </form>
      </section>`;
    if (keep) root.querySelector('#viewer').replaceWith(viewer);
  }

  root.addEventListener('click', (e) => {
    if (swiped) { swiped = false; return; }
    const el = e.target.closest('[data-mode],[data-open],[data-bump],[data-addfound],[data-dropfound],[data-clear],[data-rid],[data-pass],[data-expand],[data-close],[data-newcol],[data-rename],[data-delcol],[data-sort]');
    if (!el) return;
    const d = el.dataset;
    const stack = el.closest('[data-stack]');
    if (d.clear) { setPhoto(null); draw(); return; }
    if (d.pass) return pass(stack.dataset.stack, Number(d.pass));
    if (d.rid) {
      // In a stack, the front card opens; a card further back comes to the front first.
      if (stack && el.style.getPropertyValue('--i').trim() !== '0') return pass(stack.dataset.stack, Number(el.style.getPropertyValue('--i')));
      return open(S.recipes.find((r) => r.id === d.rid));
    }
    if ('expand' in d) { S.openCol = stack.dataset.stack; draw(); return root.querySelector('#col-open').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    if ('close' in d) { S.openCol = null; return draw(); }
    if ('newcol' in d || 'rename' in d) {
      const cur = S.cols.find((c) => c.id === S.openCol);
      const name = (prompt(t('Collection name'), 'rename' in d && cur ? cur.name : '') || '').trim();
      if (!name) return;
      if ('rename' in d) { api('/api/collections/' + cur.id, { name }, 'PATCH').then(() => { cur.name = name; draw(); }).catch((x) => say(x.message)); }
      else api('/api/collections', { name }).then((c) => { S.cols.push(c); draw(); }).catch((x) => say(x.message));
      return;
    }
    if ('delcol' in d) {
      if (!confirm(t('Delete this collection? Its recipes stay in your kitchen.'))) return;
      const id = S.openCol;
      return api('/api/collections/' + id, null, 'DELETE').then(() => {
        S.cols = S.cols.filter((c) => c.id !== id);
        S.recipes.forEach((r) => { r.collections = (r.collections || []).filter((x) => x !== id); });
        S.openCol = null; draw();
      }).catch((x) => say(x.message));
    }
    if ('sort' in d) {
      return ai('sort', async () => {
        const r = await api('/api/stock/sort', { all: false });
        S.stock = r.stock;
        if (r.created.length) S.tags = (await api('/api/tags')).tags;
      });
    }
    if (d.mode) { S.mode = d.mode; draw(); }
    else if (d.bump) { const s = S.stock[Number(d.bump)]; s.qty = Math.max(0, s.qty + Number(d.d)); S.stock = S.stock.filter((x) => x.qty > 0); saveStock(); draw(); }
    else if ('addfound' in d) { merge(S.found.filter((x) => x.pick)); S.found = null; draw(); }
    else if ('dropfound' in d) { S.found = null; draw(); }
  });
  root.addEventListener('change', async (e) => {
    if (e.target.dataset.pick) S.found[Number(e.target.dataset.pick)].pick = e.target.checked;
    if (e.target.dataset.drop) takeFiles(e.target.dataset.drop, e.target.files);
  });
  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (e.target.id === 'add') { if (f.get('name').trim()) merge([{ name: f.get('name').trim(), quantity: 1, unit: 'pcs' }]); draw(); return; }
    if (e.target.id === 'gen') {
      const r = await ai('gen', () => api('/api/generate', { ingredients: S.stock.map((s) => s.name), notes: f.get('notes'), lang }));
      if (r) open(r);
    }
    if (e.target.id === 'convert' && e.submitter && e.submitter.name === 'ocr') {
      // Free OCR: drop the text into the Paste tab so it can be fixed up before spending an AI use.
      if (!S.photo) return say(t('Add a photo first.'));
      const image = await fileToDataUrl(S.photo.file, 2400);
      S.busy = 'ocr'; draw();
      try { S.draft = (await api('/api/ocr', { image })).text; S.mode = 'text'; setPhoto(null); } catch (err) { say(err.message); }
      S.busy = ''; draw();
      return;
    }
    if (e.target.id === 'convert') {
      if (S.mode === 'photo' && !S.photo) return say(t('Add a photo first.'));
      const body = { lang, ...(S.mode === 'photo' ? { image: await fileToDataUrl(S.photo.file, 2400) } : { [S.mode]: f.get(S.mode) }) };
      const r = await ai('convert', () => api('/api/convert', body));
      if (r) open(r);
    }
  });

  // Stacks: swipe sideways or use arrow keys to pass through; Enter opens the front card.
  let swiped = false, sx = null;
  root.addEventListener('pointerdown', (e) => { if (e.target.closest('.stack-cards')) sx = e.clientX; });
  root.addEventListener('pointerup', (e) => {
    const st = e.target.closest('[data-stack]');
    if (sx === null || !st) return;
    const dx = e.clientX - sx; sx = null;
    if (Math.abs(dx) > 40) { swiped = true; pass(st.dataset.stack, dx < 0 ? 1 : -1); }
  });
  root.addEventListener('keydown', (e) => {
    const box = e.target.closest('.stack-cards');
    if (!box) return;
    const id = box.closest('[data-stack]').dataset.stack;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); pass(id, e.key === 'ArrowRight' ? 1 : -1); }
    if ((e.key === 'Enter' || e.key === ' ') && e.target === box) { e.preventDefault(); box.querySelector('.scard[style*="--i:0"], .scard[style*="--i: 0"]')?.click(); }
  });

  // Drag highlight + paste an image from the clipboard anywhere on the page.
  root.addEventListener('dragover', (e) => { const z = e.target.closest('.drop'); root.querySelectorAll('.drop.over').forEach((x) => x !== z && x.classList.remove('over')); if (z) z.classList.add('over'); });
  root.addEventListener('dragleave', (e) => { const z = e.target.closest('.drop'); if (z && !z.contains(e.relatedTarget)) z.classList.remove('over'); });
  root.addEventListener('drop', (e) => { const z = e.target.closest('.drop'); if (z) z.classList.remove('over'); });
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length && !e.target.closest('input, textarea')) { e.preventDefault(); takeFiles('convert', files); }
  });

  function merge(items) {
    for (const it of items) {
      const ex = S.stock.find((x) => strip(x.name) === strip(it.name) && x.unit === (it.unit || 'pcs'));
      if (ex) ex.qty += Number(it.quantity) || 1;
      else S.stock.push({ id: uid(), name: it.name, qty: Number(it.quantity) || 1, unit: it.unit || 'pcs', note: it.note || '', tag: it.tag || '' });
    }
    saveStock();
  }

  Promise.all([api('/api/me'), api('/api/stock'), api('/api/recipes'), api('/api/collections?lang=' + lang), api('/api/tags')])
    .then(([me, stock, recipes, cols, tags]) => { Object.assign(S, { me, stock, recipes, cols, tags: tags.tags, tagMode: tags.mode }); draw(); })
    .catch((e) => { root.innerHTML = `<p class="empty">${esc(e.message)}</p>`; });
})();
