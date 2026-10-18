const STORAGE_KEY = 'prism-layout-v1';
const DEFAULT_COLUMNS = [1.15, 1, 1.15, .75];
const COLUMN_MINIMUMS = [280, 265, 305, 205];
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function readLayout(storage) {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
    return {
      workspaceHeight: Number.isFinite(value?.workspaceHeight) && value.workspaceHeight > 0 && value.workspaceHeight < 5000
        ? value.workspaceHeight : null,
      monitorRatio: Number.isFinite(value?.monitorRatio) && value.monitorRatio > 0 && value.monitorRatio < 1
        ? value.monitorRatio : .5,
      columns: Array.isArray(value?.columns) && value.columns.length === 4 &&
        value.columns.every(width => Number.isFinite(width) && width > 0 && width < 10000)
        ? value.columns : [...DEFAULT_COLUMNS],
    };
  } catch { return { workspaceHeight: null, monitorRatio: .5, columns: [...DEFAULT_COLUMNS] }; }
}

export function installResizableLayout(app, storage = localStorage) {
  const state = readLayout(storage);
  const workspace = app.querySelector('.workspace');
  const monitor = app.querySelector('.monitor-panel');
  const output = app.querySelector('#output-canvas').parentElement;
  const preview = app.querySelector('#preview-wrap');
  const panels = ['.monitor-panel', '.context-panel', '.clip-panel', '.browser-panel']
    .map(selector => app.querySelector(selector));
  const handle = name => app.querySelector(`[data-layout-splitter="${name}"]`);
  const save = () => { try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Keep resizing usable if storage is unavailable. */ } };

  function applyWorkspace() {
    const fixed = ['.topbar', '.deckbar', '.toolbar', '.statusbar', '[data-layout-splitter="workspace"]']
      .reduce((sum, selector) => sum + app.querySelector(selector).getBoundingClientRect().height, 0);
    const maximum = Math.max(140, app.clientHeight - fixed - 220);
    const preferred = state.workspaceHeight ?? Math.min(app.clientHeight <= 850 ? 298 : 322,
      Math.max(170, app.clientHeight * .33));
    const height = clamp(preferred, Math.min(140, maximum), maximum);
    app.style.setProperty('--workspace-height', `${height}px`);
    handle('workspace').setAttribute('aria-valuenow', String(Math.round(height)));
  }

  function monitorSpace() {
    const fixed = [...monitor.children].filter(child => !child.classList.contains('monitor-wrap'))
      .reduce((sum, child) => sum + child.getBoundingClientRect().height, 0);
    return Math.max(1, monitor.clientHeight - fixed);
  }

  function applyMonitors() {
    const available = monitorSpace();
    const minimum = Math.min(100, available / 2);
    const ratio = clamp(state.monitorRatio, minimum / available, 1 - minimum / available);
    monitor.style.setProperty('--monitor-output', `${ratio}fr`);
    monitor.style.setProperty('--monitor-preview', `${1 - ratio}fr`);
    handle('monitors').setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  function applyColumns() {
    state.columns.forEach((width, index) => app.querySelector('.bottom').style.setProperty(`--pane-${index}`, `${width}fr`));
    for (let index = 0; index < 3; index++) handle(`panel-${index}`).setAttribute('aria-valuenow',
      String(Math.round(panels[index].getBoundingClientRect().width)));
  }

  function adjust(kind, delta, start) {
    if (kind === 'workspace') {
      state.workspaceHeight = start + delta;
      applyWorkspace();
      applyMonitors();
    } else if (kind === 'monitors') {
      state.monitorRatio = (start.output + delta) / start.total;
      applyMonitors();
    } else {
      const index = Number(kind.slice(-1));
      const widths = [...start];
      const total = widths[index] + widths[index + 1];
      const firstMinimum = Math.min(COLUMN_MINIMUMS[index], total / 2);
      const secondMinimum = Math.min(COLUMN_MINIMUMS[index + 1], total / 2);
      widths[index] = clamp(start[index] + delta, firstMinimum, total - secondMinimum);
      widths[index + 1] = total - widths[index];
      state.columns = widths;
      applyColumns();
    }
  }

  for (const splitter of app.querySelectorAll('[data-layout-splitter]')) {
    const kind = splitter.dataset.layoutSplitter;
    const vertical = kind.startsWith('panel-');
    const current = () => kind === 'workspace' ? workspace.getBoundingClientRect().height
      : kind === 'monitors' ? { output: output.getBoundingClientRect().height,
        total: output.getBoundingClientRect().height + preview.getBoundingClientRect().height }
        : panels.map(panel => panel.getBoundingClientRect().width);
    splitter.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const start = current(), coordinate = vertical ? event.clientX : event.clientY;
      splitter.setPointerCapture(event.pointerId);
      document.documentElement.classList.add('resizing-layout');
      const move = next => adjust(kind, (vertical ? next.clientX : next.clientY) - coordinate, start);
      const finish = () => {
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', finish);
        splitter.removeEventListener('pointercancel', finish);
        document.documentElement.classList.remove('resizing-layout');
        save();
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', finish);
      splitter.addEventListener('pointercancel', finish);
    });
    splitter.addEventListener('keydown', event => {
      const step = event.shiftKey ? 40 : 12;
      const delta = vertical ? event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0
        : event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
      if (!delta) return;
      event.preventDefault();
      adjust(kind, delta, current());
      save();
    });
    splitter.addEventListener('dblclick', () => {
      if (kind === 'workspace') { state.workspaceHeight = null; applyWorkspace(); applyMonitors(); }
      else if (kind === 'monitors') { state.monitorRatio = .5; applyMonitors(); }
      else { state.columns = [...DEFAULT_COLUMNS]; applyColumns(); }
      save();
    });
  }
  applyWorkspace();
  applyMonitors();
  applyColumns();
  window.addEventListener('resize', () => { applyWorkspace(); applyMonitors(); applyColumns(); });
}
