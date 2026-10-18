// Eight assignable inspector dials. Values are kept on the owning clip, layer,
// or composition so a saved project restores its performance controls.
export const DASHBOARD_SIZE = 8;

export const DASHBOARD_PARAMETERS = Object.freeze({
  clip: [
    ['opacity', 'Opacity', 0, 1], ['volume', 'Volume', 0, 4],
    ['speed', 'Speed', 0, 4], ['scale', 'Scale', 0, 10],
    ['rotation', 'Rotate Z', -180, 180], ['pan', 'Pan', -1, 1],
    ['x', 'Position X', -1, 1], ['y', 'Position Y', -1, 1],
  ],
  layer: [
    ['opacity', 'Video', 0, 1], ['volume', 'Audio', 0, 1],
    ['transition', 'Transition', 0, 10], ['scale', 'Scale', 0, 10],
    ['rotation', 'Rotate Z', -180, 180], ['pan', 'Pan', -1, 1],
    ['x', 'Position X', -1, 1], ['y', 'Position Y', -1, 1],
  ],
  group: [
    ['opacity', 'Video', 0, 1], ['volume', 'Audio', 0, 1],
    ['speed', 'Speed', 0, 4], ['scale', 'Scale', 0, 10],
    ['rotation', 'Rotate Z', -180, 180], ['pan', 'Pan', -1, 1],
    ['x', 'Position X', -1, 1], ['y', 'Position Y', -1, 1],
  ],
  composition: [
    ['masterOpacity', 'Video', 0, 1], ['masterVolume', 'Audio', 0, 4],
    ['crossfader', 'Crossfader', 0, 1], ['speed', 'Speed', 0, 4],
    ['scale', 'Scale', 0, 10], ['rotation', 'Rotate Z', -180, 180],
    ['pan', 'Pan', -1, 1], ['bpm', 'BPM', 20, 300],
  ],
});

const clamp = value => Math.max(0, Math.min(1, value));
export const dashboardParameter = (scope, key) => DASHBOARD_PARAMETERS[scope]?.find(item => item[0] === key);
export function normalizeDashboard(value, scope) {
  const input = Array.isArray(value) ? value : [];
  return Array.from({ length: DASHBOARD_SIZE }, (_, index) => {
    const dial = input[index];
    const key = dashboardParameter(scope, dial?.key) ? dial.key : null;
    return { key, value: key && Number.isFinite(dial.value) ? clamp(dial.value) : 0 };
  });
}
export function assignDashboard(target, scope, index, key) {
  if (!Number.isInteger(index) || index < 0 || index >= DASHBOARD_SIZE) return false;
  const parameter = dashboardParameter(scope, key);
  if (!parameter) return false;
  const [, , minimum, maximum] = parameter;
  target.dashboard[index] = { key, value: clamp((target[key] - minimum) / (maximum - minimum)) };
  return true;
}
export function moveDashboard(target, scope, index, value) {
  const dial = target.dashboard?.[index];
  const parameter = dashboardParameter(scope, dial?.key);
  if (!parameter || !Number.isFinite(value)) return false;
  const [, , minimum, maximum] = parameter;
  dial.value = clamp(value);
  target[dial.key] = minimum + (maximum - minimum) * dial.value;
  return true;
}
export function syncDashboard(target, scope, key) {
  const parameter = dashboardParameter(scope, key);
  if (!parameter) return;
  const [, , minimum, maximum] = parameter;
  for (const dial of target.dashboard || []) if (dial.key === key)
    dial.value = clamp((target[key] - minimum) / (maximum - minimum));
}
