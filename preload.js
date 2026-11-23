/* MAP
 * §1 punte IPC sigura  L5-L33
 */

// §1 punte IPC sigura: renderer-ul vede doar aceste functii
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('nexDrive', {
  pathFor: (file) => webUtils.getPathForFile(file),
  auth: { status: call('auth:status'), importClient: call('auth:import'), login: call('auth:login'), logout: call('auth:logout') },
  drive: {
    about: call('drive:about'), list: call('drive:list'), listFolders: call('drive:listFolders'), mkdir: call('drive:mkdir'), trash: call('drive:trash'), download: call('drive:download'),
    revisions: call('drive:revisions'), keepRevision: call('drive:keepRevision'), downloadRevision: call('drive:downloadRevision'),
  },
  fs: { roots: call('fs:roots'), list: call('fs:list'), show: call('shell:show') },
  sync: {
    jobs: call('sync:jobs'), create: call('sync:create'), update: call('sync:update'), remove: call('sync:remove'), run: call('sync:run'), retryAll: call('sync:retryAll'),
    start: call('sync:start'), stop: call('sync:stop'), pause: call('sync:pause'), resume: call('sync:resume'), reorder: call('sync:reorder'), pickFolders: call('sync:pickFolders'),
    deleted: call('sync:deleted'), deleteFromDrive: call('sync:deleteFromDrive'), keep: call('sync:keep'), restore: call('sync:restore'),
  },
  maint: { list: call('maint:list'), save: call('maint:save'), remove: call('maint:remove'), preview: call('maint:preview'), run: call('maint:run'), pickFolder: call('maint:pickFolder') },
  settings: { get: call('settings:get'), set: call('settings:set') },
  dl: { snapshot: call('dl:snapshot'), cancel: call('dl:cancel'), retry: call('dl:retry'), clear: call('dl:clear') },
  audit: { run: call('audit:run'), makePrivate: call('audit:private') },
  queue: {
    add: call('queue:add'), pick: call('queue:pick'), snapshot: call('queue:snapshot'), remove: call('queue:remove'),
    clear: call('queue:clear'), retry: call('queue:retry'), pause: call('queue:pause'), resume: call('queue:resume'), setWorkers: call('queue:workers'),
  },
  activity: { list: call('activity:list'), clear: call('activity:clear') },
  errors: { summary: call('errors:summary'), clear: call('errors:clear'), open: call('errors:open') },
  on: (ch, cb) => { ipcRenderer.on(ch, (_e, p) => cb(p)); },
});
