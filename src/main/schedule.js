/* MAP
 * §1 validare program  L8-L33
 * §2 urmatoarea rulare  L34-L58
 */

// §1 validare program: { type:'manual' } | { type:'interval', every, unit } | { type:'daily', at:'HH:MM', everyDays }
const UNIT_MS = { minutes: 60000, hours: 3600000, days: 86400000 };
const MIN_INTERVAL_MS = 5 * 60000; // sub 5 minute nu are sens pentru Drive (limita de cereri)

function normalize(s) {
  if (!s || s.type === 'manual') return { type: 'manual' };
  if (s.type === 'interval') {
    const every = Math.max(1, Math.round(Number(s.every)) || 1);
    const unit = UNIT_MS[s.unit] ? s.unit : 'hours';
    if (every * UNIT_MS[unit] < MIN_INTERVAL_MS) throw new Error('Interval too short (minimum 5 minutes)');
    return { type: 'interval', every, unit };
  }
  if (s.type === 'daily') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s.at || ''));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('Invalid time, use HH:MM');
    const everyDays = Math.min(Math.max(Math.round(Number(s.everyDays)) || 1, 1), 365);
    return { type: 'daily', at: `${m[1].padStart(2, '0')}:${m[2]}`, everyDays };
  }
  throw new Error('Unknown schedule type');
}

// §2 urmatoarea rulare (ms epoch; 0 = niciodata automat). `from` = ultima rulare (0 = niciuna).
function nextRun(schedule, from, now = Date.now()) {
  const s = normalize(schedule);
  if (s.type === 'manual') return 0;
  if (s.type === 'interval') return (from || now) + s.every * UNIT_MS[s.unit];
  const [h, m] = s.at.split(':').map(Number);
  const base = new Date(from || now);
  const at = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
  if (s.everyDays === 1) {
    const today = at(base);
    return today > (from || now) ? today : at(new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1));
  }
  return at(new Date(base.getFullYear(), base.getMonth(), base.getDate() + s.everyDays));
}

function describe(schedule) {
  const s = normalize(schedule);
  if (s.type === 'manual') return 'Manual only';
  if (s.type === 'interval') return `Every ${s.every} ${s.every === 1 ? s.unit.slice(0, -1) : s.unit}`;
  return s.everyDays === 1 ? `Daily at ${s.at}` : `Every ${s.everyDays} days at ${s.at}`;
}

module.exports = { normalize, nextRun, describe };
