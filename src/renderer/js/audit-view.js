/* MAP
 * §1 dialog audit partajare  L5-L69
 */

// §1 dialog audit partajare
function permText(p) {
  const who = p.type === 'anyone' ? 'ANYONE with the link' : (p.emailAddress || p.type);
  return `${who} (${p.role})`;
}

function listBlock(title, items, build) {
  const box = el('div', {}, el('h4', {}, `${title} (${items.length})`));
  if (!items.length) { box.append(el('p', { class: 'muted' }, 'Nothing found.')); return box; }
  const ul = el('ul');
  for (const f of items.slice(0, 500)) ul.append(build(f));
  box.append(ul);
  if (items.length > 500) box.append(el('p', { class: 'muted' }, `…and ${items.length - 500} more (showing the first 500).`));
  return box;
}

async function openAudit() {
  const dlg = $('audit-dlg');
  const body = $('audit-body');
  const allBtn = $('audit-private-all');
  body.textContent = 'Scanning your whole Drive. This can take a few minutes…';
  allBtn.hidden = true;
  allBtn.disabled = false;
  allBtn.textContent = 'Make everything public private';
  dlg.showModal();
  const r = await guard(() => window.nexDrive.audit.run());
  if (!r) { body.textContent = 'The scan failed.'; return; }

  const privatize = (f, only, btn) => async () => {
    btn.disabled = true;
    const n = await guard(() => window.nexDrive.audit.makePrivate(f.id, only));
    btn.textContent = n === undefined ? 'error' : `closed (${n})`;
  };
  body.replaceChildren(
    el('p', {}, `Scanned ${r.scanned} files you own.`),
    listBlock('Public (open link / findable on the web)', r.publicFiles, (f) => {
      const b = el('button', {}, 'Make private');
      b.addEventListener('click', privatize(f, true, b));
      return el('li', {}, `${f.name} `, b);
    }),
    listBlock('Shared with people or groups', r.sharedFiles, (f) => {
      const b = el('button', {}, 'Stop sharing');
      b.addEventListener('click', privatize(f, false, b));
      return el('li', {}, `${f.name}: ${f.permissions.map(permText).join(', ')} `, b);
    }),
  );
  const ok = !r.publicFiles.length && !r.sharedFiles.length;
  if (ok) body.prepend(el('p', {}, '✔ Everything is private: no public links, no sharing.'));
  allBtn.hidden = r.publicFiles.length === 0;
  allBtn.onclick = async () => {
    allBtn.disabled = true;
    let n = 0;
    for (const f of r.publicFiles) n += (await guard(() => window.nexDrive.audit.makePrivate(f.id, true))) || 0;
    allBtn.textContent = `Closed ${n} public permissions`;
  };
}

function initAudit() {
  $('btn-audit').addEventListener('click', openAudit);
  $('audit-close').addEventListener('click', () => $('audit-dlg').close());
  window.nexDrive.on('audit:progress', (p) => {
    if ($('audit-dlg').open) $('audit-body').textContent = `Scanned ${p.scanned} files, shared found: ${p.shared}…`;
  });
}
