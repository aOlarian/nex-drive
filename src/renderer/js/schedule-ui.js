/* MAP
 * §1 selector de program  L5-L37
 */

// §1 selector de program (Sync + Maintenance): produce exact formatul din schedule.js
function fmtSchedule(s) {
  if (!s || s.type === 'manual') return 'Manual only';
  if (s.type === 'interval') return `Every ${s.every} ${s.every === 1 ? s.unit.slice(0, -1) : s.unit}`;
  return s.everyDays === 1 ? `Daily at ${s.at}` : `Every ${s.everyDays} days at ${s.at}`;
}

function scheduleField(initial = { type: 'interval', every: 1, unit: 'hours' }) {
  const opt = (v, t) => el('option', { value: v }, t);
  const mode = el('select', { title: 'When to run' }, opt('interval', 'Every N minutes / hours / days'), opt('daily', 'Daily at HH:MM (every N days)'), opt('manual', 'Manual only'));
  const every = el('input', { type: 'number', min: '1', value: '1' });
  const unit = el('select', {}, opt('minutes', 'minutes'), opt('hours', 'hours'), opt('days', 'days'));
  const at = el('input', { type: 'time', value: '02:00' });
  const everyDays = el('input', { type: 'number', min: '1', max: '365', value: '1' });
  const rowI = el('span', { class: 'inline' }, 'Every ', every, unit);
  const rowD = el('span', { class: 'inline' }, 'at ', at, ' every ', everyDays, ' day(s)');
  const show = () => { rowI.hidden = mode.value !== 'interval'; rowD.hidden = mode.value !== 'daily'; };
  mode.addEventListener('change', show);

  function set(s) {
    mode.value = s.type;
    if (s.type === 'interval') { every.value = String(s.every); unit.value = s.unit; }
    if (s.type === 'daily') { at.value = s.at; everyDays.value = String(s.everyDays); }
    show();
  }
  function get() {
    if (mode.value === 'manual') return { type: 'manual' };
    if (mode.value === 'interval') return { type: 'interval', every: Number(every.value) || 1, unit: unit.value };
    return { type: 'daily', at: at.value, everyDays: Number(everyDays.value) || 1 };
  }
  set(initial);
  return { node: el('div', { class: 'inline' }, mode, rowI, rowD), get, set };
}
