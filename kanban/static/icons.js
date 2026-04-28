// Inline SVG icon strings — thin 1.5px stroke, 24x24 viewBox.
// Usage: Icons.search(12) -> '<svg ...></svg>'

const ICON_PATHS = {
  search:    '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  plus:      '<path d="M12 5v14M5 12h14"/>',
  chevron:   '<path d="M9 6l6 6-6 6"/>',
  chevronL:  '<path d="M15 6l-6 6 6 6"/>',
  link:      '<path d="M10 14a4 4 0 005.66 0l3-3a4 4 0 00-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 00-5.66 0l-3 3a4 4 0 005.66 5.66l1-1"/>',
  clock:     '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  bolt:      '<path d="M13 3L5 14h6l-1 7 8-11h-6l1-7z"/>',
  cpu:       '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="0.5"/><path d="M9 3v2M12 3v2M15 3v2M9 19v2M12 19v2M15 19v2M3 9h2M3 12h2M3 15h2M19 9h2M19 12h2M19 15h2"/>',
  brush:     '<path d="M14 4l6 6-9 9H5v-6l9-9z"/><path d="M11 7l6 6"/>',
  code:      '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 6l-4 12"/>',
  shield:    '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/>',
  doc:       '<path d="M7 3h7l4 4v14H7V3z"/><path d="M14 3v4h4"/><path d="M9 12h7M9 15h7M9 18h4"/>',
  user:      '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0114 0"/>',
  reload:    '<path d="M4 12a8 8 0 0114-5.3L20 8M20 4v4h-4"/><path d="M20 12a8 8 0 01-14 5.3L4 16M4 20v-4h4"/>',
  sparkle:   '<path d="M12 4l1.5 4.5L18 10l-4.5 1.5L12 16l-1.5-4.5L6 10l4.5-1.5z"/>',
  queue:     '<path d="M4 6h16M4 12h16M4 18h10"/>',
  layers:    '<path d="M12 4l9 5-9 5-9-5 9-5z"/><path d="M3 14l9 5 9-5"/>',
};

// Map agent role / name → icon key.
const AGENT_ICON = {
  '2d-artist':       'brush',
  'animator':        'sparkle',
  'architect':       'cpu',
  'developer':       'code',
  'game-designer':   'doc',
  'pencil-designer': 'brush',
  'sound-designer':  'sparkle',
  'ugui-designer':   'doc',
  'user':            'user',
};

function svg(pathHtml, size = 14, sw = 1.5) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${pathHtml}</svg>`;
}

const Icons = new Proxy({}, {
  get(_, key) {
    return (size, sw) => svg(ICON_PATHS[key] || '', size, sw);
  }
});

function agentIcon(name, size = 11, sw = 1.4) {
  const key = AGENT_ICON[name] || 'bolt';
  return svg(ICON_PATHS[key], size, sw);
}

window.Icons = Icons;
window.agentIcon = agentIcon;
