const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];

const STORAGE_KEY = 'hushboard:v1';

const DEFAULTS = {
  version: 1,
  master: 0.6,
  channels: {
    rain:   { on: true,  vol: 0.35, tone: 0.55 },
    brown:  { on: false, vol: 0.25, tone: 0.45 },
    binaural:{ on: false, vol: 0.18, beat: 6 },
    cafe:   { on: false, vol: 0.25, tone: 0.35 },
    chime:  { on: false, vol: 0.12, rate: 0.35 },
  },
  timer: {
    minutes: 25,
    fadeSeconds: 10,
    endBehavior: 'fade',
  }
};

const CHANNEL_DEFS = [
  { id:'rain', name:'Rain', desc:'Filtered noise with gentle shimmer.' },
  { id:'brown', name:'Brown Noise', desc:'Low rumble that masks HVAC/traffic.' },
  { id:'binaural', name:'Binaural', desc:'Two tones; best with headphones.' },
  { id:'cafe', name:'Cafe Murmur', desc:'Mid band noise for “public focus”.' },
  { id:'chime', name:'Soft Chime', desc:'Occasional micro-bell to reset attention.' },
];

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function nowMs(){ return Date.now(); }

function fmtTime(ms){
  const s = Math.max(0, Math.floor(ms/1000));
  const m = Math.floor(s/60);
  const r = s % 60;
  return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;
}

function safeParse(json, fallback){
  try { return JSON.parse(json); } catch { return fallback; }
}

function encodeSceneToHash(scene){
  const json = JSON.stringify(scene);
  const b64 = btoa(unescape(encodeURIComponent(json)))
    .replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  return `#s=${b64}`;
}

