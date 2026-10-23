import {
  KEY_COUNT, BASE_NOTE, PALETTE, createLighting, defaultProtocol, deviceKind,
  hexToRgb, normalizeHex, nearestSlot, rgbToHex,
} from './partykeys.js';
import {
  BUILT_IN_PRESETS, isValidPreset, loadUserPresets, makePreset, presetStrip, saveUserPresets,
} from './presets.js';

const STATE_KEY = 'openmidi.state.v1';
const PRESS_COLOR = '#ffffff';
const OFF = [0, 0, 0];
const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
const SWATCHES = ['#ff2e63', '#ff7a18', '#ffd200', '#22d39a', '#00e5ff', '#0072ff', '#6c5cff', '#c13cff', '#ff4fd8', '#ffffff'];

const $ = id => document.getElementById(id);

// ---------- state ----------

const state = {
  colors: [...BUILT_IN_PRESETS[0].colors],
  mode: 'glow', // 'glow' = all lit, white on press; 'press' = lit only on press
  brightness: 100,
  brush: '#6c5cff',
  activePreset: BUILT_IN_PRESETS[0].id,
  ...loadState(),
};

let userPresets = loadUserPresets();
let paint = false;
let octave = 0;
const midiPressed = new Map(); // key index -> count of sources holding it
const pointerPressed = new Set();

let access = null;
let lighting = null;
let outputId = null;
let lightsEnabled = true;

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null');
    if (!saved) return {};
    const out = {};
    if (Array.isArray(saved.colors) && saved.colors.length === KEY_COUNT && saved.colors.every(c => normalizeHex(c))) out.colors = saved.colors;
    if (saved.mode === 'glow' || saved.mode === 'press') out.mode = saved.mode;
    if (Number.isFinite(saved.brightness)) out.brightness = Math.min(100, Math.max(5, saved.brightness));
    if (normalizeHex(saved.brush)) out.brush = normalizeHex(saved.brush);
    out.activePreset = typeof saved.activePreset === 'string' ? saved.activePreset : null;
    return out;
  } catch {
    return {};
  }
}

function persist() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

// ---------- lighting ----------

const isPressed = i => midiPressed.has(i) || pointerPressed.has(i);

function ledColor(i) {
  const base = hexToRgb(state.colors[i]);
  if (state.mode === 'glow') return isPressed(i) ? hexToRgb(PRESS_COLOR) : base;
  return isPressed(i) ? base : OFF;
}

// What the physical LED will actually show (relay mode snaps to the palette).
function displayColor(rgb) {
  if ($('protocol').value !== 'palette71') return rgb;
  const slot = nearestSlot(rgb);
  return slot ? PALETTE.get(slot) : OFF;
}

function update() {
  renderKeys();
  if (!lighting) return;
  if (!lightsEnabled) return lighting.off();
  const scale = state.brightness / 100;
  lighting.setColors(Array.from({ length: KEY_COUNT }, (_, i) => ledColor(i).map(v => v * scale)));
}

// ---------- keyboard rendering ----------

const keyEls = [];

function buildKeyboard() {
  const kb = $('keyboard');
  const whiteCount = Array.from({ length: KEY_COUNT }, (_, i) => i).filter(i => !BLACK_PCS.has(i % 12)).length;
  const ww = 100 / whiteCount, bw = ww * 0.62;
  let white = 0;
  for (let i = 0; i < KEY_COUNT; i++) {
    const black = BLACK_PCS.has(i % 12);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `key ${black ? 'black' : 'white'}`;
    el.dataset.key = i;
    el.setAttribute('aria-label', noteName(BASE_NOTE + i));
    el.style.left = black ? `${white * ww - bw / 2}%` : `${white * ww}%`;
    el.style.width = `${black ? bw : ww}%`;
    el.innerHTML = `<span class="dot"></span>${i % 12 === 0 ? `<span class="label">${noteName(BASE_NOTE + i)}</span>` : ''}`;
    if (!black) white++;
    kb.appendChild(el);
    keyEls.push(el);
  }

  let painting = false;
  const keyAt = e => e.target.closest?.('.key');

  kb.addEventListener('contextmenu', e => {
    const el = keyAt(e);
    if (!el) return;
    e.preventDefault();
    setBrush(state.colors[el.dataset.key]);
    toast(`Picked ${state.colors[el.dataset.key].toUpperCase()}`);
  });

  kb.addEventListener('pointerdown', e => {
    const el = keyAt(e);
    if (!el || e.button !== 0) return;
    kb.setPointerCapture(e.pointerId);
    if (paint) {
      painting = true;
      paintKey(+el.dataset.key);
    } else {
      pointerPressed.clear();
      pointerPressed.add(+el.dataset.key);
      update();
    }
  });

  kb.addEventListener('pointermove', e => {
    if (!(e.buttons & 1)) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.key');
    if (!el || !kb.contains(el)) return;
    const i = +el.dataset.key;
    if (painting) paintKey(i);
    else if (pointerPressed.size && !pointerPressed.has(i)) {
      pointerPressed.clear();
      pointerPressed.add(i);
      update();
    }
  });

  const release = () => {
    painting = false;
    if (pointerPressed.size) { pointerPressed.clear(); update(); }
  };
  kb.addEventListener('pointerup', release);
  kb.addEventListener('pointercancel', release);
}

