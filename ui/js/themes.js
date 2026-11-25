// The looks the app can take. The colours themselves are in app.css under :root[data-theme="<id>"];
// the three here (ground, panel, accent) only draw the small previews in Settings.
// server/config.js has the same ids: a look added here must be added there too.
export const THEMES = [
  { id: 'system', name: 'Follow Windows', note: 'Light or dark, as Windows is set' },
  { id: 'light', name: 'Light', swatch: ['#f4f6f8', '#ffffff', '#12876b'] },
  { id: 'dark', name: 'Dark', swatch: ['#000000', '#0e0e10', '#45d6b0'] },
  { id: 'ember', name: 'Ember', swatch: ['#000000', '#0e0e10', '#ff8a3d'] },
  { id: 'midnight', name: 'Midnight', swatch: ['#000000', '#0e0e10', '#6ea8ff'] },
  { id: 'orchid', name: 'Orchid', swatch: ['#000000', '#0e0e10', '#c79bff'] },
  { id: 'sand', name: 'Sand', swatch: ['#f5f1e8', '#fffdf8', '#b4530d'] },
  { id: 'sky', name: 'Sky', swatch: ['#f0f4fb', '#ffffff', '#2460d8'] },
];

export const isTheme = (id) => THEMES.some((t) => t.id === id);

/** Put a look on the page. 'system' (or anything unknown) leaves the choice to Windows. */
export function setTheme(id) {
  if (!id || id === 'system' || !isTheme(id)) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', id);
}
