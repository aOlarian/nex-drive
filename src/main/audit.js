/* MAP
 * §1 audit partajare  L6-L48
 * §2 inchidere partajare  L49-L68
 */

// §1 audit partajare: ce e public (oricine cu linkul / gasit pe web) si ce e partajat cu persoane
function createAudit(drive) {
  async function pages(query, onItems) {
    let pageToken;
    do {
      const q = { ...query };
      if (pageToken) q.pageToken = pageToken;
      const r = await drive.json('GET', '/drive/v3/files', { query: q });
      await onItems(r.files || []);
      pageToken = r.nextPageToken;
    } while (pageToken);
  }

  // Intoarce {publicFiles, sharedFiles, scanned}. Randurile includ permisiunile ca sa se vada cu cine.
  async function run(onProgress = () => {}) {
    const publicFiles = [];
    const sharedFiles = [];
    let scanned = 0;
    const fields = 'nextPageToken,files(id,name,mimeType,webViewLink,shared,owners(emailAddress))';

    // 1) public: acopera „oricine cu linkul” si „gasit pe web”
    await pages({
      q: "'me' in owners and trashed=false and (visibility='anyoneWithLink' or visibility='anyoneCanFind')",
      fields, pageSize: '1000',
    }, (items) => { publicFiles.push(...items); });

    // 2) partajate cu persoane/grupuri: scanare ieftina dupa campul `shared`, apoi permisiunile doar pentru acestea
    const sharedIds = [];
    await pages({ q: "'me' in owners and trashed=false", fields: 'nextPageToken,files(id,name,shared)', pageSize: '1000' }, (items) => {
      scanned += items.length;
      for (const f of items) if (f.shared) sharedIds.push(f);
      onProgress({ scanned, shared: sharedIds.length });
    });
    for (const f of sharedIds) {
      const r = await drive.json('GET', `/drive/v3/files/${encodeURIComponent(f.id)}/permissions`, {
        query: { fields: 'permissions(id,type,role,emailAddress)', pageSize: '100' },
      });
      const others = (r.permissions || []).filter((p) => p.role !== 'owner');
      if (others.length) sharedFiles.push({ id: f.id, name: f.name, permissions: others });
    }
    return { publicFiles, sharedFiles, scanned };
  }

  // §2 inchidere partajare: sterge permisiunile (doar publice, sau toate in afara de proprietar)
  async function makePrivate(fileId, { onlyPublic = false } = {}) {
    const r = await drive.json('GET', `/drive/v3/files/${encodeURIComponent(fileId)}/permissions`, {
      query: { fields: 'permissions(id,type,role)', pageSize: '100' },
    });
    let removed = 0;
    for (const p of r.permissions || []) {
      if (p.role === 'owner') continue;
      if (onlyPublic && p.type !== 'anyone' && p.type !== 'domain') continue;
      await drive.json('DELETE', `/drive/v3/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(p.id)}`);
      removed++;
    }
    return removed;
  }

  return { run, makePrivate };
}

module.exports = { createAudit };