function renderKeys() {
  keyEls.forEach((el, i) => {
    const led = displayColor(ledColor(i));
    const lit = led.some(v => v > 0);
    el.style.backgroundColor = lit ? rgbToHex(led) : '';
    el.classList.toggle('lit', lit);
    el.classList.toggle('pressed', isPressed(i));
    el.querySelector('.dot').style.backgroundColor = rgbToHex(displayColor(hexToRgb(state.colors[i])));
  });
}

function noteName(note) {
  return ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][note % 12] + (Math.floor(note / 12) - 1);
}

function paintKey(i) {
  if (state.colors[i] === state.brush) return;
  state.colors[i] = state.brush;
  markEdited();
}

function markEdited() {
  state.activePreset = null;
  renderPresets();
  update();
  persist();
}

// ---------- color controls ----------

function setBrush(hex) {
  state.brush = hex;
  $('picker').value = hex;
  $('picker-swatch').style.background = hex;
  $('hex').value = hex.slice(1).toUpperCase();
  $('hex').parentElement.classList.remove('invalid');
  document.querySelectorAll('#swatches button').forEach(b => b.classList.toggle('active', b.dataset.color === hex));
  persist();
}

function initColorControls() {
  const sw = $('swatches');
  for (const c of SWATCHES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.color = c;
    b.style.background = c;
    b.title = c.toUpperCase();
    b.addEventListener('click', () => setBrush(c));
    sw.appendChild(b);
  }

  $('picker').addEventListener('input', e => setBrush(e.target.value));

  const hexInput = $('hex');
  hexInput.addEventListener('input', () => {
    const hex = normalizeHex(hexInput.value);
    hexInput.parentElement.classList.toggle('invalid', !hex && hexInput.value.length > 0);
    // Only accept full 6-digit input while typing, so "ff" doesn't jump to a 3-digit match.
    if (hex && hexInput.value.replace('#', '').length === 6) {
      state.brush = hex;
      $('picker').value = hex;
      $('picker-swatch').style.background = hex;
      document.querySelectorAll('#swatches button').forEach(b => b.classList.toggle('active', b.dataset.color === hex));
      persist();
    }
  });
  const commitHex = () => {
    const hex = normalizeHex(hexInput.value);
    if (hex) setBrush(hex);
    else setBrush(state.brush);
  };
  hexInput.addEventListener('change', commitHex);
  hexInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { commitHex(); fillAll(); }
  });

  $('paint').addEventListener('change', e => {
    paint = e.target.checked;
    $('keyboard').classList.toggle('painting', paint);
    $('kb-hint').innerHTML = paint
      ? '<b>Painting</b> — click or drag across keys to apply the selected color.'
      : 'Click a key to preview it. Turn on <b>Paint keys</b> to color keys one by one.';
  });

  $('fill').addEventListener('click', fillAll);
  setBrush(state.brush);
}

function fillAll() {
  state.colors = state.colors.map(() => state.brush);
  markEdited();
  toast(`Keyboard set to ${state.brush.toUpperCase()}`);
}

// ---------- mode & brightness ----------

function initModeControls() {
  document.querySelectorAll('.seg').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });
  const slider = $('brightness');
  slider.value = state.brightness;
  $('brightness-value').textContent = `${state.brightness}%`;
  slider.addEventListener('input', () => {
    state.brightness = +slider.value;
    $('brightness-value').textContent = `${state.brightness}%`;
    update();
    persist();
  });

  $('lights-off').addEventListener('click', () => {
    lightsEnabled = !lightsEnabled;
    $('lights-off').textContent = lightsEnabled ? 'Lights off' : 'Lights on';
    update();
  });
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.seg').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  update();
  persist();
}

