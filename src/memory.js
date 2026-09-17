import { randomUUID } from 'node:crypto';
import MemoryClient from 'mem0ai';
import { settings } from './config.js';

const client = settings.mem0ApiKey ? new MemoryClient({ apiKey: settings.mem0ApiKey }) : null;

export async function rememberChat(session, area, question, replyText, fullReply) {
  if (!client) return;
  const turnId = randomUUID();
  const payload = JSON.stringify({ question, ...fullReply, createdAt: new Date().toISOString() });
  await client.add(
    [{ role: 'user', content: question }, { role: 'assistant', content: replyText }],
    { userId: session, metadata: { area, turn_id: turnId, payload } },
  );
}

export async function recallChat(session, area) {
  if (!client) return [];
  const page = await client.getAll({ filters: { AND: [{ user_id: session }, { metadata: { area } }] }, pageSize: 100 });
  const seen = new Set();
  const turns = [];
  for (const entry of page.results || []) {
    const turnId = entry.metadata?.turn_id;
    if (!turnId || seen.has(turnId)) continue;
    seen.add(turnId);
    try { turns.push(JSON.parse(entry.metadata.payload)); } catch { /* skip malformed entry */ }
  }
  return turns.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
