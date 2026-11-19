/* Trash (/my/trash/): deleted collections and recipes. Restore puts them back (collections with their recipes); delete forever is final. */
(() => {
  const { esc, toast } = window.RecipeTable;
  const t = window.t, root = document.getElementById('trash');
  let items = [];
  const api = async (path, method = 'GET') => {
    const r = await fetch(path, { method });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(t(d.error || 'Request failed'));
    return d;
  };
  const when = (ms) => new Intl.DateTimeFormat(window.I18N.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
  const kitchen = document.querySelector('[data-nav="/my/"]');

  function draw() {
    root.innerHTML = `
      <a class="back" href="/my/">← ${esc(kitchen ? kitchen.textContent.trim() : t('My kitchen'))}</a>
      <div class="sec-head trash-head">
        <h1>${esc(t('Trash'))} <small>${items.length}</small></h1>
        ${items.length ? `<button type="button" class="btn danger" data-empty>${esc(t('Empty trash'))}</button>` : ''}
      </div>
      <p class="note">${esc(t('Deleted collections and recipes wait here until you restore them or delete them forever.'))}</p>
      ${items.length ? `<ul class="trash-list">${items.map((x) => `
        <li class="trash-item">
          <span class="scard-emoji" aria-hidden="true">${x.type === 'recipe' ? esc(x.item.emoji || '🍽️') : '🗂️'}</span>
          <span class="trash-what"><b>${esc(x.type === 'recipe' ? x.item.title : x.item.name)}</b>
            <small>${esc(t(x.type === 'recipe' ? 'Recipe' : 'Collection'))}${x.type === 'collection' ? ` · ${esc((x.recipes || []).length === 1 ? t('1 recipe') : t('{n} recipes', { n: (x.recipes || []).length }))}` : ''} · ${esc(t('Deleted {date}', { date: when(x.deleted) }))}</small></span>
          <span class="row"><button type="button" class="btn primary" data-restore="${esc(x.id)}">${esc(t('Restore'))}</button>
          <button type="button" class="btn danger" data-forever="${esc(x.id)}">${esc(t('Delete forever'))}</button></span>
        </li>`).join('')}</ul>` : `<div class="trash-empty"><span class="trash-ico big" aria-hidden="true"></span><p>${esc(t('Trash is empty.'))}</p></div>`}`;
  }
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.restore) { await api(`/api/trash/${b.dataset.restore}/restore`, 'POST'); toast(t('Restored')); }
      else if (b.dataset.forever) { if (!confirm(t("Delete forever? This can't be undone."))) return; await api('/api/trash/' + b.dataset.forever, 'DELETE'); }
      else if ('empty' in b.dataset) { if (!confirm(t("Empty the trash? This can't be undone."))) return; await api('/api/trash', 'DELETE'); }
      items = await api('/api/trash'); draw();
    } catch (x) { toast(x.message); }
  });
  api('/api/trash').then((d) => { items = d; draw(); }).catch((x) => { root.innerHTML = `<p class="empty">${esc(x.message)}</p>`; });
})();
