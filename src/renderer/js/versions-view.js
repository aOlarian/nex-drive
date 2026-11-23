/* MAP
 * §1 dialog versiuni fisier  L5-L36
 */

// §1 dialog versiuni fisier: Drive pastreaza versiunile vechi ~30 de zile, daca nu sunt marcate „Keep forever”
async function openVersions() {
  const sel = selectedItems();
  if (sel.length !== 1 || sel[0].mimeType === FOLDER) return;
  const it = sel[0];
  const body = $('ver-body');
  $('ver-name').textContent = it.name;
  body.textContent = 'Loading…';
  $('versions-dlg').showModal();
  const revs = await guard(() => api.drive.revisions(it.id));
  if (!revs) { body.textContent = 'Could not load the versions of this file.'; return; }
  if (revs.length <= 1) { body.textContent = 'This file has no older versions. Drive creates a new version each time the file is overwritten with changed content.'; return; }
  const rows = [...revs].reverse().map((r, i) => { // Drive le da de la cea mai veche; ultima e cea curenta
    const { box, label } = checkLabel('Keep forever', !!r.keepForever, 'Drive deletes old versions automatically after about 30 days unless they are kept forever');
    box.addEventListener('change', async () => {
      const ok = await guard(() => api.drive.keepRevision(it.id, r.id, box.checked));
      if (!ok) box.checked = !box.checked;
    });
    const dl = el('button', { title: 'Save this version as a file' }, 'Download');
    dl.addEventListener('click', async () => {
      const p = await guard(() => api.drive.downloadRevision(it.id, r.id, it.name));
      if (p) toast(`Saved to ${p}`);
    });
    return el('tr', {}, el('td', {}, fmtDate(r.modifiedTime) + (i === 0 ? ' (current)' : '')), el('td', { class: 'num' }, r.size ? fmtSize(r.size) : ''), el('td', {}, label), el('td', {}, dl));
  });
  body.replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Modified'), el('th', { class: 'num' }, 'Size'), el('th', {}, 'Retention'), el('th', {}, ''))), el('tbody', {}, ...rows)));
}

function initVersions() {
  $('btn-versions').addEventListener('click', openVersions);
  $('ver-close').addEventListener('click', () => $('versions-dlg').close());
}
