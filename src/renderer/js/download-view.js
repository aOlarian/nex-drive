/* MAP
 * §1 randare descarcari  L6-L40
 * §2 butoane si taburi  L41-L60
 */

// §1 randare descarcari
function renderDownloads(s) {
  actState.dl = s;
  updateActivityBar();
  const c = s.counts;
  const open = c.pending + c.downloading;
  $('badge-dl').textContent = open ? String(open) : (c.error ? '!' : '');
  const st = $('d-status');
  st.className = `status${c.error ? ' paused' : ''}`;
  if (s.active) st.textContent = `Downloading… ${fmtSpeed(s.speed) || '0 B/s'} · ${fmtSize(s.totalBytes)} downloaded`;
  else if (open) st.textContent = 'Waiting';
  else if (c.error) st.textContent = `Finished with ${c.error} errors. The other files were downloaded; the errors are listed below.`;
  else if (c.done) st.textContent = `Finished: ${c.done} files, ${fmtSize(s.totalBytes)}.`;
  else st.textContent = 'No downloads. Tick files or folders and press "Download".';
  $('d-summary').textContent = `done ${c.done} · in progress ${c.downloading} · waiting ${c.pending} · errors ${c.error}${c.cancelled ? ` · stopped ${c.cancelled}` : ''}`;

  const list = $('d-list');
  list.replaceChildren();
  for (const it of s.items) {
    let label;
    let cls = 'st';
    if (it.state === 'done') { label = it.note || fmtSize(it.bytes); cls += ' ok'; }
    else if (it.state === 'error') { label = 'ERROR'; cls += ' err'; }
    else if (it.state === 'downloading') label = it.size ? `${fmtSize(it.bytes)} / ${fmtSize(it.size)} (${Math.floor((it.bytes / it.size) * 100)}%)` : fmtSize(it.bytes);
    else label = 'waiting';
    const row = el('li', { class: it.state === 'error' ? 'errrow' : '' },
      el('span', { class: 'nm', title: it.name }, it.name),
      el('span', { class: cls }, label));
    if (it.state === 'error') row.append(el('div', { class: 'errmsg' }, it.error));
    if (it.state === 'downloading' && it.size) row.append(el('div', { class: 'mini' }, el('div', { style: `width:${Math.min(100, (it.bytes / it.size) * 100).toFixed(0)}%` })));
    list.append(row);
  }
}

// §2 butoane si taburi
function showTab(which) {
  const dl = which === 'dl';
  $('view-up').hidden = dl;
  $('view-dl').hidden = !dl;
  $('tab-up').classList.toggle('on', !dl);
  $('tab-dl').classList.toggle('on', dl);
  if (!dl && typeof flushQueueView === 'function') flushQueueView();
}

function initDownloadView() {
  const d = window.nexDrive.dl;
  $('tab-up').addEventListener('click', () => showTab('up'));
  $('tab-dl').addEventListener('click', () => showTab('dl'));
  $('d-cancel').addEventListener('click', () => guard(() => d.cancel()));
  $('d-retry').addEventListener('click', () => guard(() => d.retry()));
  $('d-clear-done').addEventListener('click', () => guard(() => d.clear('finished')));
  $('d-clear-all').addEventListener('click', () => guard(() => d.clear('all')));
  window.nexDrive.on('dl:update', renderDownloads);
}
