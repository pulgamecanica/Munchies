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
  const S = { t: 0, playing: false, speed: Number(pref('speed', 1)), cc: pref('cc', '1') === '1', sound: pref('sound', '1') === '1', scene: null, sub: -1 };
  let sb, audio = null, last = 0, table;

  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const label = (el, key) => el.setAttribute('aria-label', t(key));

  function setScene(sc) {
    S.scene = sc; S.sub = -1;
    art.dataset.pose = sc.pose;
    // Visible drawings draw themselves in again each time a scene starts.
    art.querySelectorAll('.prop').forEach((g) => { const on = sc.props.includes(g.id); g.classList.toggle('on', on); g.classList.remove('drawn'); });
    void art.offsetWidth;
    art.querySelectorAll('.prop.on, .arm').forEach((g) => g.classList.add('drawn'));
    caption.textContent = (sc.caption && (sc.caption[lang] || sc.caption.en)) || '';
    fig.querySelectorAll('.ht-chapters i').forEach((i) => i.classList.toggle('on', i.dataset.id === sc.id));
  }
  function light(sc, p) {
    // Highlight rows/steps; "seq" reveals them one by one over the scene; "done" ticks steps off.
    const h = sc.highlight || {};
    const rows = h.rows || [], steps = h.steps || [], seq = h.seq || sc.seq;
    const nRows = seq === 'rows' ? Math.ceil(p * rows.length) : rows.length;
    const done = sc.done || [], nDone = seq === 'done' ? Math.ceil(p * done.length) : done.length;
    const key = `${sc.id}:${nRows}:${nDone}`;
    if (key === S.sub) return;
    S.sub = key;
    const grid = $('.rt');
    if (!grid) return;
    grid.classList.toggle('dim', !h.all);
    grid.querySelectorAll('.rt-ing').forEach((el) => el.classList.toggle('hl', Boolean(h.all) || rows.slice(0, nRows).includes(Number(el.dataset.row))));
    grid.querySelectorAll('.rt-step').forEach((el) => {
      const i = Number(el.dataset.i);
      el.classList.toggle('hl', Boolean(h.all) || steps.includes(i));
      el.classList.toggle('done', done.slice(0, nDone).includes(i));
    });
  }
  function apply() {
    const sc = sb.scenes.find((x) => S.t >= x.start && S.t < x.end) || sb.scenes[sb.scenes.length - 1];
    if (sc !== S.scene) setScene(sc);
    light(sc, Math.min(1, (S.t - sc.start) / (sc.end - sc.start)));
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
    last = performance.now(); syncAudio(); requestAnimationFrame(frame);
  }
  function pause() {
    S.playing = false; fig.classList.remove('playing'); art.classList.remove('moving');
    label($('[data-ht="play"]'), 'Play');
    if (audio) audio.pause();
  }
  function seek(sec) { S.t = Math.max(0, Math.min(sb.duration, sec)); S.scene = null; apply(); syncAudio(); }
  function jump(dir) {
    const i = sb.scenes.indexOf(S.scene);
    const target = dir < 0 && S.t - S.scene.start > 1.5 ? S.scene : sb.scenes[Math.max(0, Math.min(sb.scenes.length - 1, i + dir))];
    seek(target.start);
  }
  function setSpeed(v) { S.speed = v; keep('speed', v); $('[data-ht="speed"]').textContent = `${v}×`; if (audio) audio.playbackRate = v; }
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
  art.querySelectorAll('path, ellipse, circle, rect, line, polyline, polygon').forEach((el) => {
    try { el.style.setProperty('--len', Math.ceil(el.getTotalLength()) + 1); } catch { el.style.setProperty('--len', 2000); }
  });

  fetch(fig.dataset.storyboard).then((r) => r.json()).then(async (data) => {
    sb = data;
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
