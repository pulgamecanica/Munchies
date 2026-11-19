/* Recipe box (/my/): make tables with AI, keep stock, cook from what you have. Talks to /api/* on the gateway. */
(() => {
  const { render, findStock, strip, esc, translateAction } = window.RecipeTable;
  const t = window.t;
  const lang = window.I18N.lang;
  const root = document.getElementById('box');
  const S = { me: null, stock: [], recipes: [], found: null, mode: 'url', busy: '', photo: null, scanning: [] };
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
    render(recipe, v, { stock: S.stock, actions: [
      saved
        ? { label: t('Delete'), run: async (r) => { if (!confirm(t('Delete this recipe?'))) return; await api('/api/recipes/' + encodeURIComponent(r.id), null, 'DELETE'); S.recipes = S.recipes.filter((x) => x.id !== r.id); v.innerHTML = ''; draw(); } }
        : { label: t('Save to my box'), primary: true, run: async (r) => { S.recipes.push(await api('/api/recipes', r)); say(t('Saved ✓')); draw(); open(r); } },
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

  function draw() {
    const u = S.me.usage;
    const left = Math.max(0, u.limit - u.used);
    const missing = (r) => r.steps.flatMap((s) => s.uses || []).filter((x) => !x.optional && !window.RecipeTable.isStaple(x.name) && !findStock(S.stock, x.name)).length;
    const viewer = root.querySelector('#viewer');
    const keep = viewer && viewer.innerHTML;
    root.innerHTML = `
      <section class="card usage">
        <div><b>${esc(t('Hi {name}', { name: S.me.member.name || S.me.member.email }))}</b> · ${t(u.tier === 'paid' ? 'Pro plan' : 'Free plan')}</div>
        <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="${u.limit}" aria-valuenow="${u.used}" aria-label="${t('AI uses this month')}"><i style="width:${u.limit ? Math.min(100, (u.used / u.limit) * 100) : 100}%"></i></div>
        <small>${t('{used} of {limit} AI uses this month ({left} left)', { used: u.used, limit: u.limit, left })}${u.tier === 'free' ? ` · <a href="#/portal/account/plans">${t('Get Pro for more')}</a>` : ''}${S.me.ai ? '' : ` · ${t('AI is off on this server')}`}</small>
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

      <section>
        <h2>${t('My recipes')} <small>${S.recipes.length}</small></h2>
        <div class="grid">${S.recipes.map((r, i) => { const m = missing(r); return `
          <button type="button" class="card post-card" data-open="${i}">
            <span class="rt-emoji" aria-hidden="true">${esc(r.emoji || '🍽️')}</span>
            <h3>${esc(r.title)}</h3><p>${esc(r.description || '')}</p>
            <span class="badge ${m ? 'warn' : 'ok'}">${m ? t('Missing {n}', { n: m }) : t('You have everything')}</span>
          </button>`; }).join('') || `<p class="empty">${t('Nothing saved yet. Make a table above.')}</p>`}</div>
      </section>

      <section class="card">
        <h2>${t('My stock')}</h2>
        ${zone('stock', { title: t('Snap your groceries or fridge'), hint: t('We spot every ingredient, you confirm.'), imgs: S.scanning, busy: S.busy === 'scan' ? t('Recognising…') : '', multiple: true, small: true })}
        <div class="row add-row">
          <form id="add" class="row grow"><input name="name" placeholder="${t('Add an ingredient by hand…')}" aria-label="${t('Ingredient')}"><button class="btn">${t('Add')}</button></form>
        </div>
        ${S.found ? `<div class="found"><b>${t('Recognised: untick anything wrong')}</b>
          ${S.found.map((it, i) => `<label class="line"><input type="checkbox" data-pick="${i}" ${it.pick ? 'checked' : ''}> ${esc(it.name)} <small>${esc(it.quantity)} ${esc(it.unit)} ${esc(it.note)}</small></label>`).join('')}
          <div class="row"><button type="button" class="btn primary" data-addfound>${t('Add to stock')}</button><button type="button" class="btn" data-dropfound>${t('Discard')}</button></div></div>` : ''}
        <ul class="stock">${S.stock.map((s, i) => `<li>
          <span><b>${esc(s.name)}</b> ${s.note ? `<small>${esc(s.note)}</small>` : ''}</span>
          <span class="qty"><button type="button" data-bump="${i}" data-d="-1" aria-label="${esc(t('One less {name}', { name: s.name }))}">−</button>${esc(s.qty)} <small>${esc(s.unit)}</small><button type="button" data-bump="${i}" data-d="1" aria-label="${esc(t('One more {name}', { name: s.name }))}">+</button></span>
        </li>`).join('') || `<li class="empty">${t('Empty. Add something above.')}</li>`}</ul>
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
    const el = e.target.closest('[data-mode],[data-open],[data-bump],[data-addfound],[data-dropfound],[data-clear]');
    if (!el) return;
    const d = el.dataset;
    if (d.clear) { setPhoto(null); draw(); return; }
    if (d.mode) { S.mode = d.mode; draw(); }
    else if (d.open) open(S.recipes[Number(d.open)]);
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
      else S.stock.push({ id: uid(), name: it.name, qty: Number(it.quantity) || 1, unit: it.unit || 'pcs', note: it.note || '' });
    }
    saveStock();
  }

  Promise.all([api('/api/me'), api('/api/stock'), api('/api/recipes')])
    .then(([me, stock, recipes]) => { Object.assign(S, { me, stock, recipes }); draw(); })
    .catch((e) => { root.innerHTML = `<p class="empty">${esc(e.message)}</p>`; });
})();
