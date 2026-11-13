import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ENV_PATH } from './config.js';
import { Store, InstanceLock } from './store.js';
import { Rodonaves } from './rodonaves.js';
import { Telegram } from './telegram.js';
import { Monitor, combinedMonitor, runLoop } from './engine.js';
import { makeLogger } from './logger.js';
import { BotError, safeCode } from './errors.js';
import { CloudState, cloudMonitor } from './cloud-state.js';
import { manageState } from './state-admin.js';

const command = process.argv[2] ?? 'run';
const cloud = process.argv.includes('--cloud');
const args = process.argv.slice(3).filter(arg => !arg.startsWith('--'));
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
let store, lock, log, stopWatcher, processFile;
const explanations = {
  CONFIG_PRIVATE_CHAT_REQUIRED: 'Configure TELEGRAM_CHAT_ID com o ID do seu chat privado. Use npm run chat para descobrir.',
  INSTANCE_ALREADY_RUNNING: 'O bot já está em execução. Use status.bat ou parar.bat.',
  CONFIG_TOKEN_INVALID: 'Configure TELEGRAM_BOT_TOKEN nas variáveis privadas do ambiente.',
  CONFIG_SHIPMENT_INVALID: 'Confira RODONAVES_PROTOCOLO, RODONAVES_CTE, RODONAVES_CNPJ e RODONAVES_NF.',
  CONFIG_INTERVAL_INVALID: 'Informe CHECK_INTERVAL_MS entre 300000 e 86400000.',
  SSW_CONFIG_INVALID: 'Configure SSW_CPF com 11 dígitos e SSW_NF com o número da nota.',
  CONFIG_STATE_INVALID: 'Confira UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN e STATE_NAMESPACE.',
  DATABASE_SHIPMENT_MISMATCH: 'Os dados da encomenda diferem do histórico. Use os mesmos valores da origem.',
  STATE_MISSING: 'Histórico ausente. Importe o backup ou inicialize um histórico novo conforme o README.',
  STATE_ALREADY_EXISTS: 'Este histórico já existe. Para restaurar, use outro STATE_NAMESPACE conforme o README.',
  STATE_AUTH_FAILED: 'Verifique o endpoint e o token Standard do Upstash.',
  STATE_BUSY: 'Histórico ocupado por outra consulta. Tente novamente após o fim da rodada.',
  STATE_BACKUP_PATH_REQUIRED: 'Informe o caminho do arquivo privado de backup.',
  STATE_INVALID: 'O histórico está inválido. Confira o backup antes de restaurar.',
  STATE_TOO_LARGE: 'O histórico excedeu o tamanho suportado. Confira o procedimento de recuperação no README.',
};
try {
  const telegramCommands = ['run', 'once', 'discover-chat', 'test-telegram', 'check-config'];
  const config = loadConfig({
    cloud,
    remote: cloud || ['init-state', 'import-state'].includes(command),
    needToken: telegramCommands.includes(command),
    needChat: telegramCommands.includes(command) && command !== 'discover-chat',
    needShipment: !['discover-chat', 'test-telegram', 'verify-ssw'].includes(command),
  });
  const telegram = new Telegram(config.token, config.chatId);
  if (command === 'check-config') {
    console.log(JSON.stringify({ configuracao: 'valida', armazenamento: cloud ? 'upstash' : 'sqlite', intervaloMs: config.intervalMs, node: process.versions.node }));
  } else if (['init-state', 'import-state', 'backup-state'].includes(command) || (cloud && ['status', 'resolve'].includes(command))) {
    await manageState(command, args, config, { cloud, signal: controller.signal });
  } else if (command === 'discover-chat') {
    const chats = await telegram.discover(controller.signal, 25);
    if (chats.length === 0) {
      console.log('Nenhum /start disponível. Abra seu bot, toque em Iniciar e execute novamente. Se outro programa usa getUpdates, pare esse programa primeiro.');
      process.exitCode = 2;
    } else if (chats.length > 1) {
      console.log('Mais de um chat privado encontrado. Configure o seu ID no .env:');
      console.log(chats.map(x => ({ id: x.id })));
      process.exitCode = 2;
    } else {
      let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
      const line = `TELEGRAM_CHAT_ID=${chats[0].id}`;
      text = /^TELEGRAM_CHAT_ID=.*$/m.test(text) ? text.replace(/^TELEGRAM_CHAT_ID=.*$/m, line) : text + '\n' + line + '\n';
      fs.writeFileSync(ENV_PATH, text);
      console.log(`Chat privado configurado: ${chats[0].id}. Execute testar-telegram.bat.`);
    }
  } else if (command === 'test-telegram') {
    await telegram.validatePrivate(controller.signal);
    const id = await telegram.send('✅ TESTE DO BOT RODONAVES\n\nO envio ao seu chat privado está funcionando. Esta é uma mensagem de teste; não representa uma nova movimentação.', controller.signal);
    console.log(`Teste enviado e confirmado pelo Telegram. Mensagem ${id}.`);
  } else if (command === 'verify-source') {
    const source = new Rodonaves(config.shipment);
    const snapshot = await source.consult(controller.signal);
    console.log(JSON.stringify(snapshot, null, 2));
  } else if (command === 'verify-ssw') {
    if (!config.ssw) throw new BotError('SSW_CONFIG_INVALID');
    const { Ssw } = await import('./ssw.js');
    const { statusText, eta, latestAt, events } = await new Ssw(config.ssw).consult(controller.signal);
    console.log(JSON.stringify({ source: 'ssw', status: statusText, eta, latestAt, movements: events.length }, null, 2));
  } else if (command === 'status') {
    const filename = path.join(config.dataDir, 'tracking.sqlite');
    if (!fs.existsSync(filename)) console.log('O bot ainda não fez a primeira consulta.');
    else {
      store = new Store(filename, config.shipment);
      let running = true;
      try { const check = new InstanceLock(path.join(config.dataDir, 'instance.sqlite')); check.close(); running = false; } catch (error) { if (error.code !== 'INSTANCE_ALREADY_RUNNING') throw error; }
      console.log(JSON.stringify({ executando: running, ...store.getState(), eventos: store.events().length, notificacoes: store.notifications().map(x => ({ id: x.id, tipo: x.kind, estado: x.status, tentativas: x.attempts, mensagemTelegram: x.message_id })) }, null, 2));
    }
  } else if (cloud && ['run', 'once'].includes(command)) {
    log = makeLogger(null, { consoleOutput: true });
    log('config_valid', { backend: 'upstash', nodeVersion: process.versions.node, intervalMs: config.intervalMs });
    const sourceLogger = source => (event, metadata) => log(event, { ...metadata, source });
    const rodonavesLog = sourceLogger('rodonaves');
    const remote = new CloudState(config.state, config.shipment, { log: rodonavesLog });
    const source = new Rodonaves(config.shipment, { log: rodonavesLog });
    const rodonaves = cloudMonitor({ remote, shipment: config.shipment, source, telegram, link: config.link, log: rodonavesLog });
    let monitor = rodonaves;
    if (config.sswInvalid) log('source_disabled', { source: 'ssw', code: 'SSW_CONFIG_INVALID' });
    if (config.ssw) {
      const { Ssw, SSW_FORM } = await import('./ssw.js');
      const sswLog = sourceLogger('ssw');
      const state = { ...config.state, namespace: `${config.state.namespace}:ssw` };
      const ssw = cloudMonitor({
        remote: new CloudState(state, config.ssw, { log: sswLog }), shipment: config.ssw,
        source: new Ssw(config.ssw), telegram, link: SSW_FORM, log: sswLog,
        carrier: 'Trans Vales (SSW)', initializeOnSuccess: true, failureAlerts: false,
      });
      monitor = combinedMonitor([['rodonaves', rodonaves], ['ssw', ssw]], log);
    }
    log('started', { rssMiB: Math.round(process.memoryUsage().rss / 1048576) });
    if (command === 'once') await monitor.cycle(controller.signal);
    else await runLoop(monitor, { pollSeconds: config.intervalMs / 1000, signal: controller.signal });
    log('stopped');
  } else if (['run', 'once', 'resolve'].includes(command)) {
    lock = new InstanceLock(path.join(config.dataDir, 'instance.sqlite'));
    store = new Store(path.join(config.dataDir, 'tracking.sqlite'), config.shipment);
    if (command === 'resolve') {
      store.resolve(args[0], args[1]);
      console.log('Notificação atualizada.');
    } else {
      store.recoverSending();
      processFile = path.join(config.dataDir, 'process.json');
      const stopFile = path.join(config.dataDir, 'stop.request');
      fs.rmSync(stopFile, { force: true });
      stopWatcher = fs.watch(config.dataDir, (_event, filename) => { if (String(filename) === 'stop.request' && fs.existsSync(stopFile)) controller.abort(); });
      stopWatcher.on('error', () => controller.abort());
      stopWatcher.unref();
      fs.writeFileSync(processFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), executable: process.execPath }));
      log = makeLogger(config.logDir, { consoleOutput: !process.argv.includes('--quiet') });
      const source = new Rodonaves(config.shipment, { log });
      const monitor = new Monitor({ store, source, telegram, link: config.link, log });
      log('started', { pid: process.pid, rssMiB: Math.round(process.memoryUsage().rss / 1048576) });
      // Positive numeric chat IDs identify private chats; getChat is only needed in setup/test.
      // Telegram downtime at startup must not prevent carrier monitoring.
      if (command === 'once') await monitor.cycle(controller.signal);
      else await runLoop(monitor, { pollSeconds: config.intervalMs / 1000, signal: controller.signal });
      log('stopped');
    }
  } else throw new BotError('COMMAND_INVALID');
} catch (error) {
  const code = safeCode(error);
  const scheduledDuplicate = command === 'run' && process.argv.includes('--scheduled') && code === 'INSTANCE_ALREADY_RUNNING';
  if (!controller.signal.aborted && !scheduledDuplicate) {
    if (log) { try { log('fatal', { code }); } catch {} }
    console.error(`${code}: ${explanations[code] ?? 'Consulte README.md e os logs da execução.'}`);
    process.exitCode = 1;
  }
} finally {
  stopWatcher?.close();
  if (processFile) { try { fs.rmSync(processFile, { force: true }); } catch {} }
  store?.close();
  lock?.close();
}
