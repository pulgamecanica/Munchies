/* Recipe box (/my/): make tables with AI, keep stock, cook from what you have. Talks to /api/* on the gateway. */
(() => {
  const { render, findStock, strip, esc } = window.RecipeTable;
  const root = document.getElementById('box');
  const S = { me: null, stock: [], recipes: [], found: null, mode: 'url', busy: '' };
  const uid = () => 'x' + Math.random().toString(36).slice(2, 10);

  async function api(path, body, method = body ? 'POST' : 'GET') {
    const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
    return d;
  }
  const say = (m) => { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.append(t); setTimeout(() => t.remove(), 3500); };

  let saveT;
  const saveStock = () => { clearTimeout(saveT); saveT = setTimeout(() => api('/api/stock', S.stock, 'PUT').catch((e) => say(e.message)), 300); };

  async function fileToDataUrl(file, max = 1400) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('Could not read that image.')); i.src = url; });
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
        ? { label: 'Delete', run: async (r) => { if (!confirm('Delete this recipe?')) return; await api('/api/recipes/' + encodeURIComponent(r.id), null, 'DELETE'); S.recipes = S.recipes.filter((x) => x.id !== r.id); v.innerHTML = ''; draw(); } }
        : { label: 'Save to my box', primary: true, run: async (r) => { S.recipes.push(await api('/api/recipes', r)); say('Saved ✓'); draw(); open(r); } },
      { label: 'I cooked it', run: (r) => {
        const used = r.steps.flatMap((s) => s.uses || []);
        S.stock = S.stock.map((it) => (used.some((u) => findStock([it], u.name)) ? { ...it, qty: Math.max(0, it.qty - 1) } : it)).filter((it) => it.qty > 0);
        saveStock(); say('Took one of each from your stock'); draw();
      } },
      { label: 'Copy for Ghost', run: async (r, b) => {
        // Staff: paste into an HTML card in a Ghost post to publish this table.
        await navigator.clipboard.writeText(`<script type="application/recipe+json">${JSON.stringify(r).replace(/</g, '\\u003c')}</script>`).catch(() => {});
        b.textContent = 'Copied ✓';
      } },
    ] });
    v.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function draw() {
    const u = S.me.usage;
    const left = Math.max(0, u.limit - u.used);
    const missing = (r) => r.steps.flatMap((s) => s.uses || []).filter((x) => !x.optional && !window.RecipeTable.isStaple(x.name) && !findStock(S.stock, x.name)).length;
    const viewer = root.querySelector('#viewer');
    const keep = viewer && viewer.innerHTML;
    root.innerHTML = `
      <section class="card usage">
        <div><b>Hi ${esc(S.me.member.name || S.me.member.email)}</b> · ${u.tier === 'paid' ? 'Pro' : 'Free'} plan</div>
        <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="${u.limit}" aria-valuenow="${u.used}" aria-label="AI uses this month"><i style="width:${u.limit ? Math.min(100, (u.used / u.limit) * 100) : 100}%"></i></div>
        <small>${u.used} of ${u.limit} AI uses this month (${left} left)${u.tier === 'free' ? ' · <a href="#/portal/account/plans">Get Pro for more</a>' : ''}${S.me.ai ? '' : ' · AI is off on this server'}</small>
      </section>

      <section class="card">
        <h2>Make a table</h2>
        <div class="seg" role="tablist">${[['url', 'Link'], ['text', 'Paste text'], ['photo', 'Cookbook photo']].map(([k, l]) => `<button type="button" role="tab" aria-selected="${S.mode === k}" class="${S.mode === k ? 'on' : ''}" data-mode="${k}">${l}</button>`).join('')}</div>
        <form id="convert" class="stack">
          ${S.mode === 'url' ? '<input name="url" type="url" required placeholder="https://a-recipe-blog.com/banana-bread" aria-label="Recipe link">' : ''}
          ${S.mode === 'text' ? '<textarea name="text" rows="6" required placeholder="Paste the whole recipe here…" aria-label="Recipe text"></textarea>' : ''}
          ${S.mode === 'photo' ? '<input name="photo" type="file" accept="image/*" required aria-label="Cookbook page photo">' : ''}
          <button class="btn primary" ${S.busy ? 'disabled' : ''}>${S.busy === 'convert' ? 'Building your table…' : 'Make my table →'}</button>
        </form>
      </section>

      <section id="viewer"></section>

      <section>
        <h2>My recipes <small>${S.recipes.length}</small></h2>
        <div class="grid">${S.recipes.map((r, i) => { const m = missing(r); return `
          <button type="button" class="card post-card" data-open="${i}">
            <span class="rt-emoji" aria-hidden="true">${esc(r.emoji || '🍽️')}</span>
            <h3>${esc(r.title)}</h3><p>${esc(r.description || '')}</p>
            <span class="badge ${m ? 'warn' : 'ok'}">${m ? `Missing ${m}` : 'You have everything'}</span>
          </button>`; }).join('') || '<p class="empty">Nothing saved yet. Make a table above.</p>'}</div>
      </section>

      <section class="card">
        <h2>My stock</h2>
        <div class="row">
          <label class="btn primary">${S.busy === 'scan' ? 'Recognising…' : '📷 Add by photo'}<input type="file" accept="image/*" capture="environment" multiple hidden data-scan ${S.busy ? 'disabled' : ''}></label>
          <form id="add" class="row grow"><input name="name" placeholder="Add an ingredient by hand…" aria-label="Ingredient"><button class="btn">Add</button></form>
        </div>
        ${S.found ? `<div class="found"><b>Recognised: untick anything wrong</b>
          ${S.found.map((it, i) => `<label class="line"><input type="checkbox" data-pick="${i}" ${it.pick ? 'checked' : ''}> ${esc(it.name)} <small>${esc(it.quantity)} ${esc(it.unit)} ${esc(it.note)}</small></label>`).join('')}
          <div class="row"><button type="button" class="btn primary" data-addfound>Add to stock</button><button type="button" class="btn" data-dropfound>Discard</button></div></div>` : ''}
        <ul class="stock">${S.stock.map((s, i) => `<li>
          <span><b>${esc(s.name)}</b> ${s.note ? `<small>${esc(s.note)}</small>` : ''}</span>
          <span class="qty"><button type="button" data-bump="${i}" data-d="-1" aria-label="One less ${esc(s.name)}">−</button>${esc(s.qty)} <small>${esc(s.unit)}</small><button type="button" data-bump="${i}" data-d="1" aria-label="One more ${esc(s.name)}">+</button></span>
        </li>`).join('') || '<li class="empty">Empty. Add something above.</li>'}</ul>
      </section>

      <section class="card">
        <h2>Cook from my stock</h2>
        <form id="gen" class="stack">
          <textarea name="notes" rows="2" placeholder="Optional: vegetarian, under 20 minutes, Italian…" aria-label="Preferences"></textarea>
          <button class="btn primary" ${S.busy || !S.stock.length ? 'disabled' : ''}>${S.busy === 'gen' ? 'Cooking up an idea…' : 'Generate a recipe from everything I have'}</button>
        </form>
      </section>`;
    if (keep) root.querySelector('#viewer').replaceWith(viewer);
  }

  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-mode],[data-open],[data-bump],[data-addfound],[data-dropfound]');
    if (!t) return;
    const d = t.dataset;
    if (d.mode) { S.mode = d.mode; draw(); }
    else if (d.open) open(S.recipes[Number(d.open)]);
    else if (d.bump) { const s = S.stock[Number(d.bump)]; s.qty = Math.max(0, s.qty + Number(d.d)); S.stock = S.stock.filter((x) => x.qty > 0); saveStock(); draw(); }
    else if ('addfound' in d) { merge(S.found.filter((x) => x.pick)); S.found = null; draw(); }
    else if ('dropfound' in d) { S.found = null; draw(); }
  });
  root.addEventListener('change', async (e) => {
    if (e.target.dataset.pick) S.found[Number(e.target.dataset.pick)].pick = e.target.checked;
    if (e.target.hasAttribute('data-scan')) {
      const files = [...e.target.files];
      await ai('scan', async () => {
        const all = [];
        for (const f of files) all.push(...(await api('/api/recognize', { image: await fileToDataUrl(f) })).items);
        S.found = all.map((it) => ({ ...it, pick: true }));
        if (!all.length) say('No ingredients recognised. Try a closer photo.');
      });
    }
  });
  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (e.target.id === 'add') { if (f.get('name').trim()) merge([{ name: f.get('name').trim(), quantity: 1, unit: 'pcs' }]); draw(); return; }
    if (e.target.id === 'gen') {
      const r = await ai('gen', () => api('/api/generate', { ingredients: S.stock.map((s) => s.name), notes: f.get('notes') }));
      if (r) open(r);
    }
    if (e.target.id === 'convert') {
      const body = S.mode === 'photo' ? { image: await fileToDataUrl(f.get('photo'), 2000) } : { [S.mode]: f.get(S.mode) };
      const r = await ai('convert', () => api('/api/convert', body));
      if (r) open(r);
    }
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
