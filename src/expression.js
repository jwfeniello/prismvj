// Numeric field math (manual p. 132): "1920/3", or "/2" relative to the current value.
export function evaluateExpression(text, current = 0) {
  let s = String(text).trim();
  if (/^[*/+]/.test(s)) s = `${current}${s}`;
  if (!s || !/^[-+*/().\d\seE]+$/.test(s)) return NaN;
  let i = 0;
  const skip = () => { while (s[i] === ' ') i++; };
  const atom = () => {
    skip();
    if (s[i] === '(') { i++; const v = sum(); skip(); if (s[i++] !== ')') throw new Error('paren'); return v; }
    if (s[i] === '-') { i++; return -atom(); }
    if (s[i] === '+') { i++; return atom(); }
    const m = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(s.slice(i));
    if (!m) throw new Error('number');
    i += m[0].length; return Number(m[0]);
  };
  const product = () => { let v = atom(); for (;;) { skip(); const op = s[i]; if (op !== '*' && op !== '/') return v; i++; const r = atom(); v = op === '*' ? v * r : v / r; } };
  const sum = () => { let v = product(); for (;;) { skip(); const op = s[i]; if (op !== '+' && op !== '-') return v; i++; const r = product(); v = op === '+' ? v + r : v - r; } };
  try { const v = sum(); skip(); return i === s.length && Number.isFinite(v) ? v : NaN; } catch { return NaN; }
}