function decodeSceneFromHash(){
  const m = location.hash.match(/#s=([^&]+)/);
  if(!m) return null;
  const b64 = m[1].replaceAll('-','+').replaceAll('_','/');
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const json = decodeURIComponent(escape(atob(b64 + pad)));
  return safeParse(json, null);
}

function loadState(){
  const raw = localStorage.getItem(STORAGE_KEY);
  const stored = raw ? safeParse(raw, null) : null;
  if (stored && stored.mix) return stored; // current format
  return {
    mix: structuredClone(DEFAULTS),
    scenes: [],
    updatedAt: nowMs(),
  };
}

function saveState(state){
  state.updatedAt = nowMs();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid(){
  return Math.random().toString(16).slice(2) + '-' + Math.random().toString(16).slice(2);
}

// -------------------- Audio Engine --------------------
class Engine{
  constructor(){
    this.ctx = null;
    this.master = null;
    this.running = false;

    this.nodes = {}; // per channel
    this.noiseBuffers = {}; // cached buffers

    this._chimeInterval = null;
  }

  async start(){
    if (this.running) return;
    if (!this.ctx){
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(this.ctx.destination);
    }

    // Some browsers start suspended.
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.ensureChannels();
    this.running = true;
  }

  async stop(){
    if (!this.ctx) return;
    try{
      if (this._chimeInterval) clearInterval(this._chimeInterval);
      this._chimeInterval = null;

      Object.values(this.nodes).forEach(n => {
        try{ n.stop?.(); }catch{}
        try{ n.disconnect?.(); }catch{}
      });
      this.nodes = {};

      await this.ctx.close();
    } finally {
      this.ctx = null;
      this.master = null;
      this.running = false;
    }
  }

  ensureChannels(){
    this.ensureNoiseChannel('rain', { hp: 180, lp: 4200, q: 0.9, color: 'white' });
    this.ensureNoiseChannel('brown', { hp: 20, lp: 900, q: 0.7, color: 'brown' });
    this.ensureNoiseChannel('cafe', { hp: 250, lp: 2200, q: 0.6, color: 'pink' });
    this.ensureBinaural('binaural');
    this.ensureChime('chime');
  }

  setMaster(vol){
    if (!this.master) return;
    this.master.gain.setTargetAtTime(clamp(vol,0,1), this.ctx.currentTime, 0.02);
  }

  setChannelOn(id, on){
    const ch = this.nodes[id];
    if (!ch) return;
    ch.gain.gain.setTargetAtTime(on ? ch._targetVol : 0, this.ctx.currentTime, 0.03);
  }

  setChannelVol(id, vol){
    const ch = this.nodes[id];
    if (!ch) return;
    ch._targetVol = clamp(vol,0,1);
    ch.gain.gain.setTargetAtTime(ch._isOn ? ch._targetVol : 0, this.ctx.currentTime, 0.03);
  }

  setChannelTone(id, tone){
    const ch = this.nodes[id];
    if (!ch) return;
    if (ch.filter){
      // map 0..1 → cutoffs
      const hp = 30 + tone * 500;
      const lp = 800 + tone * 5200;
      ch.hp.frequency.setTargetAtTime(hp, this.ctx.currentTime, 0.03);
      ch.lp.frequency.setTargetAtTime(lp, this.ctx.currentTime, 0.03);
    }
  }

  setBinauralBeat(id, beatHz){
    const ch = this.nodes[id];
    if (!ch) return;
    const beat = clamp(+beatHz || 6, 1, 20);
    const base = 220;
    ch.oscL.frequency.setTargetAtTime(base, this.ctx.currentTime, 0.02);
    ch.oscR.frequency.setTargetAtTime(base + beat, this.ctx.currentTime, 0.02);
  }

  setChimeRate(id, rate){
    const ch = this.nodes[id];
    if (!ch) return;
    ch._rate = clamp(rate, 0, 1);
    this._rearmChime();
  }

  async fadeToSilent(seconds){
    if (!this.master) return;
    const s = clamp(seconds, 0, 120);
    if (s === 0){
      this.master.gain.setValueAtTime(0, this.ctx.currentTime);
      return;
    }
    const t0 = this.ctx.currentTime;
    const v0 = this.master.gain.value;
    this.master.gain.setValueAtTime(v0, t0);
    this.master.gain.linearRampToValueAtTime(0.0001, t0 + s);
  }

  ensureNoiseChannel(id, {hp, lp, q, color}){
    if (this.nodes[id]) return;

    const ctx = this.ctx;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    const hpF = ctx.createBiquadFilter();
    hpF.type = 'highpass';
    hpF.frequency.value = hp;
    hpF.Q.value = q;

    const lpF = ctx.createBiquadFilter();
    lpF.type = 'lowpass';
    lpF.frequency.value = lp;
    lpF.Q.value = q;

    const src = ctx.createBufferSource();
    src.buffer = this.getNoiseBuffer(color);
    src.loop = true;

    // src → hp → lp → gain → master
    src.connect(hpF);
    hpF.connect(lpF);
    lpF.connect(gain);
    gain.connect(this.master);

    src.start();

    this.nodes[id] = {
      kind: 'noise',
      src,
      hp: hpF,
      lp: lpF,
      filter: true,
      gain,
      _targetVol: 0.3,
      _isOn: false,
    };
  }

  ensureBinaural(id){
    if (this.nodes[id]) return;
    const ctx = this.ctx;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    const panL = ctx.createStereoPanner();
    panL.pan.value = -0.85;

    const panR = ctx.createStereoPanner();
    panR.pan.value = 0.85;

    const oscL = ctx.createOscillator();
    oscL.type = 'sine';
    const oscR = ctx.createOscillator();
    oscR.type = 'sine';

    oscL.connect(panL);
    oscR.connect(panR);
    panL.connect(gain);
    panR.connect(gain);
    gain.connect(this.master);

    oscL.start();
    oscR.start();

    this.nodes[id] = {
      kind: 'binaural',
      oscL, oscR,
      gain,
      _targetVol: 0.15,
      _isOn: false,
    };
  }

  ensureChime(id){
    if (this.nodes[id]) return;
    const ctx = this.ctx;

    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.master);

    this.nodes[id] = {
      kind: 'chime',
      gain,
      _targetVol: 0.12,
      _isOn: false,
      _rate: 0.35,
    };

    this._rearmChime();
  }

  _rearmChime(){
    if (this._chimeInterval) clearInterval(this._chimeInterval);
    if (!this.ctx) return;

    // Rate 0..1 → interval 30s..5s
    const ch = this.nodes['chime'];
    if (!ch) return;
    const intervalMs = Math.round(30000 - ch._rate * 25000);

    this._chimeInterval = setInterval(() => {
      const c = this.nodes['chime'];
      if (!c || !c._isOn) return;
      this._playChimeOnce(c._targetVol);
    }, intervalMs);
  }

  _playChimeOnce(vol){
    const ctx = this.ctx;
    const t0 = ctx.currentTime;

    const osc = ctx.createOscillator();
    const g = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(880, t0);
    osc.frequency.exponentialRampToValueAtTime(660, t0 + 0.12);

    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(clamp(vol,0,1), t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);

    osc.connect(g);
    g.connect(this.nodes['chime'].gain);

    osc.start(t0);
    osc.stop(t0 + 0.28);
  }

  getNoiseBuffer(color){
    if (this.noiseBuffers[color]) return this.noiseBuffers[color];

    const ctx = this.ctx;
    const sampleRate = ctx.sampleRate;
    const seconds = 2;
    const buffer = ctx.createBuffer(1, sampleRate * seconds, sampleRate);
    const data = buffer.getChannelData(0);

    if (color === 'white'){
      for (let i=0;i<data.length;i++) data[i] = (Math.random()*2-1) * 0.6;
    } else if (color === 'pink'){
      // Voss-McCartney-ish (simple)
      let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
      for (let i=0;i<data.length;i++){
        const w = Math.random()*2-1;
        b0 = 0.99886*b0 + w*0.0555179;
        b1 = 0.99332*b1 + w*0.0750759;
        b2 = 0.96900*b2 + w*0.1538520;
        b3 = 0.86650*b3 + w*0.3104856;
        b4 = 0.55000*b4 + w*0.5329522;
        b5 = -0.7616*b5 - w*0.0168980;
        const pink = b0+b1+b2+b3+b4+b5+b6+w*0.5362;
        b6 = w*0.115926;
        data[i] = (pink*0.11);
      }
    } else if (color === 'brown'){
      let last = 0;
      for (let i=0;i<data.length;i++){
        const w = (Math.random()*2-1) * 0.05;
        last = clamp(last + w, -1, 1);
        data[i] = last * 0.7;
      }
    } else {
      for (let i=0;i<data.length;i++) data[i] = (Math.random()*2-1) * 0.6;
    }

    this.noiseBuffers[color] = buffer;
    return buffer;
  }
}

const engine = new Engine();

// -------------------- UI + State --------------------
let state = loadState();
let timer = { running: false, endAt: 0, tick: null };

function mixSnapshot(){
  const m = structuredClone(state.mix);
  return m;
}

function applyMixToUI(mix){
  $('#master').value = mix.master;

  for (const def of CHANNEL_DEFS){
    const ch = mix.channels[def.id];
    if (!ch) continue;
    const el = $(`[data-ch="${def.id}"]`);
    if (!el) continue;

    el.querySelector('input[data-k="on"]').checked = !!ch.on;
    el.querySelector('input[data-k="vol"]').value = ch.vol;

    const extras = el.querySelectorAll('input[data-k], select[data-k]');
    extras.forEach(x => {
      const k = x.dataset.k;
      if (k === 'tone' && ch.tone != null) x.value = ch.tone;
      if (k === 'beat' && ch.beat != null) x.value = ch.beat;
      if (k === 'rate' && ch.rate != null) x.value = ch.rate;
    });
  }

  $('#timerMinutes').value = mix.timer.minutes;
  $('#fadeSeconds').value = mix.timer.fadeSeconds;
  $('#endBehavior').value = mix.timer.endBehavior;
}

function applyMixToAudio(mix){
  engine.setMaster(mix.master);
  for (const def of CHANNEL_DEFS){
    const ch = mix.channels[def.id];
    if (!ch) continue;

    if (def.id === 'binaural') engine.setBinauralBeat('binaural', ch.beat);
    if (def.id === 'chime') engine.setChimeRate('chime', ch.rate);
    if (ch.tone != null) engine.setChannelTone(def.id, ch.tone);

    const node = engine.nodes[def.id];
    if (node){
      node._isOn = !!ch.on;
      engine.setChannelVol(def.id, ch.vol);
      engine.setChannelOn(def.id, !!ch.on);
    }
  }
}

function renderChannels(){
  const wrap = $('#channels');
  wrap.innerHTML = '';

  for (const def of CHANNEL_DEFS){
    const ch = state.mix.channels[def.id];

    const el = document.createElement('div');
    el.className = 'channel';
    el.dataset.ch = def.id;

    const extras = (() => {
      if (def.id === 'binaural'){
        return `
          <label class="chip">
            <span>Beat Hz</span>
            <input data-k="beat" type="range" min="1" max="20" step="0.5" value="${ch.beat}" />
          </label>
        `;
      }
      if (def.id === 'chime'){
        return `
          <label class="chip">
            <span>Rate</span>
            <input data-k="rate" type="range" min="0" max="1" step="0.01" value="${ch.rate}" />
          </label>
        `;
      }
      // noise channels
      if (def.id === 'rain' || def.id === 'brown' || def.id === 'cafe'){
        return `
          <label class="chip">
            <span>Tone</span>
            <input data-k="tone" type="range" min="0" max="1" step="0.01" value="${ch.tone}" />
          </label>
        `;
      }
      return '';
    })();

    el.innerHTML = `
      <div class="channel-top">
        <div>
          <div class="ch-name">${def.name}</div>
          <div class="ch-desc">${def.desc}</div>
        </div>
        <label class="switch">
          <span>On</span>
          <input data-k="on" type="checkbox" ${ch.on ? 'checked' : ''} />
        </label>
      </div>

      <div class="ch-controls">
        <label class="chip">
          <span>Vol</span>
          <input data-k="vol" type="range" min="0" max="1" step="0.01" value="${ch.vol}" />
        </label>
        ${extras}
      </div>
    `;

    wrap.appendChild(el);
  }
}

function renderScenes(){
  const wrap = $('#scenes');
  wrap.innerHTML = '';

  if (!state.scenes.length){
    const empty = document.createElement('div');
    empty.className = 'tiny';
    empty.textContent = 'No saved scenes yet. Make a mix and press “Save scene”.';
    wrap.appendChild(empty);
    return;
  }

  const sorted = [...state.scenes].sort((a,b) => b.createdAt - a.createdAt);

  for (const s of sorted){
    const el = document.createElement('div');
    el.className = 'scene';

    el.innerHTML = `
      <div class="meta">
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="small">${new Date(s.createdAt).toLocaleString()}</div>
      </div>
      <div class="actions">
        <button class="btn" data-act="load" data-id="${s.id}" type="button">Load</button>
        <button class="btn" data-act="link" data-id="${s.id}" type="button">Link</button>
        <button class="btn" data-act="del" data-id="${s.id}" type="button">Delete</button>
      </div>
    `;

    wrap.appendChild(el);
  }
}

function escapeHtml(str){
  return String(str)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;');
}

function currentSceneObject(){
  return {
    kind: 'hushboard-scene',
    version: 1,
    name: 'Shared scene',
    createdAt: nowMs(),
    mix: mixSnapshot(),
  };
}

async function copyText(text){
  try{
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Copied');
  }
}

function toast(msg){
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.position='fixed';
  t.style.left='50%';
  t.style.bottom='22px';
  t.style.transform='translateX(-50%)';
  t.style.padding='10px 12px';
  t.style.border='1px solid rgba(124,194,255,0.35)';
  t.style.background='rgba(2,8,15,0.75)';
  t.style.borderRadius='999px';
  t.style.fontFamily='var(--mono)';
  t.style.fontSize='12px';
  t.style.zIndex='9999';
  t.style.backdropFilter='blur(10px)';
  document.body.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity 250ms'; }, 1200);
  setTimeout(()=> t.remove(), 1600);
}

function resetMix(){
  state.mix = structuredClone(DEFAULTS);
  saveState(state);
  renderChannels();
  applyMixToUI(state.mix);
  if (engine.running){
    applyMixToAudio(state.mix);
  }
  toast('Reset');
}

function saveScene(){
  const name = prompt('Scene name?', `Scene ${state.scenes.length+1}`);
  if (!name) return;

  const scene = {
    id: uid(),
    name: String(name).slice(0, 60),
    createdAt: nowMs(),
    mix: mixSnapshot(),
  };

  state.scenes.push(scene);
  state.scenes = state.scenes.slice(-50);
  saveState(state);
  renderScenes();
  toast('Scene saved');
}

function loadScene(scene){
  state.mix = structuredClone(scene.mix);
  saveState(state);
  renderChannels();
  applyMixToUI(state.mix);
  if (engine.running){
    applyMixToAudio(state.mix);
  }
  toast(`Loaded: ${scene.name}`);
}

function linkForScene(scene){
  const payload = {
    kind: 'hushboard-shared',
    version: 1,
    mix: scene.mix,
  };
  return location.origin + location.pathname.replace(/index\.html$/,'') + encodeSceneToHash(payload);
}

function exportJSON(){
  const payload = {
    kind: 'hushboard-export',
    version: 1,
    exportedAt: nowMs(),
    scenes: state.scenes,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hushboard-scenes-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importJSON(file){
  const text = await file.text();
  const payload = safeParse(text, null);
  if (!payload || payload.kind !== 'hushboard-export' || !Array.isArray(payload.scenes)){
    alert('Not a valid Hushboard export JSON.');
    return;
  }
  const incoming = payload.scenes
    .filter(s => s && s.id && s.mix)
    .map(s => ({...s, id: String(s.id)}));

  const byId = new Map(state.scenes.map(s => [s.id, s]));
  for (const s of incoming) byId.set(s.id, s);

  state.scenes = [...byId.values()].sort((a,b)=>a.createdAt-b.createdAt).slice(-50);
  saveState(state);
  renderScenes();
  toast(`Imported ${incoming.length} scene(s)`);
}

function startTimer(minutes){
  const mins = clamp(+minutes || 25, 1, 240);
  const ms = mins * 60 * 1000;
  timer.running = true;
  timer.endAt = nowMs() + ms;

  tickTimer();
  if (timer.tick) clearInterval(timer.tick);
  timer.tick = setInterval(tickTimer, 250);

  $('#timerMeta').textContent = `Ends at ${new Date(timer.endAt).toLocaleTimeString()}`;
}

async function finishTimer(){
  stopTimer(false);

  const behavior = state.mix.timer.endBehavior;
  const fade = clamp(+state.mix.timer.fadeSeconds || 0, 0, 120);

  if (behavior === 'fade' && engine.running){
    await engine.fadeToSilent(fade);
    toast('Session ended (faded)');
  } else if (behavior === 'pause'){
    await engine.stop();
    setPowerUI(false);
    toast('Session ended (stopped)');
  } else {
    toast('Session ended');
  }
}

function stopTimer(showToast=true){
  timer.running = false;
  timer.endAt = 0;
  if (timer.tick) clearInterval(timer.tick);
  timer.tick = null;
  $('#timerReadout').textContent = '—:—';
  $('#timerMeta').textContent = 'No timer running';
  if (showToast) toast('Timer stopped');
}

function tickTimer(){
  if (!timer.running) return;
  const left = timer.endAt - nowMs();
  if (left <= 0){
    $('#timerReadout').textContent = '00:00';
    finishTimer();
    return;
  }
  $('#timerReadout').textContent = fmtTime(left);

  // UX: subtle “ritual” — shift accent near the end.
  const total = (clamp(+$('#timerMinutes').value || 25,1,240))*60*1000;
  const p = clamp(1 - (left/total), 0, 1);
  document.documentElement.style.setProperty('--grid', `rgba(124,194,255,${0.06 + p*0.10})`);
}

function setPowerUI(on){
  $('#powerLabel').textContent = on ? 'Stop audio' : 'Start audio';
}

async function togglePower(){
  if (!engine.running){
    await engine.start();
    setPowerUI(true);
    // bring nodes in sync
    applyMixToAudio(state.mix);
    toast('Audio on');
  } else {
    await engine.stop();
    setPowerUI(false);
    toast('Audio off');
  }
}

function wireEvents(){
  $('#btnPower').addEventListener('click', togglePower);
  $('#btnNew').addEventListener('click', resetMix);

  $('#master').addEventListener('input', (e) => {
    state.mix.master = +e.target.value;
    saveState(state);
    if (engine.running) engine.setMaster(state.mix.master);
  });

  $('#channels').addEventListener('input', (e) => {
    const el = e.target;
    const box = el.closest('[data-ch]');
    if (!box) return;
    const id = box.dataset.ch;
    const k = el.dataset.k;

    const ch = state.mix.channels[id];
    if (!ch) return;

    if (k === 'on'){
      ch.on = !!el.checked;
      saveState(state);
      if (engine.running){
        engine.nodes[id]._isOn = ch.on;
        engine.setChannelOn(id, ch.on);
      }
      return;
    }

    const v = +el.value;
    if (k === 'vol') ch.vol = v;
    if (k === 'tone') ch.tone = v;
    if (k === 'beat') ch.beat = v;
    if (k === 'rate') ch.rate = v;

    saveState(state);

    if (engine.running){
      if (k === 'vol') engine.setChannelVol(id, ch.vol);
      if (k === 'tone') engine.setChannelTone(id, ch.tone);
      if (k === 'beat') engine.setBinauralBeat(id, ch.beat);
      if (k === 'rate') engine.setChimeRate(id, ch.rate);
    }
  });

  $('#btnSave').addEventListener('click', saveScene);
  $('#btnShare').addEventListener('click', async () => {
    const link = linkForScene({mix: mixSnapshot()});
    await copyText(link);
  });

  $('#scenes').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    const scene = state.scenes.find(s => s.id === id);
    if (!scene) return;

    if (act === 'load') loadScene(scene);
    if (act === 'link') await copyText(linkForScene(scene));
    if (act === 'del'){
      if (!confirm(`Delete “${scene.name}”?`)) return;
      state.scenes = state.scenes.filter(s => s.id !== id);
      saveState(state);
      renderScenes();
      toast('Deleted');
    }
  });

  $('#btnExport').addEventListener('click', exportJSON);
  $('#fileImport').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    await importJSON(f);
    e.target.value = '';
  });

  $$('.timer-presets .btn').forEach(b => b.addEventListener('click', () => {
    const min = +b.dataset.min;
    $('#timerMinutes').value = String(min);
    state.mix.timer.minutes = min;
    saveState(state);
    startTimer(min);
  }));

  $('#btnStartTimer').addEventListener('click', () => {
    const min = +$('#timerMinutes').value;
    state.mix.timer.minutes = min;
    state.mix.timer.fadeSeconds = +$('#fadeSeconds').value;
    state.mix.timer.endBehavior = $('#endBehavior').value;
    saveState(state);
    startTimer(min);
  });

  $('#btnStopTimer').addEventListener('click', () => stopTimer(true));

  $('#timerMinutes').addEventListener('input', (e)=>{ state.mix.timer.minutes = clamp(+e.target.value,1,240); saveState(state); });
  $('#fadeSeconds').addEventListener('input', (e)=>{ state.mix.timer.fadeSeconds = clamp(+e.target.value,0,120); saveState(state); });
  $('#endBehavior').addEventListener('change', (e)=>{ state.mix.timer.endBehavior = e.target.value; saveState(state); });

  $('#btnHelp').addEventListener('click', () => {
    const hp = $('#helpPanel');
    const on = hp.hasAttribute('hidden') ? false : true;
    if (on){
      hp.setAttribute('hidden','');
      $('#btnHelp').setAttribute('aria-expanded','false');
    } else {
      hp.removeAttribute('hidden');
      $('#btnHelp').setAttribute('aria-expanded','true');
    }
  });

  window.addEventListener('hashchange', () => {
    const shared = decodeSceneFromHash();
    if (shared?.mix){
      state.mix = structuredClone(shared.mix);
      saveState(state);
      renderChannels();
      applyMixToUI(state.mix);
      if (engine.running) applyMixToAudio(state.mix);
      toast('Loaded shared scene');
    }
  });
}

function bootstrap(){
  renderChannels();
  renderScenes();
  applyMixToUI(state.mix);

  const shared = decodeSceneFromHash();
  if (shared?.mix){
    state.mix = structuredClone(shared.mix);
    saveState(state);
    renderChannels();
    applyMixToUI(state.mix);
    toast('Loaded shared scene');
  }

  setPowerUI(false);
  wireEvents();
}

bootstrap();