// ---------- presets ----------

function presetCard(preset) {
  const card = document.createElement('div');
  card.className = 'preset' + (state.activePreset === preset.id ? ' active' : '');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.innerHTML = `
    <div class="strip" style="background:${presetStrip(preset.colors)}"></div>
    <div class="meta"><span class="name"></span><span class="tag">${preset.mode === 'glow' ? 'Always on' : 'On press'}</span></div>`;
  card.querySelector('.name').textContent = preset.name;
  card.title = `Load “${preset.name}”`;
  const load = () => loadPreset(preset);
  card.addEventListener('click', load);
  card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); load(); } });

  if (!preset.builtIn) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'delete';
    del.textContent = '×';
    del.setAttribute('aria-label', `Delete ${preset.name}`);
    del.addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm(`Delete preset “${preset.name}”?`)) return;
      userPresets = userPresets.filter(p => p.id !== preset.id);
      saveUserPresets(userPresets);
      renderPresets();
    });
    card.appendChild(del);
  }
  return card;
}

function renderPresets() {
  const user = $('user-presets'), builtIn = $('builtin-presets');
  user.replaceChildren(...userPresets.map(presetCard));
  builtIn.replaceChildren(...BUILT_IN_PRESETS.map(presetCard));
  $('no-presets').hidden = userPresets.length > 0;
}

function loadPreset(preset) {
  state.colors = [...preset.colors];
  state.activePreset = preset.id;
  setMode(preset.mode);
  renderPresets();
  persist();
  toast(`Loaded “${preset.name}”`);
}

function initPresets() {
  $('save-form').addEventListener('submit', e => {
    e.preventDefault();
    const nameInput = $('preset-name');
    const name = nameInput.value.trim() || `Preset ${userPresets.length + 1}`;
    const existing = userPresets.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing && !confirm(`Replace your preset “${existing.name}”?`)) return;
    const preset = existing ? { ...existing, mode: state.mode, colors: [...state.colors] } : makePreset(name, state.mode, state.colors);
    userPresets = existing ? userPresets.map(p => (p.id === existing.id ? preset : p)) : [...userPresets, preset];
    if (!saveUserPresets(userPresets)) toast('Could not save — browser storage is unavailable. Use Export to keep it.');
    else toast(`Saved “${name}”`);
    state.activePreset = preset.id;
    nameInput.value = '';
    renderPresets();
    persist();
  });

  $('export').addEventListener('click', () => {
    const list = userPresets.length ? userPresets : [makePreset('Current', state.mode, state.colors)];
    const data = JSON.stringify({ app: 'OpenMidi', version: 1, presets: list.map(({ name, mode, colors }) => ({ name, mode, colors })) }, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = 'openmidi-presets.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      const list = (Array.isArray(json) ? json : json.presets ?? [json])
        .map(p => ({ ...p, colors: p?.colors?.map?.(normalizeHex) }))
        .filter(isValidPreset)
        .map(p => makePreset(p.name.slice(0, 40), p.mode, p.colors));
      if (!list.length) throw new Error('no presets');
      userPresets = [...userPresets, ...list];
      saveUserPresets(userPresets);
      renderPresets();
      toast(`Imported ${list.length} preset${list.length > 1 ? 's' : ''}`);
    } catch {
      toast('That file doesn’t contain any OpenMidi presets.');
    }
  });

  renderPresets();
}

// ---------- MIDI ----------

function setStatus(state, text) {
  const el = $('status');
  el.dataset.state = state;
  el.querySelector('b').textContent = text;
}

const ports = map => [...(map?.values?.() ?? [])].filter(p => p.state !== 'disconnected');

async function connect() {
  if (access) return disconnect();
  if (!navigator.requestMIDIAccess) {
    setStatus('error', 'Web MIDI not supported');
    toast('Use Chrome or Edge on desktop or Android — this browser has no Web MIDI.');
    return;
  }
  setStatus('init', 'Requesting access…');
  try {
    access = await navigator.requestMIDIAccess({ sysex: true });
  } catch {
    access = null;
    setStatus('error', 'MIDI access denied');
    toast('OpenMidi needs MIDI + SysEx permission to control the lights.');
    return;
  }
  if (access.sysexEnabled === false) toast('SysEx is disabled, so lighting commands may be ignored.');
  access.onstatechange = () => { refreshDevices(); attachInputs(); };
  $('connect').textContent = 'Disconnect';
  attachInputs();
  refreshDevices();
}

