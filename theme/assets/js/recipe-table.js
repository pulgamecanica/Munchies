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
  // Same ingredient? Compare lowercase, accents/spaces/symbols removed ("Olive Oil" = "olive-oil").
  const norm = (s) => strip(s).replace(/[^a-z0-9]/g, '');
  // Enough of it? Only when both amounts are in comparable units (weight, volume or pieces); otherwise assume yes.
  const UNITS = { mg: ['w', 0.001], g: ['w', 1], gr: ['w', 1], gram: ['w', 1], kg: ['w', 1000], ml: ['v', 1], cl: ['v', 10], dl: ['v', 100], l: ['v', 1000],
    tsp: ['v', 5], tbsp: ['v', 15], cup: ['v', 240], pc: ['n', 1], pcs: ['n', 1], piece: ['n', 1], '': ['n', 1] };
  const inBase = (q, unit) => { const u = UNITS[strip(unit || '').replace(/s$/, '')] || UNITS[strip(unit || '')]; return u ? [u[0], Number(q) * u[1]] : null; };
  const shortOf = (item, need, unit) => {
    if (!item || !need) return 0;
    const a = inBase(item.qty, item.unit), b = inBase(need, unit);
    return a && b && a[0] === b[0] && a[1] < b[1] - 1e-9 ? 1 : 0;
  };
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

  const missingOf = (recipe, stock, f = 1) => {
    const seen = new Set();
    return (recipe.steps || []).flatMap((s) => s.uses || [])
      .filter((u) => !u.optional && !isStaple(u.name) && (!findStock(stock, u.name) || shortOf(findStock(stock, u.name), (u.amount || 0) * f, u.unit)) && !seen.has(norm(u.name)) && seen.add(norm(u.name)));
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
    let newCol = false; // inline "new collection" form in place of the picker
    let editRow = -1; // ingredient row whose amount is being typed in
    let done;
    // Where this recipe lives (for the "Cooking now" window) and how many steps can be ticked.
    const meta = () => ({ emoji: recipe.emoji, url: opts.url || location.pathname + location.search, total: layout(recipe).cells.length });
    el.dataset.rk = recipe.id || recipe.title;
    const readDone = () => { try { const v = JSON.parse(localStorage.getItem(key)); return new Set(Array.isArray(v) ? v : (v && v.d) || []); } catch { return new Set(); } };
    const saveDone = () => { try { if (done.size) localStorage.setItem(key, JSON.stringify({ t: recipe.title, d: [...done] })); else localStorage.removeItem(key); } catch {} document.dispatchEvent(new Event('rt-progress')); };
    done = readDone();
    // Another recipe was started and this one got reset (or vice versa): reload the ticks.
    document.addEventListener('rt-reset', (e) => { if ('rt:' + e.detail === key && el.isConnected) { done = readDone(); draw(); } });

    let draw = () => {
      const f = servings / base;
      const { rows, cells, prep, cols } = layout(recipe);
      const stock = opts.stock;
      const miss = stock ? missingOf(recipe, stock, servings / base) : [];
      const srcUrl = recipe.source && /^https?:\/\/[^/]/i.test(recipe.source.url || '') ? recipe.source.url : '';
      const srcName = (recipe.source && recipe.source.name) || (srcUrl && srcUrl.split('/')[2]);
      const cls = (u) => {
        if (!stock || isStaple(u.name)) return '';
        const it = findStock(stock, u.name);
        if (!it) return u.optional ? 'opt' : 'miss';
        return shortOf(it, (u.amount || 0) * f, u.unit) ? 'low' : '';
      };
      const PEN = '<svg class="pen" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/></svg>';
      const ingCells = rows.map(({ u, n }, k) => {
        const c = cls(u), it = c === 'low' && findStock(stock, u.name);
        return `<div class="rt-ing ${c}${k === rows.length - 1 ? ' edge-b' : ''}" data-row="${k}" style="grid-row:${k + 2};grid-column:1/${n.d + 1}">` +
          (editRow === k
            ? `<input class="rt-amt-in" type="number" min="0" step="any" value="${esc(fmt((u.amount || 0) * f))}" data-amt-in="${k}" aria-label="${esc(t('Edit amount'))}: ${esc(u.name)}"> <small>${esc(u.unit || '')}</small>`
            : `<button type="button" class="rt-amt" data-amt="${k}" title="${esc(t('Edit amount'))}"><b class="amt-txt">${esc(amount(u, f) || '–')}</b>${PEN}</button>`) +
          ` ${esc(u.name)}${u.optional ? ` <small>${t('optional')}</small>` : ''}` +
          // A small dot instead of text; the notice is in its tooltip (hover, focus, or tap on phones).
          (c === 'miss' || c === 'low' ? ` <button type="button" class="rt-dot ${c}" data-tip="${esc(c === 'miss' ? t('Not in your stock: to buy') : t('not enough (you have {n})', { n: `${fmt(it.qty)} ${it.unit || ''}`.trim() }))}" aria-label="${esc(c === 'miss' ? t('Not in your stock: to buy') : t('not enough (you have {n})', { n: `${fmt(it.qty)} ${it.unit || ''}`.trim() }))}"></button>` : '') + '</div>';
      }).join('');
      const timedSteps = new Set(window.RecipeTimers && opts.timers !== false ? window.RecipeTimers.timed(recipe).map((x) => x.i) : []);
      const hasTimers = timedSteps.size > 0;
      let timersOpen = false; try { timersOpen = localStorage.getItem('rt-timers-open') === '1'; } catch {}
      // Convergence as colour: steps deepen toward the final column; the last step is the dish.
      const depth = (n) => Math.round(12 + 76 * (n.d - 1) / Math.max(1, cols - 1));
      const stepCells = cells.map((n) =>
        `<button type="button" class="rt-step${!n.parent ? ' dish' : depth(n) >= 50 ? ' deep' : ''}${n.r1 === rows.length ? ' edge-b' : ''}${!n.parent ? ' edge-r' : ''}${done.has(n.i) ? ' done' : ''}" data-i="${n.i}" aria-pressed="${done.has(n.i)}"${timedSteps.has(n.i) ? ` data-tm-step="${esc(window.RecipeTimers.keyFor(recipe, n.i))}"` : ''} ` +
        `style="--p:${depth(n)};` +
        `grid-row:${n.r0 + 2}/${n.r1 + 2};grid-column:${n.d + 1}/${n.parent && n.parent.d ? n.parent.d + 1 : n.d + 2}">${esc(n.s.text)}</button>`).join('');

      el.innerHTML = `${opts.head === false ? '' : `
        <div class="rt-head">
          ${recipe.emoji ? `<span class="rt-emoji" aria-hidden="true">${esc(recipe.emoji)}</span>` : ''}
          <div><h2>${esc(recipe.title)}</h2>
          <p class="meta">${[recipe.time && '⏱ ' + esc(recipe.time), srcName && `${t('from')} ${srcUrl ? `<a href="${esc(srcUrl)}" rel="noopener nofollow" target="_blank">${esc(srcName)}</a>` : esc(srcName)}`].filter(Boolean).join(' · ')}</p>
          ${recipe.description ? `<p>${esc(recipe.description)}</p>` : ''}</div>
        </div>`}
        <div class="rt-tray">
        <div class="rt-controls">
          <span class="seg" role="group" aria-label="${t('Scale')}">${[0.5, 1, 2].map((x) => `<button type="button" data-scale="${x}" class="${servings === base * x ? 'on' : ''}">${x === 0.5 ? '½' : x}×</button>`).join('')}</span>
          <label>${t('Servings')} <input type="number" min="1" max="99" value="${servings}" data-serv></label>
          ${opts.collections && newCol ? `<form class="rt-newcol" data-newcol-form>
            <input name="name" maxlength="60" required placeholder="${esc(t('Collection name'))}" aria-label="${esc(t('Collection name'))}">
            <button class="btn primary">${esc(t('Create'))}</button><button type="button" class="btn" data-newcol-cancel>${esc(t('Cancel'))}</button></form>` : ''}
          ${opts.collections && !newCol ? `<select class="rt-col" data-col aria-label="${esc(t('Add to collection…'))}">
            <option value="">${esc(t('Add to collection…'))}</option>
            ${opts.collections.list.filter((c) => !c.special).map((c) => `<option value="${esc(c.id)}">${(recipe.collections || []).includes(c.id) ? '✓ ' : ''}${esc(c.name)}</option>`).join('')}
            <option value="+">${esc(t('New collection…'))}</option></select>` : ''}
          ${(opts.actions || []).map((a, i) => `<button type="button" class="btn${a.primary ? ' primary' : ''}" data-act="${i}">${esc(a.label)}</button>`).join('')}
          <button type="button" class="btn" data-copy>${t('Copy')}</button>
          <button type="button" class="btn" data-print>${t('Print')}</button>
          ${hasTimers ? `<button type="button" class="btn icon-btn rt-clock" data-timers aria-pressed="${timersOpen}" aria-label="${esc(t('Timers'))}" title="${esc(t('Timers'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6M12 2v3"/></svg></button>` : ''}
        </div>
        ${prep.length ? `<ul class="rt-prep">${prep.map((n) => `<li>${esc(n.s.text)}</li>`).join('')}</ul>` : ''}
        <div class="rt-scroll"><div class="rt" style="--cols:${cols}">
          <div class="rt-h" style="grid-column:1">${t('ingredients, in order')}</div>
          <div class="rt-h edge-r" style="grid-column:2/${cols + 2}">${t("read left to right, tap a step when it's done →")} <a class="rt-howto" href="/how-to-read/">${esc(t('How to read this'))}</a></div>
          ${ingCells}${stepCells}
        </div></div>
        </div>
        ${hasTimers && timersOpen ? window.RecipeTimers.section(recipe, meta()) : ''}
        ${miss.length ? `<p class="rt-shop"><b>${t('Shopping list:')}</b> ${miss.map((u) => esc(u.name)).join(', ')}</p>` : stock ? `<p class="rt-shop ok">${t('You have everything for this one.')}</p>` : ''}
        ${recipe.notes ? `<p class="rt-note">💡 ${esc(recipe.notes)}</p>` : ''}`;
    };

    el.classList.add('rt-wrap');
    el.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-newcol-cancel')) { newCol = false; return draw(); }
      if (b.hasAttribute('data-timers')) { try { localStorage.setItem('rt-timers-open', b.getAttribute('aria-pressed') === 'true' ? '0' : '1'); } catch {} return draw(); }
      if (b.classList.contains('rt-dot')) return; // tooltip only
      if (b.dataset.amt) { editRow = Number(b.dataset.amt); draw(); const i = el.querySelector('[data-amt-in]'); i.focus(); i.select(); return; }
      if (b.dataset.i) {
        const i = Number(b.dataset.i);
        if (!done.has(i) && !done.size && window.RecipeTimers) {
          // First tick = starting this recipe: check nothing else is cooking.
          return window.RecipeTimers.claim(recipe.id || recipe.title, recipe.title, () => { done.add(i); saveDone(); draw(); }, meta());
        }
        done.has(i) ? done.delete(i) : done.add(i);
        saveDone();
      } else if (b.dataset.scale) servings = Math.max(1, Math.round(base * Number(b.dataset.scale) * 10) / 10);
      else if (b.hasAttribute('data-print')) return printDialog(recipe);
      else if (b.hasAttribute('data-copy')) {
        await navigator.clipboard.writeText(toMarkdown(recipe, servings / base)).catch(() => {});
        b.textContent = t('Copied ✓'); return;
      } else if (b.dataset.act) return opts.actions[Number(b.dataset.act)].run(recipe, b);
      draw();
    };
    el.onsubmit = async (e) => {
      if (!e.target.hasAttribute('data-newcol-form')) return;
      e.preventDefault();
      const name = new FormData(e.target).get('name').trim();
      if (name) await opts.collections.create(recipe, name);
      newCol = false; draw();
    };
    // Typed amounts are stored per serving base, so scaling keeps working; opts.onEdit saves the recipe where it lives.
    const commitAmount = (input) => {
      const k = Number(input.dataset.amtIn), v = Number(input.value), row = layout(recipe).rows[k];
      editRow = -1;
      if (row && Number.isFinite(v) && v >= 0) { row.u.amount = v / (servings / base); if (opts.onEdit) opts.onEdit(recipe); }
      draw();
    };
    el.onkeydown = (e) => {
      if (!e.target.dataset || e.target.dataset.amtIn === undefined) return;
      if (e.key === 'Enter') { e.preventDefault(); commitAmount(e.target); }
      if (e.key === 'Escape') { editRow = -1; draw(); }
    };
    el.addEventListener('focusout', (e) => { if (e.target.dataset && e.target.dataset.amtIn !== undefined && editRow >= 0) commitAmount(e.target); });
    el.onchange = async (e) => {
      if (e.target.dataset.serv !== undefined) { servings = Math.max(1, Number(e.target.value) || base); draw(); }
      if (e.target.dataset.col !== undefined && e.target.value === '+') { newCol = true; draw(); el.querySelector('[data-newcol-form] input').focus(); return; }
      if (e.target.dataset.col !== undefined && e.target.value) { await opts.collections.pick(recipe, e.target.value); draw(); }
    };
    const drawAll = draw;
    draw = () => {
      drawAll();
      // Redraws recreate the dots: start their breathing at the shared clock's phase so it never visibly restarts.
      el.style.setProperty('--rt-phase', `${-(performance.now() % 2800)}ms`);
      if (window.RecipeTimers) { window.RecipeTimers.paintAll(); window.RecipeTimers.pip(); }
    };
    draw();
    return { redraw: (stock) => { if (stock) opts.stock = stock; if (editRow < 0) draw(); } };
  }

  /* Print dialog: the real recipe rendered as a page in every style (each theme + black & white).
     Small live renders to choose from, a large page preview of the choice; the page itself goes back to normal after printing. */
  const PALS = ['enamel', 'pastel', 'summer', 'night'];
  const PAGE_W = { portrait: 760, landscape: 1075 }; // previews render at A4 proportions at this width, then scale down to fit
  function pageMarkup(recipe) {
    const box = document.createElement('div');
    render(recipe, box, {});
    box.querySelectorAll('.rt-controls, .rt-shop, .rt-howto, .rt-timers, .tm-badge, .tm-cover, .rt-dot').forEach((x) => x.remove()); // exactly what prints
    box.querySelectorAll('.rt-amt').forEach((b) => b.replaceWith(Object.assign(document.createElement('b'), { textContent: b.textContent })));
    // Previews sit inside clickable cards, and buttons can't nest: turn the step buttons into plain blocks.
    box.querySelectorAll('button').forEach((b) => { const d = document.createElement('div'); d.className = b.className; d.setAttribute('style', b.getAttribute('style') || ''); d.innerHTML = b.innerHTML; b.replaceWith(d); });
    return box.innerHTML;
  }
  function printDialog(recipe) {
    const root = document.documentElement, current = root.dataset.palette || 'enamel';
    const names = { enamel: 'Enamel', pastel: 'Pastel', summer: 'Summer', night: 'Night', bw: 'Black & white' };
    const styles = [current, ...PALS.filter((x) => x !== current), 'bw'];
    const page = pageMarkup(recipe);
    const pref = (k, d, ok) => { try { const v = localStorage.getItem('print-' + k); return ok.includes(v) ? v : d; } catch { return d; } };
    let chosen = current, orient = pref('orient', 'portrait', ['portrait', 'landscape']), align = pref('align', 'left', ['left', 'center', 'justify']);
    const paper = (style) => `<div class="paper ${orient}${style === 'bw' ? ' bw' : ''}" data-align="${align}" ${style === 'bw' ? '' : `data-palette="${style}"`} aria-hidden="true"><div class="paper-in rt-wrap">${page}</div></div>`;
    const ICON = {
      portrait: '<svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="1.5"/></svg>',
      landscape: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="1.5"/></svg>',
      left: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 10h10M4 14h16M4 18h10"/></svg>',
      center: '<svg viewBox="0 0 24 24"><path d="M4 6h16M7 10h10M4 14h16M7 18h10"/></svg>',
      justify: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 10h16M4 14h16M4 18h16"/></svg>',
    };
    const seg = (name, value, opts) => `<div class="pd-seg" role="radiogroup" aria-label="${esc(t(name))}">${opts.map(([v, l]) =>
      `<button type="button" role="radio" data-${name.toLowerCase()}="${v}" aria-checked="${v === value}" aria-label="${esc(t(l))}" title="${esc(t(l))}">${ICON[v]}</button>`).join('')}</div>`;
    const dlg = document.createElement('dialog');
    dlg.className = 'print-dlg';
    dlg.setAttribute('aria-label', t('Print'));
    dlg.innerHTML = `
      <div class="pd-stage">${paper(chosen)}</div>
      <aside class="pd-side">
        <div class="pd-styles" role="radiogroup" aria-label="${esc(t('Choose a print style'))}">
          ${styles.map((x) => `<button type="button" role="radio" class="pd-style" data-style="${x}" aria-checked="${x === chosen}">
            ${paper(x)}<span>${esc(t(names[x]))}${x === current ? ` <small>${esc(t('Current theme'))}</small>` : ''}</span></button>`).join('')}
        </div>
        <div class="pd-opts">
          <div class="pd-opt"><span>${esc(t('Orientation'))}</span>${seg('Orientation', orient, [['portrait', 'Portrait'], ['landscape', 'Landscape']])}</div>
          <div class="pd-opt"><span>${esc(t('Text'))}</span>${seg('Text', align, [['left', 'Left'], ['center', 'Centered'], ['justify', 'Justified']])}</div>
        </div>
        <div class="pd-actions"><button type="button" class="btn" data-cancel>${esc(t('Cancel'))}</button><button type="button" class="btn primary" data-go>${esc(t('Print'))}</button></div>
      </aside>`;
    document.body.append(dlg);
    const fit = () => dlg.querySelectorAll('.paper').forEach((p) => { p.style.setProperty('--pw', PAGE_W[orient] + 'px'); p.style.setProperty('--s', p.clientWidth / PAGE_W[orient]); });
    const redraw = () => {
      dlg.querySelectorAll('.pd-style').forEach((b) => b.querySelector('.paper').outerHTML = paper(b.dataset.style));
      dlg.querySelector('.pd-stage').innerHTML = paper(chosen);
      dlg.querySelectorAll('[data-orientation]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.orientation === orient)));
      dlg.querySelectorAll('[data-text]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.text === align)));
      fit();
    };
    const pick = (style) => {
      chosen = style;
      dlg.querySelectorAll('.pd-style').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.style === style)));
      dlg.querySelector('.pd-stage').innerHTML = paper(style); fit();
    };
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-cancel]')) return dlg.close();
      const b = e.target.closest('[data-style]'); if (b) return pick(b.dataset.style);
      const o = e.target.closest('[data-orientation]'); if (o) { orient = o.dataset.orientation; try { localStorage.setItem('print-orient', orient); } catch {} return redraw(); }
      const a = e.target.closest('[data-text]'); if (a) { align = a.dataset.text; try { localStorage.setItem('print-align', align); } catch {} return redraw(); }
      if (e.target.closest('[data-go]')) { dlg.returnValue = 'print'; dlg.close(); }
    });
    dlg.addEventListener('keydown', (e) => {
      if (!e.target.closest('.pd-styles') || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const i = styles.indexOf(chosen), j = (i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) + styles.length) % styles.length;
      pick(styles[j]); dlg.querySelector(`[data-style="${styles[j]}"]`).focus();
    });
    window.addEventListener('resize', fit);
    dlg.addEventListener('close', () => {
      window.removeEventListener('resize', fit);
      const go = dlg.returnValue === 'print';
      dlg.remove();
      if (!go) return;
      const before = root.dataset.palette;
      if (chosen === 'bw') root.dataset.print = 'bw'; else { root.dataset.print = 'color'; root.dataset.palette = chosen; }
      root.dataset.printAlign = align;
      const page = document.createElement('style'); // orientation needs an @page rule
      page.textContent = `@page { size: A4 ${orient}; margin: 12mm; }`;
      document.head.append(page);
      const restore = () => { delete root.dataset.print; delete root.dataset.printAlign; page.remove(); root.dataset.palette = before; window.removeEventListener('afterprint', restore); };
      window.addEventListener('afterprint', restore);
      setTimeout(() => window.print(), 50);
    });
    dlg.showModal();
    fit();
    dlg.querySelector('[aria-checked="true"]').focus();
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

  // Collections picker: toggling a collection saves the recipe (with its collections) to the member's kitchen.
  // `source` is the list itself or a function returning the current list, so new collections show up without a reload.
  const collectionsFor = (source, onSaved) => ({
    get list() { return typeof source === 'function' ? source() : source; },
    async create(recipe, name) {
      const r = await fetch('/api/collections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      if (!r.ok) return;
      const c = await r.json(); this.list.push(c);
      return this.pick(recipe, c.id);
    },
    async pick(recipe, id) {
      const has = new Set(recipe.collections || []);
      const name = (this.list.find((c) => c.id === id) || {}).name;
      has.has(id) ? has.delete(id) : has.add(id);
      recipe.collections = [...has];
      const r = await fetch('/api/recipes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(recipe) });
      if (r.ok) { toast(t(has.has(id) ? 'Added to {name}' : 'Removed from {name}', { name })); onSaved && onSaved(recipe); }
    },
  });
  const toast = (m) => { const d = document.createElement('div'); d.className = 'toast'; d.setAttribute('role', 'status'); d.textContent = m; document.body.append(d); setTimeout(() => d.remove(), 3000); };

  /* Tooltips for [data-tip]: hover or keyboard focus on desktop, tap on touch screens. */
  const tip = document.createElement('div');
  tip.className = 'rt-tip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
  document.addEventListener('DOMContentLoaded', () => document.body.append(tip));
  let tipFor = null;
  const showTip = (el) => {
    if (!tip.isConnected) document.body.append(tip);
    tipFor = el; tip.textContent = el.dataset.tip; tip.hidden = false;
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    const x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    const above = r.top - h - 10 > 8;
    tip.style.left = x + 'px'; tip.style.top = (above ? r.top - h - 10 : r.bottom + 10) + 'px';
    tip.dataset.side = above ? 'top' : 'bottom';
  };
  const hideTip = () => { tip.hidden = true; tipFor = null; };
  document.addEventListener('pointerover', (e) => { const el = e.target.closest('[data-tip]'); if (el && e.pointerType === 'mouse') showTip(el); });
  document.addEventListener('pointerout', (e) => { if (e.pointerType === 'mouse' && tipFor && !tipFor.contains(e.relatedTarget)) hideTip(); });
  document.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip]'); if (el) showTip(el); });
  document.addEventListener('focusout', (e) => { if (e.target === tipFor) hideTip(); });
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el && e.pointerType === 'mouse') return; // mice already got it on hover
    if (el) { if (tipFor === el && !tip.hidden) hideTip(); else showTip(el); } else hideTip();
  });
  addEventListener('scroll', hideTip, true);

  window.RecipeTable = { render, layout, matches, findStock, strip, esc, isStaple, translateAction, collectionsFor, toast, norm };

  // Posts: an HTML card holding <script type="application/recipe+json">{...}</script> becomes a table.
  const blocks = document.querySelectorAll('script[type="application/recipe+json"]');
  if (!blocks.length) return;
  const member = document.body.hasAttribute('data-member');
  const get = (u) => (member ? fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null));
  const stockP = get('/api/stock');
  const colsP = Promise.all([get('/api/collections?lang=' + window.I18N.lang), get('/api/recipes')]);
  blocks.forEach((s) => {
    let recipe;
    try { recipe = JSON.parse(s.textContent); } catch { return console.warn('Bad recipe JSON', s); }
    const el = document.createElement('section');
    s.after(el);
    if (!recipe.id) recipe.id = 'post-' + location.pathname.replace(/\W+/g, '');
    let table;
    let cols = null;
    const show = (r) => {
      const actions = member ? [translateAction(r, show)] : [{ label: t('Save'), primary: true, run: () => { window.location.hash = '#/portal/signup'; } }];
      table = render(r, el, { actions: actions.filter(Boolean), head: false, collections: cols });
      stockP.then((stock) => stock && table.redraw(stock));
    };
    show(recipe);
    colsP.then(([list, saved]) => {
      if (!list) return;
      const mine = (saved || []).find((x) => x.id === recipe.id);
      if (mine) recipe.collections = mine.collections || [];
      cols = collectionsFor(list);
      show(recipe);
    });
    const spec = document.getElementById('spec');
    if (spec && recipe.time && !spec.querySelector('[data-time]')) spec.insertAdjacentHTML('afterbegin', `<div data-time><dt>${esc(t('Time'))}</dt><dd>${esc(recipe.time)}</dd></div>`);
  });
})();
