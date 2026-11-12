import fs from 'node:fs';
import path from 'node:path';
import { CloudState } from './cloud-state.js';
import { Store } from './store.js';
import { BotError } from './errors.js';

export async function manageState(command, args, config, { cloud, signal }) {
  const remote = config.state && new CloudState(config.state, config.shipment);
  const localFile = path.join(config.dataDir, 'tracking.sqlite');
  if (command === 'backup-state') {
    if (!args[0]) throw new BotError('STATE_BACKUP_PATH_REQUIRED');
    let snapshot;
    if (cloud) snapshot = await remote.read(signal);
    else {
      if (!fs.existsSync(localFile)) throw new BotError('STATE_MISSING');
      const store = new Store(localFile, config.shipment);
      try { snapshot = store.exportSnapshot(); }
      finally { store.close(); }
    }
    if (!snapshot) throw new BotError('STATE_MISSING');
    fs.mkdirSync(path.dirname(args[0]), { recursive: true });
    fs.writeFileSync(args[0], JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
    console.log('Backup privado salvo. Guarde-o fora do controle de versão.');
    return;
  }

  const store = new Store(':memory:', config.shipment);
  try {
    if (command === 'status') {
      const snapshot = await remote.read(signal);
      if (!snapshot) throw new BotError('STATE_MISSING');
      store.restoreSnapshot(snapshot);
      console.log(JSON.stringify({ ...store.getState(), eventos: store.events().length,
        notificacoes: store.notifications().map(x => ({ id: x.id, tipo: x.kind, estado: x.status, tentativas: x.attempts })) }, null, 2));
      return;
    }
    if (command === 'import-state') {
      if (!args[0]) throw new BotError('STATE_BACKUP_PATH_REQUIRED');
      let snapshot;
      try { snapshot = JSON.parse(fs.readFileSync(args[0], 'utf8')); }
      catch { throw new BotError('STATE_BACKUP_INVALID'); }
      store.restoreSnapshot(snapshot);
    }
    await remote.withLease(async ({ snapshot, save }) => {
      if (command === 'resolve') {
        if (!snapshot) throw new BotError('STATE_MISSING');
        store.restoreSnapshot(snapshot);
        store.recoverSending();
        store.resolve(args[0], args[1]);
        await save(store.exportSnapshot());
        console.log('Notificação atualizada.');
      } else {
        await save(store.exportSnapshot(), { initialize: true });
        console.log(command === 'import-state' ? 'Histórico importado no armazenamento remoto.' : 'Estado remoto inicial criado.');
      }
    }, signal);
  } finally { store.close(); }
}
