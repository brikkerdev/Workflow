// Stable color per agent. Hand-picked palette for known agents,
// hash-derived hue for anything else.

const FIXED = {
  '2d-artist':       '#E8A87C', // warm amber
  'animator':        '#C38EE3', // lilac
  'architect':       '#7BB7FF', // steel blue
  'developer':       '#6EF0D2', // cyan-mint (project accent)
  'game-designer':   '#F0B86E', // gold
  'pencil-designer': '#F08CC2', // pink
  'sound-designer':  '#A0E0A0', // mint
  'ugui-designer':   '#9AB6FF', // periwinkle
  'user':            '#E6C68A', // sand
};

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
  if (FIXED[name]) return FIXED[name];
  return hslToHex(hashHue(name), 55, 70);
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
