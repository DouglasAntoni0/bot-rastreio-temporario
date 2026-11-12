import { mkdirSync, statSync, renameSync, existsSync, appendFileSync, rmSync } from 'node:fs';
import path from 'node:path';
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium' });
export function makeLogger(directory, { consoleOutput = false } = {}) {
  if (directory) mkdirSync(directory, { recursive: true });
  const file = directory ? path.join(directory, 'bot.log') : null;
  const allowed = new Set(['code', 'source', 'kind', 'failures', 'newEvents', 'pid', 'rssMiB', 'backend', 'nodeVersion', 'intervalMs']);
  return (event, metadata = {}) => {
    if (file && existsSync(file) && statSync(file).size > 1024 * 1024) {
      if (existsSync(file + '.3')) rmSync(file + '.3');
      for (let n = 2; n >= 1; n--) if (existsSync(file + '.' + n)) renameSync(file + '.' + n, file + '.' + (n + 1));
      renameSync(file, file + '.1');
    }
    const filtered = Object.fromEntries(Object.entries(metadata).filter(([key]) => allowed.has(key)));
    const line = `${dateFormat.format(new Date())} America/Sao_Paulo ${event} ${JSON.stringify(filtered)}\n`;
    if (file) appendFileSync(file, line, 'utf8');
    if (consoleOutput) process.stdout.write(line);
  };
}
