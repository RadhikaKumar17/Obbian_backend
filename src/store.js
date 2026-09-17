import { readFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';

const DOC_ID = 'state';

/**
 * Single-process durable store backed by MongoDB. The whole dataset lives in one
 * document; mutations are serialized in-process and committed atomically to Mongo.
 * `read()` stays synchronous by serving an in-memory copy that's refreshed after
 * every successful `update()` — callers (service.js) don't need to know this is a
 * network-backed store at all.
 */
export async function createStore(mongoUri, seedFile = new URL('../data/seed.json', import.meta.url)) {
  if (!mongoUri) throw new Error('MONGODB_URI is required. Set it in OBBIAN_BACKEND/.env.');
  const client = new MongoClient(mongoUri);
  await client.connect();
  const collection = client.db().collection('obbian_state');

  let state = (await collection.findOne({ _id: DOC_ID }))?.data;
  if (!state) {
    state = JSON.parse(await readFile(seedFile, 'utf8'));
    await collection.updateOne({ _id: DOC_ID }, { $setOnInsert: { data: state } }, { upsert: true });
  }
  if (!Array.isArray(state.vehicles) || !Array.isArray(state.bookings) || !Array.isArray(state.policies) || !state.config || !state.sessions) {
    throw new Error('Invalid database. Refusing to overwrite existing data.');
  }

  let queue = Promise.resolve();
  return {
    read() { return structuredClone(state); },
    async readFresh() {
      const latest = await collection.findOne({ _id: DOC_ID });
      if (!latest) throw new Error('Database state is missing.');
      state = latest.data;
      return structuredClone(state);
    },
    update(change) {
      const operation = queue.then(async () => {
        // Compare-and-swap makes booking checks safe across multiple server processes.
        for (let attempt = 0; attempt < 20; attempt++) {
          const latest = await collection.findOne({ _id: DOC_ID });
          if (!latest) throw new Error('Database state is missing.');
          const draft = structuredClone(latest.data);
          const result = await change(draft);
          const written = await collection.updateOne(
            { _id: DOC_ID, revision: latest.revision ?? null },
            { $set: { data: draft }, $inc: { revision: 1 } },
          );
          if (written.matchedCount === 1) {
            state = draft;
            return structuredClone(result);
          }
        }
        throw new Error('Database is busy. Please retry.');
      });
      queue = operation.catch(() => {});
      return operation;
    },
    async close() { await client.close(); },
  };
}
