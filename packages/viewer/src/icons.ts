// Inline paths keep toolbar symbols consistent across platform fonts.
const paths = {
  back: '<path d="m14 6-6 6 6 6M8 12h12"/>',
  forward: '<path d="m10 6 6 6-6 6M4 12h12"/>',
  reload: '<path d="M20 7v5h-5M19 12a7 7 0 1 0-2 5M20 12a8 8 0 0 0-2-6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  paste: '<path d="M8 5H5v16h14V5h-3"/><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M8 13h8m-3-3 3 3-3 3"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>',
  quality: '<path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  immersive: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18m-9 7v-4m-3 3 3-3 3 3"/>',
  restore: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18m-9 3v5m-3-3 3 3 3-3"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
} as const
export function viewerIcon(name: keyof typeof paths): string {
  return `<svg class="toolbar-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`
}
