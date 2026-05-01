// Stable color per agent. Hand-picked palette for known agents,
// hash-derived hue for anything else.

// User stripe follows the theme: white on dark, black on light. Resolved at
// call time via the special token 'theme-fg'.
const FIXED = {
  'architect':       '#3B9EFF', // electric blue
  'developer':       '#22E0B8', // bright teal
  'game-designer':   '#FFB020', // saturated gold
  'pencil-designer': '#FF4F9E', // hot pink
  'sound-designer':  '#3DDC84', // bright green
  'user':            'theme-fg',
};

function themeFg() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--fg-0').trim();
    if (v) return v;
  } catch {}
  return '#FAFAFA';
}

function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  const toHex = v => v.toString(16).padStart(2, '0');
  return '#' + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
}

function agentColor(name) {
  if (!name || name === '—') return '#5C6477';
  const fixed = FIXED[name];
  if (fixed === 'theme-fg') return themeFg();
  if (fixed) return fixed;
  return hslToHex(hashHue(name), 80, 65);
}

// soft variant for fills / chip backgrounds
function agentColorSoft(name, alpha = 0.12) {
  const c = agentColor(name);
  // hex -> rgba
  const r = parseInt(c.slice(1,3), 16);
  const g = parseInt(c.slice(3,5), 16);
  const b = parseInt(c.slice(5,7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

window.agentColor = agentColor;
window.agentColorSoft = agentColorSoft;
