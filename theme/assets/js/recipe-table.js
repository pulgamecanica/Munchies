/* Recipe tables: ingredients down the left in the order they're used, each step a cell spanning
   exactly what it combines, everything converging left to right into the finished dish.
   Recipe JSON: { title, servings, steps: [{ text, after?: [earlier step indices], uses: [{ name, amount, unit, optional }] }] }
   "after" defaults to the previous step, so a plain list of steps renders as a staircase. */
(() => {
  const t = window.t || ((k) => k);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const strip = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const STAPLES = ['salt', 'pepper', 'oil', 'olive oil', 'water', 'sel', 'poivre', 'huile', 'eau'];
  const STOP = new Set(['and', 'the', 'fresh', 'with', 'large', 'small', 'ripe', 'pack', 'whole']);
  const words = (s) => strip(s).split(/[^a-z]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.replace(/s$/, ''));
  const isStaple = (name) => STAPLES.includes(strip(name).trim());
  const matches = (a, b) => { const wb = words(b); return words(a).some((w) => wb.includes(w)); };
  const findStock = (stock, name) => (stock || []).find((s) => s.qty > 0 && matches(name, s.name));
  const fmt = (n) => (!n && n !== 0 ? '' : String(n < 10 ? Math.round(n * 10) / 10 : Math.round(n)));
  const amount = (u, f) => [u.amount ? fmt(u.amount * f) : '', u.unit || ''].join(' ').trim();

  function layout(recipe) {
    const nodes = (recipe.steps || []).map((s, i) => ({ s, i, kids: [], parent: null }));
    nodes.forEach((n, i) => {
      for (const j of Array.isArray(n.s.after) ? n.s.after : i ? [i - 1] : []) {
        const k = nodes[j];
        if (k && j < i && !k.parent) { k.parent = n; n.kids.push(k); }
      }
    });
    const roots = nodes.filter((n) => !n.parent);
    const root = roots.pop();
    if (!root) return { rows: [], cells: [], prep: [], cols: 0 };
    roots.forEach((r) => (r.parent = root));
    root.kids.unshift(...roots);
    const rows = [];
    const walk = (n) => { n.r0 = rows.length; n.kids.forEach(walk); (n.s.uses || []).forEach((u) => rows.push({ u, n })); n.r1 = rows.length; };
    walk(root);
    const has = (n) => n.r1 > n.r0;
    const depth = (n) => (n.d ??= 1 + Math.max(0, ...n.kids.filter(has).map(depth)));
    const cells = nodes.filter(has);
    cells.forEach(depth);
    // Steps with nothing to combine (preheat, grease pan) are listed above the table.
    return { rows, cells, prep: nodes.filter((n) => !has(n)), cols: root.d };
  }

  const missingOf = (recipe, stock) => {
    const seen = new Set();
    return (recipe.steps || []).flatMap((s) => s.uses || [])
      .filter((u) => !u.optional && !isStaple(u.name) && !findStock(stock, u.name) && !seen.has(strip(u.name)) && seen.add(strip(u.name)));
  };

  function toMarkdown(recipe, f) {
    const L = [`# ${recipe.title}`, recipe.description || '', ''];
    (recipe.steps || []).forEach((s, i) => {
      const uses = (s.uses || []).map((u) => `${amount(u, f)} ${u.name}`.trim()).join(', ');
      L.push(`${i + 1}. ${s.text}${uses ? ` (${uses})` : ''}`);
    });
    if (recipe.notes) L.push('', recipe.notes);
    if (recipe.source && recipe.source.url) L.push('', `Source: ${recipe.source.url}`);
    return L.join('\n');
  }

  // opts: { stock, actions: [{ label, run(recipe), primary }] }
  function render(recipe, el, opts = {}) {
    const base = Number(recipe.servings) || 2;
    const key = 'rt:' + (recipe.id || recipe.title);
    let servings = base;
    let done;
    try { done = new Set(JSON.parse(localStorage.getItem(key)) || []); } catch { done = new Set(); }

    const draw = () => {
      const f = servings / base;
      const { rows, cells, prep, cols } = layout(recipe);
      const stock = opts.stock;
      const miss = stock ? missingOf(recipe, stock) : [];
      const srcUrl = recipe.source && /^https?:\/\/[^/]/i.test(recipe.source.url || '') ? recipe.source.url : '';
      const srcName = (recipe.source && recipe.source.name) || (srcUrl && srcUrl.split('/')[2]);
      const cls = (u) => (!stock || isStaple(u.name) || findStock(stock, u.name) ? '' : u.optional ? 'opt' : 'miss');
      const ingCells = rows.map(({ u, n }, k) =>
        `<div class="rt-ing ${cls(u)}" style="grid-row:${k + 2};grid-column:1/${n.d + 1}">` +
        `<b>${esc(amount(u, f))}</b> ${esc(u.name)}${u.optional ? ` <small>${t('optional')}</small>` : ''}${cls(u) === 'miss' ? ` <small class="buy">· ${t('to buy')}</small>` : ''}</div>`).join('');
      const stepCells = cells.map((n) =>
        `<button type="button" class="rt-step${done.has(n.i) ? ' done' : ''}" data-i="${n.i}" aria-pressed="${done.has(n.i)}" ` +
        `style="grid-row:${n.r0 + 2}/${n.r1 + 2};grid-column:${n.d + 1}/${n.parent && n.parent.d ? n.parent.d + 1 : n.d + 2}">${esc(n.s.text)}</button>`).join('');

      el.innerHTML = `
        <div class="rt-head">
          ${recipe.emoji ? `<span class="rt-emoji" aria-hidden="true">${esc(recipe.emoji)}</span>` : ''}
          <div><h2>${esc(recipe.title)}</h2>
          <p class="meta">${[recipe.time && '⏱ ' + esc(recipe.time), srcName && `${t('from')} ${srcUrl ? `<a href="${esc(srcUrl)}" rel="noopener nofollow" target="_blank">${esc(srcName)}</a>` : esc(srcName)}`].filter(Boolean).join(' · ')}</p>
          ${recipe.description ? `<p>${esc(recipe.description)}</p>` : ''}</div>
        </div>
        <div class="rt-controls">
          <span class="seg" role="group" aria-label="${t('Scale')}">${[0.5, 1, 2].map((x) => `<button type="button" data-scale="${x}" class="${servings === base * x ? 'on' : ''}">${x === 0.5 ? '½' : x}×</button>`).join('')}</span>
          <label>${t('Servings')} <input type="number" min="1" max="99" value="${servings}" data-serv></label>
          ${(opts.actions || []).map((a, i) => `<button type="button" class="btn${a.primary ? ' primary' : ''}" data-act="${i}">${esc(a.label)}</button>`).join('')}
          <button type="button" class="btn" data-copy>${t('Copy')}</button>
          <button type="button" class="btn" data-print>${t('Print')}</button>
        </div>
        ${prep.length ? `<ul class="rt-prep">${prep.map((n) => `<li>${esc(n.s.text)}</li>`).join('')}</ul>` : ''}
        <div class="rt-scroll"><div class="rt" style="--cols:${cols};grid-template-columns:minmax(10rem,1.4fr) repeat(${cols},minmax(7.5rem,1fr))">
          <div class="rt-h" style="grid-column:1">${t('ingredients, in order')}</div>
          <div class="rt-h" style="grid-column:2/${cols + 2}">${t("read left to right, tap a step when it's done →")}</div>
          ${ingCells}${stepCells}
        </div></div>
        ${miss.length ? `<p class="rt-shop"><b>${t('Shopping list:')}</b> ${miss.map((u) => esc(u.name)).join(', ')}</p>` : stock ? `<p class="rt-shop ok">${t('You have everything for this one.')}</p>` : ''}
        ${recipe.notes ? `<p class="rt-note">💡 ${esc(recipe.notes)}</p>` : ''}`;
    };

    el.classList.add('rt-wrap');
    el.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.i) {
        const i = Number(b.dataset.i);
        done.has(i) ? done.delete(i) : done.add(i);
        try { localStorage.setItem(key, JSON.stringify([...done])); } catch {}
      } else if (b.dataset.scale) servings = Math.max(1, Math.round(base * Number(b.dataset.scale) * 10) / 10);
      else if (b.hasAttribute('data-print')) return window.print();
      else if (b.hasAttribute('data-copy')) {
        await navigator.clipboard.writeText(toMarkdown(recipe, servings / base)).catch(() => {});
        b.textContent = t('Copied ✓'); return;
      } else if (b.dataset.act) return opts.actions[Number(b.dataset.act)].run(recipe, b);
      draw();
    };
    el.onchange = (e) => { if (e.target.dataset.serv !== undefined) { servings = Math.max(1, Number(e.target.value) || base); draw(); } };
    draw();
    return { redraw: (stock) => { opts.stock = stock; draw(); } };
  }

  // AI translation into the visitor's language (members, metered). Hidden when the recipe is already in it.
  const recipeLang = (r) => r.lang || window.I18N.site;
  const translateAction = (r, done) => (recipeLang(r) === window.I18N.lang ? null : {
    label: `${t('Translate')} → ${window.I18N.name}`,
    run: async (rec, b) => {
      b.disabled = true; b.textContent = t('Translating…');
      const res = await fetch('/api/translate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recipe: rec, lang: window.I18N.lang }) });
      const d = await res.json().catch(() => ({}));
      if (res.ok) return done(d);
      b.disabled = false; b.textContent = t(d.error || 'Request failed');
    },
  });

  window.RecipeTable = { render, layout, matches, findStock, strip, esc, isStaple, translateAction };

  // Posts: an HTML card holding <script type="application/recipe+json">{...}</script> becomes a table.
  const blocks = document.querySelectorAll('script[type="application/recipe+json"]');
  if (!blocks.length) return;
  const member = document.body.hasAttribute('data-member');
  const stockP = member ? fetch('/api/stock').then((r) => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null);
  blocks.forEach((s) => {
    let recipe;
    try { recipe = JSON.parse(s.textContent); } catch { return console.warn('Bad recipe JSON', s); }
    const el = document.createElement('section');
    s.after(el);
    if (!recipe.id) recipe.id = 'post-' + location.pathname.replace(/\W+/g, '');
    let table;
    const show = (r) => {
      const actions = member ? [{ label: t('Save to my box'), primary: true, run: async (rec, b) => {
        const res = await fetch('/api/recipes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) });
        b.textContent = res.ok ? t('Saved ✓') : t('Could not save');
      } }, translateAction(r, show)] : [{ label: t('Save'), run: () => { window.location.hash = '#/portal/signup'; } }];
      table = render(r, el, { actions: actions.filter(Boolean) });
      stockP.then((stock) => stock && table.redraw(stock));
    };
    show(recipe);
  });
})();
