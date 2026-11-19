import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

/* ---------- helpers ---------- */
const uid = () => 'x' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const strip = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const STAPLES = ['salt', 'pepper', 'oil', 'olive oil', 'water', 'sel', 'poivre', 'huile', 'eau'];
const STOP = new Set(['and', 'the', 'fresh', 'with', 'large', 'small', 'ripe', 'pack', 'whole']);
const words = (s) =>
  strip(s).split(/[^a-z]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.replace(/s$/, ''));
const isStaple = (name) => STAPLES.includes(strip(name).trim());
const matches = (a, b) => {
  const wa = words(a), wb = words(b);
  return wa.some((w) => wb.includes(w));
};
const findStock = (stock, name) => stock.find((s) => s.qty > 0 && matches(name, s.name));

const fmtAmount = (n) => {
  if (!n && n !== 0) return '';
  const v = n < 10 ? Math.round(n * 10) / 10 : Math.round(n);
  return String(v).replace(/\.0$/, '');
};

function recipeNeeds(recipe) {
  const seen = new Map();
  for (const step of recipe.steps) {
    for (const u of step.uses || []) {
      const k = strip(u.name);
      if (!seen.has(k)) seen.set(k, u);
    }
  }
  return [...seen.values()];
}

function availability(recipe, stock) {
  const needs = recipeNeeds(recipe).filter((u) => !u.optional && !isStaple(u.name));
  const have = needs.filter((u) => findStock(stock, u.name));
  const missing = needs.filter((u) => !findStock(stock, u.name));
  return { total: needs.length, have: have.length, missing };
}

async function fileToDataUrl(file, max = 1280) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Could not read that image.'));
      i.src = url;
    });
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s);
    c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------- app ---------- */
