// Built-in presets and user preset storage.
import { KEY_COUNT, hslToRgb, hexToRgb, rgbToHex } from './partykeys.js';

const STORAGE_KEY = 'openmidi.presets.v1';

const keys = Array.from({ length: KEY_COUNT }, (_, i) => i);
const BLACK_PCS = new Set([1, 3, 6, 8, 10]);

function gradient(...stops) {
  const rgbStops = stops.map(hexToRgb);
  return keys.map(i => {
    const t = (i / (KEY_COUNT - 1)) * (rgbStops.length - 1);
    const a = rgbStops[Math.floor(t)], b = rgbStops[Math.min(Math.ceil(t), rgbStops.length - 1)];
    const f = t - Math.floor(t);
    return rgbToHex(a.map((v, c) => v + (b[c] - v) * f));
  });
}

const solid = hex => keys.map(() => hex);

export const BUILT_IN_PRESETS = [
  { id: 'rainbow', name: 'Rainbow', mode: 'glow', colors: keys.map(i => rgbToHex(hslToRgb((i * 330) / KEY_COUNT, 1, 0.5))) },
  { id: 'notes', name: 'Note Colors', mode: 'glow', colors: keys.map(i => rgbToHex(hslToRgb(((i % 12) * 360) / 12, 1, 0.5))) },
  { id: 'ocean', name: 'Ocean', mode: 'glow', colors: gradient('#00e5ff', '#0072ff', '#6a00ff') },
  { id: 'sunset', name: 'Sunset', mode: 'glow', colors: gradient('#ff2e63', '#ff7a18', '#ffd200') },
  { id: 'aurora', name: 'Aurora', mode: 'glow', colors: gradient('#00f5a0', '#00d9f5', '#a742ff') },
  { id: 'ember', name: 'Ember', mode: 'press', colors: gradient('#ff0000', '#ff5a00', '#ffb300') },
  { id: 'ivory', name: 'Ivory & Ink', mode: 'glow', colors: keys.map(i => (BLACK_PCS.has(i % 12) ? '#7c3aed' : '#ffe8c2')) },
  { id: 'cyan', name: 'Solid Cyan', mode: 'press', colors: solid('#00e5ff') },
].map(p => ({ ...p, builtIn: true }));

export function loadUserPresets() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter(isValidPreset) : [];
  } catch {
    return [];
  }
}

export function saveUserPresets(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

// Server storage, available when OpenMidi runs on its Node server (e.g. Railway).
// Returns the stored list, or null when there is no server (e.g. GitHub Pages).
export async function fetchServerPresets() {
  try {
    const res = await fetch('api/presets', { cache: 'no-store' });
    if (!res.ok) return null;
    const { presets } = await res.json();
    return Array.isArray(presets) ? presets.filter(isValidPreset) : null;
  } catch {
    return null;
  }
}

export async function pushServerPresets(list) {
  try {
    const res = await fetch('api/presets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presets: list }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function isValidPreset(p) {
  return p && typeof p.name === 'string' && Array.isArray(p.colors) && p.colors.length === KEY_COUNT &&
    p.colors.every(c => /^#[0-9a-f]{6}$/i.test(c)) && (p.mode === 'glow' || p.mode === 'press');
}

export function makePreset(name, mode, colors) {
  return { id: `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name, mode, colors: [...colors] };
}

// CSS gradient with hard stops, one band per key, for preset thumbnails.
export function presetStrip(colors) {
  const step = 100 / colors.length;
  return `linear-gradient(90deg, ${colors.map((c, i) => `${c} ${(i * step).toFixed(2)}% ${((i + 1) * step).toFixed(2)}%`).join(', ')})`;
}
