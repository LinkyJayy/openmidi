// PartyKeys lighting driver.
// Implements the two lighting profiles from https://protocol.partykeys.org/#verified-lighting
//   rgb15     - direct USB PartyKeys 36: CMD 0x15, full 24-bit RGB per key.
//               Sent immediately, with no pacing or settle wait.
//   palette71 - PartyStudio / SAM5704 speaker relay: CMD 0x71 palette slots,
//               max 3 note/slot pairs per 16-byte frame, paced >= 8 ms.
// Lighting never uses Note On, so it cannot echo back as fake key presses.

export const KEY_COUNT = 36;
export const BASE_NOTE = 48; // C3, leftmost key

const HEADER = [0xf0, 0x05, 0x30, 0x7f, 0x7f, 0x20, 0x00];
// The frame gap and post-init settle are relay requirements only.
const TIMING = {
  rgb15: { gap: 0, settle: 0 },
  palette71: { gap: 8, settle: 120 },
};
const MAX_FRAME = 256;
const MAX_PALETTE_PAIRS = 3;

const allKeys = Array.from({ length: KEY_COUNT }, (_, i) => i);

export function deviceKind(port) {
  const name = `${port?.name ?? ''} ${port?.manufacturer ?? ''}`.replace(/[\s_-]/g, '');
  if (/partystudio|sam5704/i.test(name)) return 'partystudio';
  if (/partykey/i.test(name)) return 'partykeys';
  return null;
}

export function defaultProtocol(port) {
  return deviceKind(port) === 'partystudio' ? 'palette71' : 'rgb15';
}

// Approximate colors of the firmware UI palette (slots 1-12 run red -> purple,
// 26 is white). The exact hues are defined by firmware, so these are a best match.
export const PALETTE = (() => {
  const slots = new Map();
  for (let i = 0; i < 12; i++) slots.set(i + 1, hslToRgb((i * 300) / 11, 1, 0.5));
  slots.set(26, [255, 255, 255]);
  return slots;
})();

export function nearestSlot([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max < 24) return 0;
  if (max - min < 40 && max > 150) return 26; // near-white
  const [h] = rgbToHsl(r, g, b);
  let best = 1, bestDist = Infinity;
  for (let slot = 1; slot <= 12; slot++) {
    const slotHue = ((slot - 1) * 300) / 11;
    const d = Math.min(Math.abs(h - slotHue), 360 - Math.abs(h - slotHue));
    if (d < bestDist) { bestDist = d; best = slot; }
  }
  return best;
}

const enc = v => [v >> 7, v & 0x7f];

function checked(frame) {
  if (frame.length > MAX_FRAME || frame[0] !== 0xf0 || frame.at(-1) !== 0xf7 ||
      frame.slice(1, -1).some(v => !Number.isInteger(v) || v < 0 || v > 127)) {
    throw new Error('Invalid lighting frame');
  }
  return frame;
}

function initFrames(protocol) {
  // palette71 mode uses the 7F device-type byte; color frames keep 05.
  if (protocol === 'palette71') return [[0xf0, 0x7f, 0x30, 0x7f, 0x7f, 0x20, 0x00, 0x0f, 0x05, 0xf7]];
  return [[...HEADER, 0x0f, 0x01, 0xf7]];
}

function offFrame(protocol) {
  if (protocol === 'rgb15') return [...HEADER, 0x15, 1, 0, 0, 0, 0, 0, 0, KEY_COUNT, ...allKeys, 0xf7];
  return [...HEADER, 0x71, 0x00, 0xf7];
}

