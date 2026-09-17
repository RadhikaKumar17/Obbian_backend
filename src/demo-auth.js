import { randomBytes } from 'node:crypto';
import { ApiError } from './service.js';

export const DEMO_USER = { id: 'obbian-demo-user', name: 'Demo User', email: 'demo@obbian.com' };
const PASSWORD = 'Obbian123!';
const SESSION_MS = 30 * 86400000;

export function createDemoAuth(store) {
  return {
    async current(token) {
      const db = store.readFresh ? await store.readFresh() : store.read();
      const session = token && db.sessions[token];
      return session?.userId === DEMO_USER.id && session.expiresAt > Date.now() ? DEMO_USER : null;
    },
    async login(input, previousToken) {
      if (typeof input?.email !== 'string' || input.email.trim().toLowerCase() !== DEMO_USER.email || input.password !== PASSWORD) {
        throw new ApiError(401, 'Use the demo email and password shown below.');
      }
      const token = randomBytes(32).toString('hex');
      await store.update(db => {
        // Keep the current browser's existing guest trips and saved vehicles on first login.
        const previous = previousToken && db.sessions[previousToken];
        if (previous && previous.expiresAt > Date.now() && !previous.userId) {
          for (const booking of db.bookings) if (booking.ownerId === previousToken) booking.ownerId = DEMO_USER.id;
          for (const ticket of db.tickets ?? []) if (ticket.ownerId === previousToken) ticket.ownerId = DEMO_USER.id;
          db.saved[DEMO_USER.id] = [...new Set([...(db.saved[DEMO_USER.id] ?? []), ...(db.saved[previousToken] ?? [])])];
          delete db.saved[previousToken];
        }
        if (previousToken) delete db.sessions[previousToken];
        for (const [id, session] of Object.entries(db.sessions)) if (session.expiresAt <= Date.now()) delete db.sessions[id];
        db.sessions[token] = { userId: DEMO_USER.id, expiresAt: Date.now() + SESSION_MS };
        return null;
      });
      return { token, user: DEMO_USER };
    },
    async logout(token) {
      await store.update(db => { if (token) delete db.sessions[token]; return null; });
    },
  };
}