function App() {
  const [tab, setTab] = useState('recipes');
  const [recipes, setRecipes] = useState([]);
  const [stock, setStock] = useState([]);
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(null);
  const [toast, setToast] = useState('');
  const loaded = useRef(false);

  const say = (m) => { setToast(m); setTimeout(() => setToast(''), 3200); };

  useEffect(() => {
    Promise.all([api('/api/recipes'), api('/api/stock'), api('/api/info')])
      .then(([r, s, i]) => { setRecipes(r); setStock(s); setInfo(i); loaded.current = true; })
      .catch((e) => say(e.message));
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    const t = setTimeout(() => api('/api/stock', { method: 'PUT', body: stock }).catch((e) => say(e.message)), 300);
    return () => clearTimeout(t);
  }, [stock]);

  const url = info && info.ips[0] ? `http://${info.ips[0]}:${info.port}` : null;

  const saveRecipe = async (recipe) => {
    const saved = await api('/api/recipes', { method: 'POST', body: recipe });
    setRecipes((r) => [...r, saved]);
    say('Recipe saved ✓');
    return saved;
  };
  const deleteRecipe = async (id) => {
    await api('/api/recipes/' + encodeURIComponent(id), { method: 'DELETE' });
    setRecipes((r) => r.filter((x) => x.id !== id));
    setOpen(null);
  };

  const tabs = [
    ['recipes', '📖', 'Recipes'],
    ['stock', '🧺', 'Stock'],
    ['generate', '✨', 'Generate'],
    ['phone', '📱', 'Phone'],
  ];

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="logo">🍳</span><div><h1>Recepees</h1><p>cook from what you have</p></div></div>
        {url && <button className="chip" onClick={() => setTab('phone')} title="Open on your phone">📱 {url.replace('http://', '')}</button>}
      </header>
      <nav className="tabs">
        {tabs.map(([k, ic, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            <span>{ic}</span>{label}
            {k === 'stock' && <em>{stock.filter((s) => s.qty > 0).length}</em>}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'recipes' && <Recipes recipes={recipes} stock={stock} onOpen={setOpen} />}
        {tab === 'stock' && <Stock stock={stock} setStock={setStock} info={info} say={say} />}
        {tab === 'generate' && <Generate stock={stock} info={info} onSave={saveRecipe} onOpen={setOpen} say={say} />}
        {tab === 'phone' && <Phone info={info} />}
      </main>
      {open && (
        <RecipeView
          recipe={open} stock={stock} setStock={setStock}
          saved={recipes.some((r) => r.id === open.id)}
          onClose={() => setOpen(null)} onSave={saveRecipe} onDelete={deleteRecipe} say={say}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/* ---------- recipes ---------- */
function Recipes({ recipes, stock, onOpen }) {
  const [onlyCookable, setOnlyCookable] = useState(false);
  const [q, setQ] = useState('');
  const list = useMemo(() => recipes
    .map((r) => ({ r, a: availability(r, stock) }))
    .filter(({ r, a }) => (!onlyCookable || a.missing.length === 0) &&
      (!q || strip(r.title + ' ' + (r.tags || []).join(' ')).includes(strip(q))))
    .sort((x, y) => (x.a.missing.length - y.a.missing.length)), [recipes, stock, onlyCookable, q]);

  return (
    <section>
      <div className="toolbar">
        <input className="search" placeholder="Search recipes or tags…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="toggle"><input type="checkbox" checked={onlyCookable} onChange={(e) => setOnlyCookable(e.target.checked)} /> Cookable now</label>
      </div>
      <div className="grid">
        {list.map(({ r, a }) => (
          <button key={r.id} className="card recipe" onClick={() => onOpen(r)}>
            <div className="emoji">{r.emoji || '🍽️'}</div>
            <h3>{r.title}</h3>
            <p>{r.description}</p>
            <div className="meta"><span>⏱ {r.time}</span><span>👥 {r.servings}</span></div>
            <div className={'badge ' + (a.missing.length === 0 ? 'ok' : 'warn')}>
              {a.missing.length === 0 ? 'You have everything' : `Missing: ${a.missing.map((m) => m.name).slice(0, 3).join(', ')}${a.missing.length > 3 ? '…' : ''}`}
            </div>
            <div className="bar"><i style={{ width: `${a.total ? (a.have / a.total) * 100 : 100}%` }} /></div>
            <div className="tags">{(r.tags || []).map((t) => <span key={t}>{t}</span>)}</div>
          </button>
        ))}
        {!list.length && <p className="empty">No recipes match. Try the Generate tab ✨</p>}
      </div>
    </section>
  );
}

function RecipeView({ recipe, stock, setStock, saved, onClose, onSave, onDelete, say }) {
  const key = 'checked:' + recipe.id;
  const [servings, setServings] = useState(recipe.servings || 2);
  const [checked, setChecked] = useState(() => { try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; } });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(checked)); } catch {} }, [checked]);
  const factor = servings / (recipe.servings || 2);
  const av = availability(recipe, stock);
  const toggle = (i) => setChecked((c) => (c.includes(i) ? c.filter((x) => x !== i) : [...c, i]));

  const useUp = () => {
    if (!window.confirm('Remove one unit of each matching ingredient from your stock?')) return;
    const used = recipeNeeds(recipe).filter((u) => !isStaple(u.name));
    setStock((s) => s.map((it) => (used.some((u) => matches(u.name, it.name)) ? { ...it, qty: Math.max(0, it.qty - 1) } : it)).filter((it) => it.qty > 0));
    say('Stock updated 🧺');
  };

  return (
    <div className="overlay" onClick={onClose}>
      <article className="sheet" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Close">✕</button>
        <div className="hero">
          <span className="emoji big">{recipe.emoji || '🍽️'}</span>
          <h2>{recipe.title}</h2>
          <p>{recipe.description}</p>
          <div className="meta"><span>⏱ {recipe.time}</span>
            <span className="stepper">
              <button onClick={() => setServings((s) => Math.max(1, s - 1))}>−</button>
              👥 {servings}
              <button onClick={() => setServings((s) => s + 1)}>+</button>
            </span>
          </div>
          <div className={'badge ' + (av.missing.length === 0 ? 'ok' : 'warn')}>
            {av.missing.length === 0 ? '✓ You have everything' : `Missing: ${av.missing.map((m) => m.name).join(', ')}`}
          </div>
        </div>

        <table className="rt">
          <thead><tr><th>Ingredients</th><th>Method <small>(tap a step to tick it off)</small></th></tr></thead>
          <tbody>
            {recipe.steps.map((s, i) => (
              <tr key={i} className={checked.includes(i) ? 'done' : ''} onClick={() => toggle(i)}>
                <td className="ing">
                  {(s.uses || []).length === 0 && <span className="none">—</span>}
                  {(s.uses || []).map((u) => {
                    const have = isStaple(u.name) || findStock(stock, u.name);
                    return (
                      <div key={u.name} className={'row ' + (have ? 'have' : u.optional ? 'opt' : 'miss')}>
                        <b>{u.amount ? fmtAmount(u.amount * factor) : ''} {u.unit}</b> {u.name}
                        {u.optional && <small> optional</small>}
                      </div>
                    );
                  })}
                </td>
                <td className="how"><span className="n">{checked.includes(i) ? '✓' : i + 1}</span>{s.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {recipe.notes && <p className="note">💡 {recipe.notes}</p>}

        <div className="actions">
          <button className="btn" onClick={useUp}>I cooked it — use up stock</button>
          {!saved && <button className="btn primary" onClick={() => onSave(recipe).then(onClose)}>Save recipe</button>}
          {saved && <button className="btn danger" onClick={() => window.confirm('Delete this recipe?') && onDelete(recipe.id)}>Delete</button>}
        </div>
      </article>
    </div>
  );
}

/* ---------- stock ---------- */
function Stock({ stock, setStock, info, say }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState(null);
  const camera = useRef(null);
  const gallery = useRef(null);

  const add = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    mergeIn([{ name: name.trim(), quantity: 1, unit: 'pcs' }]);
    setName('');
  };
  const mergeIn = (items) =>
    setStock((s) => {
      const next = [...s];
      for (const it of items) {
        const ex = next.find((x) => strip(x.name) === strip(it.name) && x.unit === (it.unit || 'pcs'));
        if (ex) ex.qty += Number(it.quantity) || 1;
        else next.push({ id: uid(), name: it.name, qty: Number(it.quantity) || 1, unit: it.unit || 'pcs', note: it.note || '' });
      }
      return next.map((x) => ({ ...x }));
    });
  const bump = (id, d) => setStock((s) => s.map((x) => (x.id === id ? { ...x, qty: Math.max(0, x.qty + d) } : x)).filter((x) => x.qty > 0));
  const remove = (id) => setStock((s) => s.filter((x) => x.id !== id));

  const scan = async (files) => {
    if (!files || !files.length) return;
    setBusy(true);
    try {
      const all = [];
      for (const f of files) {
        const image = await fileToDataUrl(f);
        const { items } = await api('/api/recognize', { method: 'POST', body: { image } });
        all.push(...items);
      }
      if (!all.length) say('No ingredients recognised. Try a closer photo.');
      else setFound(all.map((it) => ({ ...it, pick: true })));
    } catch (e) { say(e.message); }
    finally { setBusy(false); if (camera.current) camera.current.value = ''; if (gallery.current) gallery.current.value = ''; }
  };

  return (
    <section>
      <div className="scan card">
        <div>
          <h3>Add by photo</h3>
          <p>Snap your haul or fridge; Claude recognises the ingredients.{info && !info.hasKey && ' (Add ANTHROPIC_API_KEY to enable.)'}</p>
        </div>
        <div className="row-btns">
          <button className="btn primary" disabled={busy} onClick={() => camera.current.click()}>{busy ? 'Recognising…' : '📷 Take photo'}</button>
          <button className="btn" disabled={busy} onClick={() => gallery.current.click()}>🖼 Choose photos</button>
        </div>
        <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => scan(e.target.files)} />
        <input ref={gallery} type="file" accept="image/*" multiple hidden onChange={(e) => scan(e.target.files)} />
      </div>

      {found && (
        <div className="card found">
          <h3>Recognised — untick anything wrong</h3>
          {found.map((it, i) => (
            <label key={i} className="line">
              <input type="checkbox" checked={it.pick} onChange={() => setFound((f) => f.map((x, j) => (j === i ? { ...x, pick: !x.pick } : x)))} />
              <span>{it.name}</span><small>{it.quantity} {it.unit} {it.note && `· ${it.note}`}</small>
            </label>
          ))}
          <div className="actions">
            <button className="btn primary" onClick={() => { mergeIn(found.filter((x) => x.pick)); setFound(null); say('Added to stock 🧺'); }}>Add to stock</button>
            <button className="btn" onClick={() => setFound(null)}>Discard</button>
          </div>
        </div>
      )}

      <form className="add" onSubmit={add}>
        <input placeholder="Add an ingredient by hand…" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary">Add</button>
      </form>

      <ul className="stock">
        {stock.map((s) => (
          <li key={s.id}>
            <div><b>{s.name}</b>{s.note && <small>{s.note}</small>}</div>
            <div className="qty">
              <button onClick={() => bump(s.id, -1)}>−</button>
              <span>{s.qty} <small>{s.unit}</small></span>
              <button onClick={() => bump(s.id, 1)}>+</button>
              <button className="x" onClick={() => remove(s.id)} aria-label={'Remove ' + s.name}>🗑</button>
            </div>
          </li>
        ))}
        {!stock.length && <p className="empty">Your stock is empty. Add something above.</p>}
      </ul>
    </section>
  );
}

/* ---------- generate ---------- */
function Generate({ stock, info, onSave, onOpen, say }) {
  const [picked, setPicked] = useState(() => new Set(stock.map((s) => s.id)));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPicked((p) => (p.size ? p : new Set(stock.map((s) => s.id)))); }, [stock.length]);

  const toggle = (id) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const go = async () => {
    const ingredients = stock.filter((s) => picked.has(s.id)).map((s) => s.name);
    setBusy(true);
    try {
      const recipe = await api('/api/generate', { method: 'POST', body: { ingredients, notes } });
      onOpen(recipe);
    } catch (e) { say(e.message); }
    finally { setBusy(false); }
  };

  return (
    <section>
      <div className="card">
        <h3>✨ Generate a recipe from your stock</h3>
        <p>Pick what to use, add any wishes, and Claude writes a recipe you can save.</p>
        <div className="pills">
          {stock.map((s) => (
            <button key={s.id} className={'pill ' + (picked.has(s.id) ? 'on' : '')} onClick={() => toggle(s.id)}>{s.name}</button>
          ))}
        </div>
        <textarea rows="2" placeholder="Optional: vegetarian, under 20 minutes, Italian, kid-friendly…" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="actions">
          <button className="btn primary" disabled={busy || !picked.size} onClick={go}>{busy ? 'Cooking up an idea…' : 'Generate recipe'}</button>
          {info && !info.hasKey && <small className="warn-text">AI is off: add ANTHROPIC_API_KEY to .env and restart.</small>}
        </div>
      </div>
    </section>
  );
}

/* ---------- phone ---------- */
function Phone({ info }) {
  if (!info) return <p className="empty">Loading…</p>;
  const urls = info.ips.map((ip) => `http://${ip}:${info.port}`);
  return (
    <section>
      <div className="card phone">
        <h3>📱 Open this on your phone</h3>
        <p>Connect your phone to the same Wi-Fi as this computer, then type this address into your phone's browser:</p>
        {urls.length ? urls.map((u) => <div key={u} className="bigurl">{u}</div>) : <p className="empty">No network address found. Are you connected to Wi-Fi?</p>}
        <ol>
          <li>Open the address on your phone.</li>
          <li>In the <b>Stock</b> tab, tap <b>Take photo</b>: your camera opens.</li>
          <li>Confirm the ingredients it finds and add them to your stock.</li>
          <li>Open <b>Generate</b> to make a recipe from what you have.</li>
        </ol>
        <p className="small">AI features: <b>{info.hasKey ? `on (${info.model})` : 'off'}</b>. Anyone on your Wi-Fi can open this page and use your API key, so only run it on a network you trust.</p>
      </div>
    </section>
  );
}

createRoot(document.getElementById('root')).render(<App />);
