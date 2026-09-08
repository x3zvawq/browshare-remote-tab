export const VIEWER_STYLES = `
:host {
  --browshare-viewer-accent: #7c6cff;
  --browshare-viewer-accent-hover: #9387ff;
  --browshare-viewer-bg: #0b0c10;
  --browshare-viewer-panel: rgba(23, 24, 31, 0.92);
  --browshare-viewer-border: rgba(255, 255, 255, 0.1);
  --browshare-viewer-text: #f4f3f8;
  --browshare-viewer-muted: #aaa8b3;
  display: block;
  min-width: 280px;
  min-height: 320px;
  color: var(--browshare-viewer-text);
  background: var(--browshare-viewer-bg);
  border-radius: 16px;
  overflow: hidden;
  font: 500 14px/1.4 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color-scheme: dark;
}
:host([data-immersive="true"]) { min-height: 0; border-radius: 0; }
* { box-sizing: border-box; }
button, input, select, textarea { font: inherit; }
button { color: inherit; }
.shell { position: relative; display: grid; grid-template-rows: auto minmax(0, 1fr); width: 100%; height: 100%; min-height: inherit; background: radial-gradient(circle at 50% -20%, #28243f 0, #0b0c10 42%); }
.window-bar { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; min-width: 0; }
.window-bar[hidden] { display: none; }
.window-label { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.window-label > span { white-space: nowrap; color: var(--browshare-viewer-muted); }
.window-select { width: 100%; min-width: 0; max-width: 100%; height: 32px; color: inherit; background: var(--browshare-viewer-bg); border: 1px solid var(--browshare-viewer-border); border-radius: 7px; padding: 4px 8px; text-overflow: ellipsis; }
[data-window-status] { color: var(--browshare-viewer-muted); font-size: 12px; }
@media (max-width: 600px) { [data-window-status] { position: absolute; clip-path: inset(50%); width: 1px; height: 1px; overflow: hidden; } }
.toolbar { z-index: 4; display: grid; grid-template-columns: auto minmax(120px, 1fr) auto; align-items: center; gap: 10px; min-height: 58px; padding: 10px 12px; background: var(--browshare-viewer-panel); border-bottom: 1px solid var(--browshare-viewer-border); backdrop-filter: blur(18px); }
.group { display: flex; align-items: center; gap: 6px; }
.button { display: inline-grid; place-items: center; min-width: 44px; height: 44px; padding: 0 10px; border: 1px solid transparent; border-radius: 10px; background: transparent; cursor: pointer; transition: background .16s ease, border-color .16s ease, color .16s ease; }
.toolbar-icon { display: block; flex: none; width: 24px; height: 24px; }
.immersive-button, .immersive-exit { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.immersive-exit { position: absolute; top: max(12px, env(safe-area-inset-top)); right: max(12px, env(safe-area-inset-right)); z-index: 6; color: var(--browshare-viewer-text); background: var(--browshare-viewer-panel); border-color: var(--browshare-viewer-border); box-shadow: 0 3px 16px #0005; }
.shell[data-immersive="true"] { grid-template-rows: minmax(0, 1fr); }
.toolbar[hidden] { display: none; }
.shell[data-immersive="true"] .status[data-state="CONNECTED"] { display: none; }
.shell[data-immersive="true"] .notices { top: 68px; }
.button:hover:not(:disabled) { background: rgba(255,255,255,.08); border-color: var(--browshare-viewer-border); }
.button:disabled { opacity: .38; cursor: not-allowed; }
.button.primary { background: var(--browshare-viewer-accent); color: white; }
.button.primary:hover:not(:disabled) { background: var(--browshare-viewer-accent-hover); }
.button.danger { color: #ffb4bd; }
.quality-fields input:focus-visible, .button:focus-visible, .address:focus-visible, .quality-select:focus-visible, .surface:focus-visible, .clipboard-text:focus-visible { outline: 3px solid color-mix(in srgb, var(--browshare-viewer-accent) 58%, transparent); outline-offset: 2px; }
.address-form { display: flex; min-width: 0; }
.address { width: 100%; height: 44px; padding: 0 14px; color: var(--browshare-viewer-text); background: rgba(255,255,255,.065); border: 1px solid var(--browshare-viewer-border); border-radius: 11px; outline: none; }
.address::placeholder { color: var(--browshare-viewer-muted); }
.quality-control { display: inline-flex; }
.quality-control[hidden] { display: none; }
.keyboard-button { display: none; }
.shell[data-input-mode="touch"] .keyboard-button { display: inline-grid; }
.quality-select { height: 44px; max-width: 116px; padding: 0 28px 0 10px; color: var(--browshare-viewer-text); color-scheme: dark; background: rgba(255,255,255,.065); border: 1px solid var(--browshare-viewer-border); border-radius: 10px; cursor: pointer; }
.quality-select:disabled { opacity: .38; cursor: not-allowed; }
.stage { position: relative; min-height: 0; overflow: hidden; }
.surface { position: absolute; inset: 0; display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); place-items: center; overflow: hidden; outline: none; touch-action: none; }
video { width: 100%; height: 100%; object-fit: contain; background: #050506; user-select: none; }
.ime-proxy { position: absolute; left: 50%; top: 50%; width: 2px; height: 2px; padding: 0; opacity: .01; border: 0; resize: none; overflow: hidden; color: transparent; background: transparent; caret-color: transparent; }
.status { pointer-events: none; position: absolute; left: 14px; bottom: 14px; z-index: 3; display: flex; align-items: center; gap: 8px; max-width: min(520px, calc(100% - 28px)); padding: 9px 12px; color: var(--browshare-viewer-muted); background: rgba(14,15,20,.8); border: 1px solid var(--browshare-viewer-border); border-radius: 999px; backdrop-filter: blur(12px); }
.status-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: #8d8b95; }
.status[data-state="CONNECTED"] .status-dot { background: #5ee09a; box-shadow: 0 0 0 4px rgba(94,224,154,.12); }
.status[data-state="FAILED"] .status-dot { background: #ff6578; }
.mobile-guidance { position: absolute; top: max(14px, env(safe-area-inset-top)); left: 50%; z-index: 6; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 8px; width: min(620px, calc(100% - 28px)); padding: 10px 10px 10px 12px; color: #fff0c9; background: rgba(35,30,20,.94); border: 1px solid rgba(255,196,102,.28); border-radius: 11px; box-shadow: 0 14px 40px rgba(0,0,0,.32); transform: translateX(-50%); font-size: 12px; line-height: 1.45; }
.mobile-guidance[hidden] { display: none; }
.notices { position: absolute; top: 14px; right: 14px; z-index: 7; display: grid; gap: 8px; width: min(380px, calc(100% - 28px)); pointer-events: none; }
.notice { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 10px; padding: 12px 12px 12px 14px; color: var(--browshare-viewer-text); background: rgba(24,25,32,.96); border: 1px solid var(--browshare-viewer-border); border-left: 3px solid #77a8ff; border-radius: 8px; box-shadow: 0 14px 40px rgba(0,0,0,.35); pointer-events: auto; }
.notice[data-level="warning"] { border-left-color: #ffc466; }
.notice[data-level="error"] { border-left-color: #ff6578; }
.notice p { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.notice-close { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; color: var(--browshare-viewer-muted); background: transparent; border: 0; border-radius: 4px; cursor: pointer; font-size: 20px; line-height: 1; }
.notice-close:hover { color: var(--browshare-viewer-text); background: rgba(255,255,255,.08); }
.notice-close:focus-visible { outline: 3px solid color-mix(in srgb, var(--browshare-viewer-accent) 58%, transparent); outline-offset: 1px; }
.overlay { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; padding: 24px; background: rgba(7,8,11,.58); backdrop-filter: blur(6px); }
.overlay[hidden] { display: none; }
.overlay-card { max-width: 440px; padding: 22px; text-align: center; background: rgba(24,25,32,.94); border: 1px solid var(--browshare-viewer-border); border-radius: 18px; box-shadow: 0 18px 50px rgba(0,0,0,.35); }
.overlay-title { margin: 0 0 7px; font-size: 17px; }
.overlay-copy { margin: 0; color: var(--browshare-viewer-muted); }
.dialog-backdrop { position: absolute; inset: 0; z-index: 8; display: grid; place-items: center; padding: 20px; background: rgba(0,0,0,.64); }
.dialog-backdrop[hidden] { display: none; }
.dialog { width: min(460px, 100%); padding: 22px; background: #1a1b22; border: 1px solid var(--browshare-viewer-border); border-radius: 18px; box-shadow: 0 24px 80px rgba(0,0,0,.5); }
.dialog h2 { margin: 0 0 8px; font-size: 18px; }
.dialog p { margin: 0; color: var(--browshare-viewer-muted); overflow-wrap: anywhere; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.file-picker { display: grid; justify-items: center; gap: 14px; margin-top: 18px; padding: 22px; border: 1px dashed rgba(255,255,255,.22); border-radius: 8px; background: rgba(255,255,255,.035); }
.file-picker[hidden], .upload-progress[hidden], .dialog-error[hidden], .download-summary[hidden], .button[hidden], .clipboard-text[hidden], .clipboard-image-note[hidden] { display: none; }
.file-icon { display: grid; place-items: center; width: 42px; height: 42px; color: #c8ffdf; background: rgba(94,224,154,.12); border: 1px solid rgba(94,224,154,.28); border-radius: 50%; font-size: 22px; }
.upload-progress { display: grid; gap: 10px; margin-top: 20px; }
.upload-progress-row { display: flex; justify-content: space-between; gap: 16px; color: var(--browshare-viewer-muted); font-size: 13px; }
.upload-progress progress { width: 100%; height: 8px; overflow: hidden; border: 0; border-radius: 4px; background: rgba(255,255,255,.08); }
.upload-progress progress::-webkit-progress-bar { background: rgba(255,255,255,.08); }
.upload-progress progress::-webkit-progress-value { background: #5ee09a; }
.upload-progress progress::-moz-progress-bar { background: #5ee09a; }
.dialog-error { margin-top: 14px !important; color: #ffb4bd !important; }
.download-summary { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 14px; margin-top: 18px; padding: 16px; border: 1px solid var(--browshare-viewer-border); border-radius: 10px; background: rgba(255,255,255,.035); }
.download-icon { color: #c8d8ff; background: rgba(119,168,255,.12); border-color: rgba(119,168,255,.28); }
.download-file { display: grid; min-width: 0; gap: 3px; }
.download-file strong { overflow: hidden; color: var(--browshare-viewer-text); text-overflow: ellipsis; white-space: nowrap; }
.download-file span { color: var(--browshare-viewer-muted); font-size: 13px; }
.clipboard-text { width: 100%; min-height: 132px; margin-top: 18px; padding: 12px 14px; color: var(--browshare-viewer-text); background: rgba(255,255,255,.055); border: 1px solid var(--browshare-viewer-border); border-radius: 10px; resize: vertical; }
.clipboard-text[readonly] { user-select: text; }
.clipboard-image-note { margin-top: 14px !important; padding: 12px 14px; color: #ffd89a !important; background: rgba(255,196,102,.08); border: 1px solid rgba(255,196,102,.2); border-radius: 8px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
@media (min-width: 621px) and (max-width: 1100px) {
  .toolbar { grid-template-columns: auto minmax(0, 1fr); }
  .address-form { grid-column: 1 / -1; grid-row: 1; }
  .media-controls { justify-content: flex-end; flex-wrap: wrap; }
}
@media (max-width: 620px) {
  :host { min-width: 260px; }
  .toolbar { grid-template-columns: minmax(0, 1fr); gap: 8px; min-height: 0; padding: 8px max(8px, env(safe-area-inset-right)) 8px max(8px, env(safe-area-inset-left)); }
  .address-form { grid-column: 1; grid-row: 1; }
  .group:first-child { grid-column: 1; grid-row: 2; }
  .media-controls { grid-column: 1; grid-row: 3; width: 100%; padding-bottom: 2px; overflow-x: auto; overscroll-behavior-inline: contain; scrollbar-width: none; }
  .media-controls::-webkit-scrollbar { display: none; }
  .media-controls > *, .group:first-child > * { flex: none; }
  .dialog-backdrop { align-items: end; padding: 12px max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left)); }
  .dialog { max-height: min(82dvh, 640px); padding: 18px; overflow-y: auto; }
  .dialog-actions { position: sticky; bottom: 0; padding-top: 12px; background: #1a1b22; }
  .notices { top: max(10px, env(safe-area-inset-top)); right: max(10px, env(safe-area-inset-right)); width: min(380px, calc(100% - 20px - env(safe-area-inset-left) - env(safe-area-inset-right))); }
  .status { left: max(10px, env(safe-area-inset-left)); bottom: max(10px, env(safe-area-inset-bottom)); max-width: calc(100% - 20px - env(safe-area-inset-left) - env(safe-area-inset-right)); }
}
@media (pointer: coarse) {
  .button { min-width: 44px; height: 44px; padding-inline: 12px; }
  .quality-select { height: 44px; }
  .keyboard-button { display: inline-grid; }
  .notice-close { width: 36px; height: 36px; }
  .surface { -webkit-tap-highlight-color: transparent; }
}
@media (prefers-reduced-motion: reduce) { .button { transition: none; } }

.notice-dialog { position: fixed; inset: 0; margin: auto; width: min(440px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto; box-sizing: border-box; padding: 24px; border: 1px solid var(--browshare-viewer-border); border-radius: 16px; color: var(--browshare-viewer-text); background: var(--browshare-viewer-bg); box-shadow: 0 24px 80px #0008; }
.notice-dialog[open] { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
.notice-dialog::backdrop { background: #060A12bb; }
.notice-dialog h2 { margin: 0 0 12px; font-size: 1rem; overflow-wrap: anywhere; }
.notice-dialog p { overflow: auto; min-height: 0; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
.notice-dialog .dialog-actions { flex-wrap: wrap; }
.notice-dialog .button { height: auto; padding-block: 8px; min-height: 44px; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
.notice-dialog[data-kind="error"] { border-color: #E88080; }
.notice-dialog[data-kind="warning"] { border-color: #F2C97D; }
.notice-dialog[data-kind="success"] { border-color: #36AD6A; }
.quality-dialog[open] { display: block; }
.quality-dialog form { display: grid; gap: 16px; min-width: 0; }
.quality-dialog h2 { margin-bottom: 0; }
.quality-dialog .quality-applied { padding: 10px 12px; border: 1px solid var(--browshare-viewer-border); border-radius: 8px; color: var(--browshare-viewer-muted); font-size: 13px; }
.quality-fields { display: grid; gap: 14px; }
.quality-fields label { display: grid; gap: 6px; min-width: 0; }
.quality-fields input { width: 100%; min-width: 0; height: 44px; padding: 8px 12px; color: var(--browshare-viewer-text); background: rgba(255,255,255,.065); border: 1px solid var(--browshare-viewer-border); border-radius: 8px; }
.quality-fields input[aria-invalid="true"] { border-color: #ffb4bd; }
.quality-fields input:disabled { opacity: .5; }
.quality-dialog .dialog-actions { margin-top: 0; background: var(--browshare-viewer-bg); }
.quality-dialog .button.primary { color: #0b0c10; }
`
