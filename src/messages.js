import { displayDate } from './normalize.js';
export const statusText = status => ({ 1: 'Em andamento', 2: 'Entrega concluída', 3: 'Entrega com recusa' }[status] ?? 'Atualização do transporte');
export function eventMessage(event, snapshot, link, carrier = 'Rodonaves') {
  if (!event.description) return `🚚 Sua encomenda teve uma nova atualização na ${carrier}!\n\nConsulte o rastreamento para verificar os detalhes.\n\n${link}`;
  return `🚚 ATUALIZAÇÃO DA MINHA MOTO!\n\n📦 Transportadora: ${carrier}\n\n📍 Nova movimentação:\n${event.description}\n\n🕒 Data: ${displayDate(event.occurredAt)}\n⏰ Horário: ${event.occurredAt.slice(11, 16)}\n\n📅 Previsão de entrega: ${displayDate(snapshot.eta)}\n\n🔗 Link do rastreamento\n${link}`;
}
export const failureMessage = '⚠️ FALHA NO RASTREAMENTO\n\nO robô tentou consultar sua encomenda 3 vezes consecutivas, mas não conseguiu verificar as informações.\n\nPode haver um problema no site da Rodonaves, na conexão ou no próprio robô.\n\n🔧 Verifique o funcionamento do sistema.\n\nO robô continuará tentando automaticamente.';
export function stateMessage(previous, snapshot, link, carrier = 'Rodonaves') {
  const lines = ['🚚 ATUALIZAÇÃO DA MINHA MOTO!', '', `📦 Transportadora: ${carrier}`];
  if (previous.status !== snapshot.status || previous.statusText !== snapshot.statusText) lines.push('', `📍 Status: ${snapshot.statusText ?? statusText(snapshot.status)}`);
  if (previous.eta !== snapshot.eta) lines.push('', `📅 Nova previsão de entrega: ${displayDate(snapshot.eta)}`, `Previsão anterior: ${displayDate(previous.eta)}`);
  lines.push('', '🔗 Link do rastreamento', link);
  return lines.join('\n');
}
