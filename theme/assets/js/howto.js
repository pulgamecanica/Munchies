/* "How to read a recipe" player. Everything is driven by assets/how-to-read/storyboard.json:
   scenes (time ranges) set the arm pose, which drawings are visible, which recipe rows/steps light up, and the caption.
   The player owns the clock; the voice-over (if the audio file exists) follows it and keeps it honest while playing. */
(() => {
  const fig = document.getElementById('howto');
  if (!fig) return;
  const t = window.t || ((k) => k), lang = (window.I18N && window.I18N.lang) || 'en';
  const $ = (s) => fig.querySelector(s);
  const art = $('.ht-art'), caption = $('.ht-caption'), range = $('[data-seek]'), time = $('.ht-time');
  const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
  const pref = (k, d) => { try { const v = localStorage.getItem('ht-' + k); return v === null ? d : v; } catch { return d; } };
  const keep = (k, v) => { try { localStorage.setItem('ht-' + k, v); } catch {} };
  const S = { t: 0, playing: false, speed: Number(pref('speed', 1)), cc: pref('cc', '1') === '1', sound: pref('sound', '1') === '1', scene: null, sub: -1, fired: new Set(), anims: new Set() };
  const NS = 'http://www.w3.org/2000/svg', reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let sb, audio = null, last = 0, table, ROWS = [];

  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const label = (el, key) => el.setAttribute('aria-label', t(key));

  function setPose(pose) {
    // The pouring bowl has to be drawn over the other one: bowl A goes on top only while it pours back into B.
    // Moved before the pose changes (so its tilt still transitions) and marked "settled" (so it doesn't draw itself in again).
    const a = art.querySelector('#bowl-a'), b = art.querySelector('#bowl-b');
    if (a && b) {
      const aFirst = Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      if ((pose === 'pour-back') === aFirst) { a.classList.add('settled'); if (aFirst) b.after(a); else b.before(a); void a.getBoundingClientRect(); }
    }
    // .enter holds the pose's starting position for a moment, so CSS can animate into it (e.g. lowering the whisk into the bowl).
    art.classList.add('enter'); clearTimeout(S.enterT);
    S.enterT = setTimeout(() => art.classList.remove('enter'), 1000);
    art.dataset.pose = pose;
  }
  function showProp(g, on) {
    if (!g || g.classList.contains('on') === on) return;
    g.classList.toggle('on', on); g.classList.remove('drawn');
    if (on) { void g.getBoundingClientRect(); g.classList.add('drawn'); }
  }
  function setScene(sc) {
    S.scene = sc; S.sub = -1; S.fired = new Set();
    S.anims.forEach((a) => a.cancel()); S.anims.clear();
    art.querySelectorAll('.flying, .ht-pop').forEach((x) => x.remove());
    setPose(sc.pose); art.dataset.scene = sc.id;
    art.querySelectorAll('.cracked, .settled').forEach((x) => x.classList.remove('cracked', 'settled'));
    // Visible drawings draw themselves in again each time a scene starts (timed ones wait for their moment).
    const later = { ...(sc.reveal || {}), ...(sc.show || {}) };
    art.querySelectorAll('.prop').forEach((g) => { const on = sc.props.includes(g.id) && !(g.id in later); g.classList.toggle('on', on); g.classList.remove('drawn'); });
    void art.offsetWidth;
    art.querySelectorAll('.prop.on, .arm').forEach((g) => g.classList.add('drawn'));
    caption.textContent = (sc.caption && (sc.caption[lang] || sc.caption.en)) || '';
    fig.querySelectorAll('.ht-chapters i').forEach((i) => i.classList.toggle('on', i.dataset.id === sc.id));
  }
  function light(sc, p, tl) {
    // Highlight rows/steps; "seq" reveals them one by one over the scene; "done" ticks steps off; with "drops", a row lights as its ingredient lands.
    const h = sc.highlight || {};
    const rows = h.rows || [], steps = h.steps || [], seq = h.seq || sc.seq;
    const nRows = seq === 'rows' ? Math.ceil(p * rows.length) : rows.length;
    const lit = sc.drops ? sc.drops.filter((d) => tl >= d.at).map((d) => d.row) : rows.slice(0, nRows); // with drops: the rows that have landed
    const done = sc.done || [], nDone = seq === 'done' ? Math.ceil(p * done.length) : done.length;
    const key = `${sc.id}:${lit.join(',')}:${nDone}`;
    if (key === S.sub) return;
    S.sub = key;
    // Timed drawings: each one appears (and draws itself in) the moment its recipe row lights up.
    for (const [id, row] of Object.entries(sc.reveal || {})) showProp(art.querySelector('#' + id), rows.slice(0, nRows).includes(row));
    const grid = $('.rt');
    if (!grid) return;
    grid.classList.toggle('dim', !h.all);
    grid.querySelectorAll('.rt-ing').forEach((el) => el.classList.toggle('hl', Boolean(h.all) || lit.includes(Number(el.dataset.row))));
    grid.querySelectorAll('.rt-step').forEach((el) => {
      const i = Number(el.dataset.i);
      el.classList.toggle('hl', Boolean(h.all) || steps.includes(i));
      el.classList.toggle('done', done.slice(0, nDone).includes(i));
    });
  }
  // In-scene timeline (seconds from the scene's start): "poses" change the arms, "show" brings a prop in, "drops" add an ingredient.
  function timeline(sc, tl) {
    const pose = (sc.poses || []).reduce((cur, e) => (tl >= e.at ? e.pose : cur), sc.pose);
    if (art.dataset.pose !== pose) setPose(pose);
    for (const [id, at] of Object.entries(sc.show || {})) showProp(art.querySelector('#' + id), tl >= at);
    for (const d of sc.drops || []) if (S.playing && tl >= d.at && tl < d.at + 0.5 && !S.fired.has(d.at)) { S.fired.add(d.at); drop(d); }
    for (const d of sc.drops || []) if (d.crack) art.querySelector('#' + d.prop)?.classList.toggle('cracked', tl >= d.at); // whole again if you seek back
  }
  const track = (a) => { S.anims.add(a); a.playbackRate = S.speed; if (!S.playing) a.pause(); a.finished.catch(() => {}).finally(() => S.anims.delete(a)); return a; };
  // An ingredient goes into the bowl: a copy of its drawing flies there and shrinks, then its amount pops up ("+200 g").
  // Ingredients with no drawing (baking powder, salt) only pop, with their name.
  function drop(d) {
    const ing = ROWS[d.row]; if (!ing) return;
    const bowl = art.querySelector('#' + (d.into || 'bowl-a')), rim = bowl && bowl.querySelector('ellipse');
    const tx = rim ? Number(rim.getAttribute('cx')) : 200, ty = rim ? Number(rim.getAttribute('cy')) : 240;
    // "+200 g"; counted things and ingredients with no drawing say what they are ("+2 eggs", "+1 pinch salt")
    const named = !d.prop || ing.unit === 'pcs' || !ing.unit;
    const text = `+${ing.amount ? `${ing.amount} ` : ''}${ing.unit === 'pcs' ? '' : ing.unit || ''}${named ? ` ${ing.name}` : ''}`.replace(/\s+/g, ' ').trim();
    const src = d.prop && art.querySelector('#' + d.prop);
    if (!src || reduced()) return pop(text, tx, ty);
    const front = bowl.querySelector('.front'), into = front.parentNode; // copies go just behind the bowl's front face, so they drop *into* it
    if (d.crack) return crack(src, into, front, tx, ty, text);
    const svg = art.querySelector('svg'), inv = svg.getScreenCTM().inverse(), r = src.getBoundingClientRect();
    const c = new DOMPoint(r.left + r.width / 2, r.top + r.height / 2).matrixTransform(inv);
    const g = document.createElementNS(NS, 'g'), copy = src.cloneNode(true);
    copy.removeAttribute('id'); copy.removeAttribute('class'); copy.style.strokeWidth = getComputedStyle(src).strokeWidth;
    g.setAttribute('class', 'flying'); g.append(copy);
    into.insertBefore(g, front);
    g.style.transformOrigin = `${c.x}px ${c.y}px`;
    const dx = tx - c.x, dy = ty - c.y;
    track(g.animate([
      { transform: 'translate(0, 0) scale(1)' },
      { transform: `translate(${dx * 0.55}px, ${dy * 0.55 - 48}px) scale(.55)`, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy + 14}px) scale(.12)` },
    ], { duration: 1100, easing: 'cubic-bezier(.45, 0, .55, 1)', fill: 'forwards' })).finished.then(() => { g.remove(); pop(text, tx, ty); }).catch(() => {});
  }
  // The egg cracks along a zigzag: the two shell halves tip away and fade, the yolk drops into the bowl.
  function crack(src, into, front, tx, ty, text) {
    const svg = art.querySelector('svg'), inv = svg.getScreenCTM().inverse(), r = src.getBoundingClientRect();
    const c = new DOMPoint(r.left + r.width / 2, r.top + r.height / 2).matrixTransform(inv);
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'flying'); g.setAttribute('transform', `translate(${c.x.toFixed(1)} ${c.y.toFixed(1)})`);
    g.innerHTML = `<path class="shell top" d="M11.4 0.5 C11 -8 5.5 -15 0 -15 C-5.5 -15 -11 -8 -11.4 0.5 L-9 -1.5 L-5.5 2.5 L-2 -1.5 L1.5 2.5 L5 -1.5 L8.5 2.5 Z"/>`
      + `<path class="shell bottom" d="M-11.4 0.5 L-9 -1.5 L-5.5 2.5 L-2 -1.5 L1.5 2.5 L5 -1.5 L8.5 2.5 L11.4 0.5 C11.5 9 6.5 15 0 15 C-6.5 15 -11.5 9 -11.4 0.5 Z"/>`
      + '<circle class="yolk" cx="0" cy="1" r="5.5"/>';
    into.insertBefore(g, front);
    src.classList.add('cracked');
    const [top, bottom, yolk] = g.children;
    for (const el of g.children) { el.style.transformBox = 'fill-box'; el.style.transformOrigin = 'center'; }
    const shell = (el, x, y, rot) => track(el.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${x}px, ${y}px) rotate(${rot}deg)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${x * 1.4}px, ${y * 1.4 + 6}px) rotate(${rot * 1.2}deg)`, opacity: 0 }], { duration: 1100, easing: 'ease-out', fill: 'forwards' }));
    shell(top, -12, -9, -38); shell(bottom, 12, -4, 32);
    track(yolk.animate([{ transform: 'translate(0, 0) scale(1)' }, { transform: 'translate(0, 0) scale(1)', offset: 0.25 },
      { transform: `translate(${(tx - c.x).toFixed(1)}px, ${(ty - c.y + 12).toFixed(1)}px) scale(.85)` }], { duration: 1000, easing: 'cubic-bezier(.5, 0, .9, .6)', fill: 'forwards' }))
      .finished.then(() => { g.remove(); pop(text, tx, ty); }).catch(() => {});
  }
  function pop(text, x, y) {
    // a small burst of rays where it lands, in the palette's accent
    if (!reduced()) {
      const burst = document.createElementNS(NS, 'g');
      burst.setAttribute('class', 'ht-pop ht-burst');
      burst.innerHTML = [0, 60, 120, 180, 240, 300].map((a) => { const r = (a - 90) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
        return `<path d="M${(x + c * 9).toFixed(1)} ${(y - 4 + s * 6).toFixed(1)} L${(x + c * 17).toFixed(1)} ${(y - 4 + s * 11).toFixed(1)}"/>`; }).join('');
      art.querySelector('svg').append(burst);
      track(burst.animate([{ opacity: 0, transform: 'scale(.4)' }, { opacity: 1, transform: 'scale(1)', offset: 0.35 }, { opacity: 0, transform: 'scale(1.35)' }],
        { duration: 600, easing: 'ease-out', fill: 'forwards' })).finished.then(() => burst.remove()).catch(() => {});
    }
    const el = document.createElementNS(NS, 'text');
    el.setAttribute('class', 'ht-pop'); el.setAttribute('x', x); el.setAttribute('y', y - 22); el.textContent = text;
    art.querySelector('svg').append(el);
    const a = reduced()
      ? [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }]
      : [{ opacity: 0, transform: 'translateY(8px) scale(.6)' }, { opacity: 1, transform: 'translateY(0) scale(1.12)', offset: 0.18 },
         { opacity: 1, transform: 'translateY(-6px) scale(1)', offset: 0.7 }, { opacity: 0, transform: 'translateY(-18px) scale(1)' }];
    track(el.animate(a, { duration: 1200, easing: 'ease-out', fill: 'forwards' })).finished.then(() => el.remove()).catch(() => {});
  }
  function apply() {
    const sc = sb.scenes.find((x) => S.t >= x.start && S.t < x.end) || sb.scenes[sb.scenes.length - 1];
    if (sc !== S.scene) setScene(sc);
    const tl = S.t - sc.start;
    timeline(sc, tl);
    light(sc, Math.min(1, tl / (sc.end - sc.start)), tl);
    range.value = Math.round((S.t / sb.duration) * 1000);
    range.style.setProperty('--p', `${(S.t / sb.duration) * 100}%`);
    time.textContent = `${fmt(S.t)} / ${fmt(sb.duration)}`;
  }
  function frame(now) {
    if (!S.playing) return;
    if (audio && !audio.paused && S.sound && Math.abs(audio.currentTime - S.t) > 0.25) S.t = audio.currentTime; // voice-over is the reference while it plays
    else S.t += ((now - last) / 1000) * S.speed;
    last = now;
    if (S.t >= sb.duration) { S.t = sb.duration; apply(); return pause(); }
    apply();
    requestAnimationFrame(frame);
  }
  function syncAudio() {
    if (!audio) return;
    audio.playbackRate = S.speed; audio.muted = !S.sound;
    if (Math.abs(audio.currentTime - S.t) > 0.2) audio.currentTime = Math.min(S.t, audio.duration || S.t);
    if (S.playing && S.sound) audio.play().catch(() => {}); else audio.pause();
  }
  function play() {
    if (S.t >= sb.duration) S.t = 0;
    S.playing = true; fig.classList.add('playing'); art.classList.add('moving');
    label($('[data-ht="play"]'), 'Pause');
    S.anims.forEach((a) => a.play());
    last = performance.now(); syncAudio(); requestAnimationFrame(frame);
  }
  function pause() {
    S.playing = false; fig.classList.remove('playing'); art.classList.remove('moving');
    label($('[data-ht="play"]'), 'Play');
    S.anims.forEach((a) => a.pause()); // flights and pops freeze with the player
    if (audio) audio.pause();
  }
  function seek(sec) { S.t = Math.max(0, Math.min(sb.duration, sec)); S.scene = null; apply(); syncAudio(); }
  function jump(dir) {
    const i = sb.scenes.indexOf(S.scene);
    const target = dir < 0 && S.t - S.scene.start > 1.5 ? S.scene : sb.scenes[Math.max(0, Math.min(sb.scenes.length - 1, i + dir))];
    seek(target.start);
  }
  function setSpeed(v) { S.speed = v; keep('speed', v); S.anims.forEach((a) => { a.playbackRate = v; }); $('[data-ht="speed"]').textContent = `${v}×`; if (audio) audio.playbackRate = v; }
  function setCC(on) { S.cc = on; keep('cc', on ? '1' : '0'); fig.classList.toggle('no-cc', !on); $('[data-ht="cc"]').setAttribute('aria-pressed', String(on)); }
  function setSound(on) { S.sound = on; keep('sound', on ? '1' : '0'); $('[data-ht="sound"]').setAttribute('aria-pressed', String(on)); syncAudio(); }

  fig.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ht]'); if (!b || b.disabled) return;
    const a = b.dataset.ht;
    if (a === 'play') S.playing ? pause() : play();
    if (a === 'restart') { seek(0); play(); }
    if (a === 'prev') jump(-1);
    if (a === 'next') jump(1);
    if (a === 'speed') setSpeed(SPEEDS[(SPEEDS.indexOf(S.speed) + 1) % SPEEDS.length]);
    if (a === 'cc') setCC(!S.cc);
    if (a === 'sound') setSound(!S.sound);
  });
  range.addEventListener('input', () => seek((range.value / 1000) * sb.duration));
  // Keyboard: space/k play, ←/→ scenes, c captions, m sound, r restart, +/- speed.
  fig.addEventListener('keydown', (e) => {
    if (e.target === range && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    const k = e.key.toLowerCase();
    const map = { ' ': 'play', k: 'play', arrowleft: 'prev', arrowright: 'next', c: 'cc', m: 'sound', r: 'restart' };
    if (map[k] && !(k === ' ' && e.target.closest('button'))) { e.preventDefault(); fig.querySelector(`[data-ht="${map[k]}"]`).click(); }
    if (k === '+' || k === '=') setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(S.speed) + 1)]);
    if (k === '-') setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(S.speed) - 1)]);
  });

  // Measure every drawn shape once so the draw-in works for any SVG art (no special attributes needed).
  // Hand-drawn touch: about two in five outlines of the props and the worktop stop a few units short of closing, the same ones every time.
  // Arms, labels, nails and crystals always close (a short finger or a broken label reads as a mistake, not a sketch).
  art.querySelectorAll('path, ellipse, circle, rect, line, polyline, polygon').forEach((el, i) => {
    let len = 2000;
    try { len = Math.ceil(el.getTotalLength()) + 1; } catch {}
    el.style.setProperty('--len', len);
    const sketchy = el.closest('.prop, .counter') && !el.matches('.brand, .brand-mark, .grain') && len > 30 && (i * 7) % 5 < 2;
    if (sketchy) el.style.setProperty('--gap', Math.min(len * 0.12, 5 + ((i * 37) % 60) / 10).toFixed(1));
  });

  fetch(fig.dataset.storyboard).then((r) => r.json()).then(async (data) => {
    sb = data;
    ROWS = sb.recipe.steps.flatMap((st) => st.uses || []); // table rows, top to bottom
    // The demo recipe, rendered by the same code as every recipe on the site.
    table = document.getElementById('ht-table');
    window.RecipeTable.render(sb.recipe, table, { head: true, timers: false });
    table.querySelectorAll('.rt-controls, .rt-howto').forEach((x) => x.remove());
    fig.querySelector('.ht-chapters').innerHTML = sb.scenes.map((s) => `<i data-id="${s.id}" style="left:${(s.start / sb.duration) * 100}%"></i>`).join('');
    // Voice-over: optional. If the file for this language (or English) is missing, the sound button says so.
    const file = sb.audio && (sb.audio[lang] || sb.audio.en);
    if (file) {
      const url = new URL(file, new URL(fig.dataset.storyboard, location.href)).href;
      const ok = await fetch(url, { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
      if (ok) { audio = new Audio(url); audio.preload = 'auto'; }
    }
    const snd = $('[data-ht="sound"]');
    if (!audio) { snd.disabled = true; snd.title = t('Voice-over coming soon'); snd.setAttribute('aria-label', t('Voice-over coming soon')); }
    ['restart', 'prev', 'next', 'speed', 'cc'].forEach((k) => label($(`[data-ht="${k}"]`), { restart: 'Restart', prev: 'Previous', next: 'Next', speed: 'Speed', cc: 'Captions' }[k]));
    if (audio) label(snd, 'Sound');
    label(range, 'Seek');
    setSpeed(S.speed); setCC(S.cc); setSound(S.sound);
    apply();
    // Start when the player scrolls into view (muted autoplay is the only kind browsers allow).
    new IntersectionObserver((en, ob) => { if (en[0].isIntersecting) { ob.disconnect(); if (!matchMedia('(prefers-reduced-motion: reduce)').matches) play(); } }, { threshold: 0.6 }).observe(fig);
  });
})();
