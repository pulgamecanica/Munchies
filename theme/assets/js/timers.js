/* Recipe timers. Durations are read from step text ("Bake 60 min", "Cook 2–3 min", "1 h 20 min", in 6 languages).
   State lives in localStorage with absolute end times, so timers survive reloads and sleeping tabs.
   When one runs out, a full-screen alert rings and vibrates until it's acknowledged.
   Looks (prefs): countdown, clock, grid or a tree losing its leaves; optionally shown inside the step cell,
   optionally "blacking out" the step under a cover that melts away as the time runs down. */
(() => {
  const t = window.t || ((k) => k);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const T = load('rt-timers', {}); // key -> { title, step, label, dur, end, left, state: idle | run | pause | ring }
  const P = Object.assign({ style: 'countdown', embed: true, blackout: false, sound: true, vibrate: true }, load('rt-timer-prefs', {}));
  const STYLES = [['countdown', 'Countdown'], ['clock', 'Clock'], ['grid', 'Grid'], ['tree', 'Tree']];
  const save = () => store('rt-timers', T);

  /* ---------- durations ---------- */
  const UNITS = [
    [/^(h|hr|hrs|hour|hours|hora|horas|heure|heures|ora|ore|std|stunde|stunden)$/, 3600],
    [/^(m|min|mins|minute|minutes|minuto|minutos|minuti|minuten)$/, 60],
    [/^(s|sec|secs|second|seconds|seg|segundo|segundos|secondi|sekunde|sekunden)$/, 1],
  ];
  const RE = /(\d+(?:[.,]\d+)?)(?:\s*(?:–|—|-|to|a|à|bis)\s*\d+(?:[.,]\d+)?)?\s*([a-zA-Zà-ü]+)\.?/g;
  function parse(text) {
    let secs = 0, label = '', end = -1;
    for (const m of String(text || '').matchAll(RE)) {
      const u = UNITS.find(([r]) => r.test(m[2].toLowerCase()));
      if (!u) continue;
      if (end >= 0 && m.index - end > 6) break; // "1 h 20 min" adds up; a later, separate duration doesn't
      secs += Math.round(parseFloat(m[1].replace(',', '.')) * u[1]); // ranges use the lower bound: check early
      label = label ? `${label} ${m[0].trim()}` : m[0].trim();
      end = m.index + m[0].length;
    }
    return secs ? { secs, label } : null;
  }

  /* ---------- clock ---------- */
  const left = (s) => (s.state === 'run' ? Math.max(0, (s.end - Date.now()) / 1000) : s.state === 'pause' ? s.left : s.state === 'ring' ? 0 : s.dur);
  const fmt = (sec) => {
    sec = Math.ceil(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : m) + ':' + String(s).padStart(2, '0');
  };
  let loop = null;
  const tick = () => {
    let ringing = false, running = false;
    for (const s of Object.values(T)) {
      if (s.state === 'run' && s.end <= Date.now()) { s.state = 'ring'; ringing = true; save(); }
      if (s.state === 'run') running = true;
      if (s.state === 'ring') ringing = true;
    }
    paintAll();
    if (ringing) alarm(); else silence();
    if (!running && loop) { clearInterval(loop); loop = null; }
  };
  const ensureLoop = () => { if (!loop) loop = setInterval(tick, 250); };

  /* ---------- sound + vibration ---------- */
  let ac, ringLoop = null;
  const baseTitle = document.title;
  const audio = () => { try { ac ||= new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); } catch {} return ac; };
  function beep() {
    const a = audio(); if (!a) return;
    const t0 = a.currentTime;
    [0, 0.22, 0.44].forEach((d, k) => {
      const o = a.createOscillator(), g = a.createGain();
      o.type = 'triangle'; o.frequency.value = k === 2 ? 1175 : 880;
      g.gain.setValueAtTime(0.0001, t0 + d); g.gain.exponentialRampToValueAtTime(0.5, t0 + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.18);
      o.connect(g).connect(a.destination); o.start(t0 + d); o.stop(t0 + d + 0.2);
    });
  }
  function alarm() {
    showAlert();
    if (ringLoop) return;
    const ring = () => {
      if (P.sound) beep();
      if (P.vibrate && navigator.vibrate) navigator.vibrate([300, 120, 300]);
      document.title = document.title.startsWith('⏰') ? baseTitle : `⏰ ${t("Time's up!")}`;
    };
    ring(); ringLoop = setInterval(ring, 1400);
  }
  function silence() {
    if (ringLoop) { clearInterval(ringLoop); ringLoop = null; document.title = baseTitle; if (navigator.vibrate) navigator.vibrate(0); }
    const d = document.querySelector('.tm-alert');
    if (d) { d.close(); d.remove(); }
  }

  /* ---------- full-screen alert ---------- */
  function showAlert() {
    let d = document.querySelector('.tm-alert');
    const ringing = Object.entries(T).filter(([, s]) => s.state === 'ring');
    if (!ringing.length) return;
    const html = `
      <div class="tm-alert-in">
        <span class="tm-alert-bell" aria-hidden="true">⏰</span>
        <h2>${esc(t("Time's up!"))}</h2>
        <ul>${ringing.map(([k, s]) => `<li><div><small>${esc(s.title)}</small><b>${esc(s.step)}</b></div>
          <span class="row"><button type="button" class="btn" data-tm-act="snooze" data-tm-key="${esc(k)}">${esc(t('+1 min'))}</button>
          <button type="button" class="btn primary" data-tm-act="ack" data-tm-key="${esc(k)}">${esc(t('Done'))}</button></span></li>`).join('')}</ul>
        ${ringing.length > 1 ? `<button type="button" class="btn primary tm-all" data-tm-act="ackall">${esc(t('Stop all'))}</button>` : ''}
      </div>`;
    if (!d) {
      d = document.createElement('dialog');
      d.className = 'tm-alert';
      d.setAttribute('role', 'alertdialog');
      d.setAttribute('aria-label', t("Time's up!"));
      d.addEventListener('cancel', (e) => e.preventDefault()); // must be acknowledged, not escaped
      document.body.append(d);
    }
    if (d.dataset.sig !== ringing.map(([k]) => k).join('|')) { d.innerHTML = html; d.dataset.sig = ringing.map(([k]) => k).join('|'); }
    if (!d.open) { d.showModal(); d.querySelector('[data-tm-act="ack"]')?.focus(); }
  }

  /* ---------- one recipe in progress at a time ---------- */
  // A recipe is "in progress" when one of its timers isn't idle or one of its steps is ticked off.
  const rkOf = (k) => k.slice(0, k.lastIndexOf(':'));
  function inProgress() {
    const by = {};
    const get = (rk, title) => (by[rk] ||= { rk, title: title || rk, timers: [], ticks: 0 });
    for (const [k, s] of Object.entries(T)) if (s.state !== 'idle') get(rkOf(k), s.title).timers.push(s);
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith('rt:')) continue;
        const v = JSON.parse(localStorage.getItem(k));
        const d = Array.isArray(v) ? v : (v && v.d) || [];
        if (d.length) { const e = get(k.slice(3), v && v.t); e.ticks = d.length; if (v && v.t) e.title = v.t; }
      }
    } catch {}
    return Object.values(by);
  }
  function stopRecipe(rk) {
    for (const [k, s] of Object.entries(T)) if (rkOf(k) === rk) Object.assign(s, { state: 'idle', end: null, left: null });
    save();
    try { localStorage.removeItem('rt:' + rk); } catch {}
    document.dispatchEvent(new CustomEvent('rt-reset', { detail: rk }));
    tick();
  }
  // Ask before starting work on a recipe while another one is going; on "stop", reset that one first.
  function claim(rk, title, proceed) {
    const others = inProgress().filter((x) => x.rk !== rk);
    if (!others.length) return proceed();
    const reasons = (o) => [
      ...o.timers.map((s) => `${s.state === 'ring' ? '⏰' : s.state === 'pause' ? '⏸' : '⏱'} ${t(s.state === 'ring' ? 'Timer ringing: {step}' : s.state === 'pause' ? 'Timer paused: {step} ({left} left)' : 'Timer still running: {step} ({left} left)', { step: s.step, left: fmt(left(s)) })}`),
      ...(o.ticks ? [`✓ ${o.ticks === 1 ? t('1 step ticked off') : t('{n} steps ticked off', { n: o.ticks })}`] : []),
    ];
    const name = others.map((o) => `“${o.title}”`).join(', ');
    const d = document.createElement('dialog');
    d.className = 'rt-confirm';
    d.setAttribute('aria-labelledby', 'rt-confirm-h');
    d.innerHTML = `<form method="dialog">
      <h2 id="rt-confirm-h">${esc(t('Stop preparing {name}?', { name }))}</h2>
      <p>${esc(t('You can cook one recipe at a time. Starting “{next}” resets {name}, so none of its timers go off later.', { next: title, name }))}</p>
      ${others.map((o) => `<div class="rt-confirm-why"><b>${esc(t('Still going in “{name}”:', { name: o.title }))}</b><ul>${reasons(o).map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>`).join('')}
      <div class="row"><button class="btn" value="keep" autofocus>${esc(t('Keep cooking {name}', { name }))}</button>
      <button class="btn danger-solid" value="stop">${esc(t('Stop and start “{next}”', { next: title }))}</button></div>
    </form>`;
    document.body.append(d);
    d.addEventListener('close', () => {
      const stop = d.returnValue === 'stop';
      d.remove();
      if (stop) { others.forEach((o) => stopRecipe(o.rk)); proceed(); }
    });
    d.showModal();
  }

  /* ---------- actions ---------- */
  function act(a, k) {
    const s = T[k];
    if (a === 'ackall') { Object.values(T).forEach((x) => { if (x.state === 'ring') x.state = 'idle'; }); save(); return tick(); }
    if (!s) return;
    audio(); // a click is the user gesture browsers need before they allow sound later
    if (a === 'toggle' && s.state === 'idle' && !s._claimed) {
      return claim(rkOf(k), s.title, () => { s._claimed = true; act(a, k); delete s._claimed; });
    }
    if (a === 'toggle') {
      if (s.state === 'run') { s.left = left(s); s.state = 'pause'; s.end = null; }
      else { s.end = Date.now() + (s.state === 'pause' ? s.left : s.dur) * 1000; s.state = 'run'; }
    }
    if (a === 'reset' || a === 'ack') { s.state = 'idle'; s.end = null; s.left = null; }
    if (a === 'add' || a === 'snooze') {
      if (s.state === 'run') s.end += 60000;
      else if (s.state === 'pause') s.left += 60;
      else if (s.state === 'ring') { s.state = 'run'; s.end = Date.now() + 60000; }
      else s.dur += 60;
    }
    save(); ensureLoop(); tick();
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tm-act]');
    if (!b) return;
    e.stopPropagation();
    act(b.dataset.tmAct, b.dataset.tmKey);
  }, true);
  document.addEventListener('change', (e) => {
    const k = e.target.dataset.tmPref;
    if (!k) return;
    P[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    store('rt-timer-prefs', P);
    paintAll();
  });

  /* ---------- looks ---------- */
  const LEAVES = [[18, 20], [24, 14], [31, 11], [38, 15], [43, 21], [14, 27], [21, 26], [28, 19], [35, 21], [41, 28], [47, 27], [17, 34], [25, 31], [33, 27], [39, 34], [46, 34], [22, 38], [30, 35], [37, 39], [27, 24]];
  function visual(style, small) {
    const cls = `tm-vis tm-${style}${small ? ' sm' : ''}`;
    if (style === 'clock') return `<span class="${cls}" data-style="clock" aria-hidden="true"><i class="tm-hand"></i></span>`;
    if (style === 'grid') return `<span class="${cls}" data-style="grid" aria-hidden="true">${'<i></i>'.repeat(small ? 12 : 30)}</span>`;
    if (style === 'tree') return `<span class="${cls}" data-style="tree" aria-hidden="true"><svg viewBox="0 0 60 60"><path class="tm-ground" d="M16 58.5h28"/><path class="tm-trunk" pathLength="1" d="M30 58V36M30 46 20 36M30 42 40 32M30 36 25 24M30 36 36 22"/>${LEAVES.map(([x, y]) => `<ellipse class="lf" cx="${x}" cy="${y}" rx="4.2" ry="3"/>`).join('')}</svg></span>`;
    return `<span class="${cls}" data-style="countdown" aria-hidden="true"><i class="tm-bar"></i></span>`;
  }
  function paintVis(vis, p) {
    if (vis.dataset.style !== P.style) { const n = document.createElement('span'); n.innerHTML = visual(P.style, vis.classList.contains('sm')); vis.replaceWith(vis = n.firstChild); }
    vis.style.setProperty('--p', p);
    if (P.style === 'tree') { // grows: leaves sprout as time passes, full tree at zero
      const leaves = vis.querySelectorAll('.lf'), grown = Math.round(Math.max(0, (p - 0.2) / 0.8) * leaves.length);
      leaves.forEach((x, i) => x.classList.toggle('on', i < grown));
      return;
    }
    const parts = vis.querySelectorAll(P.style === 'grid' ? 'i' : 'x');
    const gone = Math.round(p * parts.length);
    parts.forEach((x, i) => x.classList.toggle('gone', i < gone));
  }
  function paintAll() {
    document.querySelectorAll('[data-tm]').forEach((row) => {
      const s = T[row.dataset.tm]; if (!s) return;
      const rem = left(s), p = s.dur ? 1 - rem / s.dur : 0;
      row.dataset.state = s.state;
      row.querySelector('.tm-time').textContent = fmt(rem);
      const go = row.querySelector('[data-tm-act="toggle"]');
      go.textContent = t(s.state === 'run' ? 'Pause' : s.state === 'pause' ? 'Resume' : 'Start');
      go.classList.toggle('primary', s.state !== 'run');
      row.querySelectorAll('.tm-vis').forEach((v) => paintVis(v, p));
    });
    document.querySelectorAll('[data-tm-step]').forEach((cell) => {
      const s = T[cell.dataset.tmStep]; if (!s) return;
      const active = s.state === 'run' || s.state === 'pause', on = active || s.state === 'ring';
      const rem = left(s), p = s.dur ? 1 - rem / s.dur : 0;
      cell.style.setProperty('--tp', p);
      cell.classList.toggle('timing', on);
      let badge = cell.querySelector('.tm-badge');
      if (P.embed && on) {
        if (!badge) { badge = document.createElement('span'); badge.className = 'tm-badge'; badge.innerHTML = `${visual(P.style, true)}<b></b>`; cell.append(badge); }
        badge.querySelector('b').textContent = s.state === 'ring' ? '0:00' : fmt(rem);
        badge.querySelectorAll('.tm-vis').forEach((v) => paintVis(v, p));
      } else if (badge) badge.remove();
      let cover = cell.querySelector('.tm-cover');
      if (P.blackout && active) { if (!cover) { cover = document.createElement('span'); cover.className = 'tm-cover'; cover.setAttribute('aria-hidden', 'true'); cell.append(cover); } }
      else if (cover) cover.remove();
    });
    document.querySelectorAll('[data-tm-pref]').forEach((i) => { if (i.type === 'checkbox') i.checked = Boolean(P[i.dataset.tmPref]); else i.checked = P[i.dataset.tmPref] === i.value; });
  }

  /* ---------- the "time table" under a recipe ---------- */
  function keyFor(recipe, i) { return `${recipe.id || recipe.title}:${i}`; }
  function timed(recipe) {
    return (recipe.steps || []).map((s, i) => ({ i, text: s.text, d: parse(s.text) })).filter((x) => x.d);
  }
  function section(recipe) {
    const items = timed(recipe);
    if (!items.length) return '';
    for (const x of items) {
      const k = keyFor(recipe, x.i), s = T[k];
      if (!s) T[k] = { title: recipe.title, step: x.text, label: x.d.label, dur: x.d.secs, state: 'idle' };
      else if (s.state === 'idle' && s.label !== x.d.label) Object.assign(s, { step: x.text, label: x.d.label, dur: x.d.secs });
    }
    save();
    return `
      <section class="rt-timers" aria-label="${esc(t('Timers'))}">
        <div class="rt-timers-head">
          <h3>${esc(t('Timers'))}</h3>
          <details class="tm-prefs">
            <summary class="icon-btn" aria-label="${esc(t('Timer settings'))}" title="${esc(t('Timer settings'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg></summary>
            <div class="tm-prefs-panel">
              <fieldset><legend>${esc(t('Timer style'))}</legend>
                <div class="tm-styles">${STYLES.map(([v, l]) => `<label><input type="radio" name="tm-style-${esc(recipe.id || recipe.title)}" value="${v}" data-tm-pref="style"><span>${visual(v, true)}${esc(t(l))}</span></label>`).join('')}</div>
              </fieldset>
              ${[['embed', 'Show timers in the table'], ['blackout', 'Black out timed steps'], ['sound', 'Sound'], ['vibrate', 'Vibrate']].map(([k, l]) =>
                `<label class="switch"><input type="checkbox" data-tm-pref="${k}"><span aria-hidden="true"></span>${esc(t(l))}</label>`).join('')}
            </div>
          </details>
        </div>
        <ul class="rt-timer-list">${items.map((x) => { const k = esc(keyFor(recipe, x.i)); return `
          <li class="tm-row" data-tm="${k}" data-state="idle">
            ${visual(P.style)}
            <div class="tm-what"><b>${esc(x.text)}</b><small>${esc(x.d.label)}</small></div>
            <span class="tm-time" aria-live="off">${fmt(x.d.secs)}</span>
            <span class="tm-btns">
              <button type="button" class="btn primary" data-tm-act="toggle" data-tm-key="${k}">${esc(t('Start'))}</button>
              <button type="button" class="btn" data-tm-act="add" data-tm-key="${k}" title="${esc(t('+1 min'))}">${esc(t('+1 min'))}</button>
              <button type="button" class="icon-btn" data-tm-act="reset" data-tm-key="${k}" aria-label="${esc(t('Reset'))}" title="${esc(t('Reset'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4"/></svg></button>
            </span>
          </li>`; }).join('')}</ul>
      </section>`;
  }

  window.RecipeTimers = { parse, section, keyFor, paintAll, timed, claim };
  // Timers left running (or rung) before a reload pick up where they were.
  if (Object.values(T).some((s) => s.state === 'run' || s.state === 'ring')) { ensureLoop(); setTimeout(tick, 0); }
})();