function disconnect() {
  lighting?.dispose();
  lighting = null;
  for (const input of ports(access?.inputs)) input.onmidimessage = null;
  if (access) access.onstatechange = null;
  access = null;
  outputId = null;
  midiPressed.clear();
  $('connect').textContent = 'Connect';
  const sel = $('device');
  sel.replaceChildren(new Option('No devices'));
  sel.disabled = true;
  setStatus('idle', 'Not connected');
  update();
}

function refreshDevices() {
  const sel = $('device');
  const outputs = ports(access?.outputs);
  const supported = outputs.filter(deviceKind);
  sel.replaceChildren(...(outputs.length ? outputs : [null]).map(p =>
    p ? new Option(p.name + (deviceKind(p) ? '' : ' (unknown)'), p.id) : new Option('No devices')));
  sel.disabled = !outputs.length;

  const current = outputs.find(p => p.id === outputId);
  if (current) {
    sel.value = current.id;
    if (!lighting) startLighting(current);
    return;
  }
  // Selected device went away (or nothing chosen yet).
  lighting?.dispose();
  lighting = null;
  const pick = supported[0];
  if (pick) {
    sel.value = pick.id;
    selectOutput(pick, true);
  } else if (outputs.length) {
    outputId = null;
    sel.value = '';
    setStatus('waiting', 'No PartyKeys found');
  } else {
    setStatus('waiting', 'Plug in your PartyKeys');
  }
}

function selectOutput(port, autoProtocol) {
  lighting?.dispose();
  lighting = null;
  outputId = port.id;
  if (autoProtocol) $('protocol').value = defaultProtocol(port);
  updateRelayNote();
  startLighting(port);
}

function startLighting(port) {
  const protocol = $('protocol').value;
  lighting = createLighting(port, protocol, (s, detail) => {
    if (s === 'init') setStatus('init', 'Starting lights…');
    else if (s === 'ready' || s === 'sent') setStatus('ready', port.name);
    else if (s === 'error') { setStatus('error', 'Lighting error'); console.warn('[OpenMidi]', detail); }
  });
  update();
}

function attachInputs() {
  for (const input of ports(access?.inputs)) input.onmidimessage = e => handleMidi(e.data);
}

function handleMidi(data) {
  const [status, a, b] = data;
  const type = status & 0xf0;
  if (status === 0xf0) return handleSysex(data);
  if (type === 0x90 || type === 0x80) {
    const i = a - BASE_NOTE - octave * 12;
    if (i < 0 || i >= KEY_COUNT) return;
    const on = type === 0x90 && b > 0;
    if (on) midiPressed.set(i, (midiPressed.get(i) ?? 0) + 1);
    else {
      const n = (midiPressed.get(i) ?? 1) - 1;
      if (n > 0) midiPressed.set(i, n); else midiPressed.delete(i);
    }
    update();
  } else if (type === 0xb0 && (a === 123 || a === 120)) {
    midiPressed.clear();
    update();
  }
}

// CMD 18: keyboard reports its octave shift, so we can map notes back to keys.
function handleSysex(d) {
  if (d.length >= 10 && d[1] === 0x05 && d[2] === 0x30 && d[7] === 0x18 && d[5] > 0) {
    const value = d[8] > 0x40 ? d[8] - 0x80 : d[8];
    if (value >= -3 && value <= 3) setOctave(value);
  }
}

function setOctave(v) {
  octave = Math.max(-3, Math.min(3, v));
  $('oct-value').textContent = octave > 0 ? `+${octave}` : String(octave);
  midiPressed.clear();
  update();
}

function updateRelayNote() {
  $('relay-note').hidden = $('protocol').value !== 'palette71';
  renderKeys();
}

function initMidiControls() {
  $('connect').addEventListener('click', connect);
  $('device').addEventListener('change', e => {
    const port = ports(access?.outputs).find(p => p.id === e.target.value);
    if (port) selectOutput(port, true);
  });
  $('protocol').addEventListener('change', () => {
    updateRelayNote();
    const port = ports(access?.outputs).find(p => p.id === outputId);
    if (port) selectOutput(port, false);
  });
  $('oct-down').addEventListener('click', () => setOctave(octave - 1));
  $('oct-up').addEventListener('click', () => setOctave(octave + 1));
  window.addEventListener('pagehide', () => lighting?.dispose());
}

// ---------- toast ----------

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ---------- boot ----------

buildKeyboard();
initColorControls();
initModeControls();
initPresets();
initMidiControls();
setMode(state.mode);
updateRelayNote();