// Builds one frame from the keys whose desired value differs from what was sent.
// Returns { frame, keys } or null when nothing is pending.
function nextFrame(protocol, desired, sent) {
  const dirty = allKeys.filter(i => desired[i] !== sent[i]);
  if (!dirty.length) return null;

  if (protocol === 'palette71') {
    const keys = dirty.slice(0, MAX_PALETTE_PAIRS);
    const pairs = keys.flatMap(i => [BASE_NOTE + i, desired[i]]);
    return { keys, frame: [...HEADER, 0x71, keys.length, ...pairs, 0xf7] };
  }

  // rgb15: group keys sharing a color, packing as many as fit in one frame.
  const groups = new Map();
  const keys = [];
  let length = HEADER.length + 3; // cmd, numGroups, F7
  for (const i of dirty) {
    const cost = groups.has(desired[i]) ? 1 : 8;
    if (length + cost > MAX_FRAME) break;
    length += cost;
    if (!groups.has(desired[i])) groups.set(desired[i], []);
    groups.get(desired[i]).push(i);
    keys.push(i);
  }
  const body = [];
  for (const [color, groupKeys] of groups) {
    const [r, g, b] = color.split(',').map(Number);
    body.push(...enc(r), ...enc(g), ...enc(b), groupKeys.length, ...groupKeys);
  }
  return { keys, frame: [...HEADER, 0x15, groups.size, ...body, 0xf7] };
}

// output: a Web MIDI MIDIOutput. onStatus(state, detail) with state in
// 'init' | 'ready' | 'sent' | 'error'. "sent" means written to the MIDI API,
// not a physical LED acknowledgment.
export function createLighting(output, protocol, onStatus = () => {}) {
  const OFF = protocol === 'rgb15' ? '0,0,0' : 0;
  const { gap, settle } = TIMING[protocol];
  let alive = true, ready = false, failed = false, timer;
  let desired = Array(KEY_COUNT).fill(OFF);
  let sent = Array(KEY_COUNT).fill(null); // unknown until the first clear

  // Runs fn after ms, or right away when no wait is needed.
  const later = (fn, ms) => {
    if (!ms) return fn();
    timer = setTimeout(() => { timer = undefined; if (alive) fn(); }, ms);
  };

  function send(frame) {
    try {
      output.send(checked(frame));
      return true;
    } catch (error) {
      failed = true;
      onStatus('error', error?.message ?? 'MIDI send failed');
      return false;
    }
  }

  function flush() {
    if (!alive || !ready || failed || timer !== undefined) return;
    let next;
    // Without a gap, every pending frame goes out now; otherwise one per gap.
    while ((next = nextFrame(protocol, desired, sent))) {
      if (!send(next.frame)) return;
      for (const i of next.keys) sent[i] = desired[i];
      if (gap) {
        // Recompute from what was actually written, so fast changes supersede stale ones.
        later(flush, gap);
        break;
      }
    }
    if (allKeys.every(i => desired[i] === sent[i])) onStatus('sent');
  }

  function initialize() {
    if (!alive) return;
    onStatus('init');
    for (const frame of initFrames(protocol)) if (!send(frame)) return;
    later(() => {
      if (!send(offFrame(protocol))) return;
      sent = Array(KEY_COUNT).fill(OFF);
      later(() => {
        ready = true;
        onStatus('ready');
        flush();
      }, settle);
    }, gap);
  }

  try {
    Promise.resolve(output.open?.()).then(initialize).catch(e => alive && onStatus('error', String(e)));
  } catch (error) {
    onStatus('error', String(error));
  }

  return {
    protocol,
    // colors: array of KEY_COUNT [r, g, b] tuples (0-255); [0,0,0] is off.
    setColors(colors) {
      desired = colors.map(rgb => {
        const c = rgb.map(v => Math.max(0, Math.min(255, Math.round(v))));
        return protocol === 'rgb15' ? c.join(',') : nearestSlot(c);
      });
      flush();
    },
    off() {
      desired = Array(KEY_COUNT).fill(OFF);
      flush();
    },
    dispose() {
      if (!alive) return;
      if (timer !== undefined) clearTimeout(timer);
      if (ready && !failed) send(offFrame(protocol));
      alive = false;
    },
  };
}

// --- color helpers -------------------------------------------------------

export function hslToRgb(h, s, l) {
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map(v => Math.round(v * 255));
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

// Accepts "#rgb", "rgb", "#rrggbb" or "rrggbb". Returns "#rrggbb" or null.
export function normalizeHex(input) {
  let s = String(input).trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split('').map(c => c + c).join('');
  return /^[0-9a-f]{6}$/.test(s) ? '#' + s : null;
}
