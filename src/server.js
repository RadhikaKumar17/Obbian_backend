import { createDemoAuth } from './demo-auth.js';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { settings } from './config.js';
import { createStore } from './store.js';
import { createService, ApiError } from './service.js';
import { createTrackingSimulator } from './tracking-simulator.js';

const SESSION_COOKIE = 'obbian_session';
const MAX_BODY_BYTES = 1_000_000;

const store = await createStore(settings.mongoUri);
const service = createService(store);
const auth = createDemoAuth(store);

const text = value => ({ __raw: value });

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function sessionCookie(token) {
  const cookie = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', `SameSite=${settings.sameSite}`, `Max-Age=${30 * 86400}`];
  if (settings.secureCookie) cookie.push('Secure');
  return cookie.join('; ');
}

function originParams(query) {
  const params = {};
  if (query.has('lat')) params.lat = query.get('lat');
  if (query.has('lng')) params.lng = query.get('lng');
  return params;
}

async function trackingWithLiveUpdates(session, bookingId, simulator) {
  const current = service.tracking(session, bookingId);
  await simulator.ensureStarted(bookingId);
  return current.bookingStatus === 'Confirmed' ? service.tracking(session, bookingId) : current;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new ApiError(413, 'Request body is too large.')); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ApiError(400, 'Request body must be valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  if (body && typeof body === 'object' && '__raw' in body) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(body.__raw);
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body ?? null));
}

function route(method, pattern, handler, options = {}) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([A-Za-z]+)/g, (_, key) => { keys.push(key); return '([^/]+)'; }) + '$');
  return { method, regex, keys, handler, admin: options.admin ?? false, status: options.status ?? 200 };
}

const subscribers = new Map();
function broadcastTracking(bookingId, payload) {
  const set = subscribers.get(bookingId);
  if (!set || !set.size) return;
  const message = JSON.stringify({ type: 'tracking', data: payload });
  for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(message);
}
const simulator = createTrackingSimulator(store, service, broadcastTracking);

const routes = [
  route('GET', '/api/auth/me', async () => null),
  route('POST', '/api/auth/login', async () => null),
  route('POST', '/api/auth/logout', async () => null),
  route('GET', '/api/health', async () => ({ ok: true })),
  route('GET', '/api/config', async () => service.config()),
  route('GET', '/api/vehicles', async ctx => service.catalog(ctx.query.get('date'), originParams(ctx.query))),
  route('GET', '/api/search', async ctx => service.search({ ...Object.fromEntries(ctx.query), ...originParams(ctx.query) })),
  route('GET', '/api/vehicles/:id/quote', async ctx => service.quote(ctx.params.id, ctx.query.get('date'))),
  route('GET', '/api/saved', async ctx => service.saved(ctx.session)),
  route('PUT', '/api/saved/:id', async ctx => service.save(ctx.session, ctx.params.id, ctx.body.save === true)),
  route('GET', '/api/bookings', async ctx => service.bookings(ctx.session)),
  route('POST', '/api/bookings', async ctx => service.createBooking(ctx.session, ctx.body, ctx.req.headers['idempotency-key']), { status: 201 }),
  route('PATCH', '/api/bookings/:id', async ctx => service.updateBooking(ctx.session, ctx.params.id, ctx.body)),
  route('GET', '/api/bookings/:id/receipt', async ctx => text(service.receipt(ctx.session, ctx.params.id))),
  route('GET', '/api/bookings/:id/tracking', async ctx => trackingWithLiveUpdates(ctx.session, ctx.params.id, simulator)),
  route('GET', '/api/policies', async () => service.policies()),
  route('GET', '/api/policies/answer', async ctx => service.answerPolicy(ctx.query.get('q'))),
  route('POST', '/api/support/tickets', async ctx => service.createTicket(ctx.session, ctx.body), { status: 201 }),
  route('GET', '/api/support/tickets', async ctx => service.tickets(ctx.session)),
  route('PATCH', '/api/admin/vehicles/:id', async ctx => service.updateVehicle(ctx.params.id, ctx.body), { admin: true }),
  route('PUT', '/api/admin/bookings/:id/tracking', async ctx => service.updateTracking(ctx.params.id, ctx.body), { admin: true }),
  route('PATCH', '/api/admin/bookings/:id/status', async ctx => service.updateStatus(ctx.params.id, ctx.body.status), { admin: true }),
];

function matchRoute(method, pathname) {
  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    const match = candidate.regex.exec(pathname);
    if (!match) continue;
    const params = {};
    candidate.keys.forEach((key, i) => { params[key] = decodeURIComponent(match[i + 1]); });
    return { ...candidate, params };
  }
  return null;
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && settings.origins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, Authorization',
    });
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (origin && !settings.origins.includes(origin)) throw new ApiError(403, 'Origin is not allowed.');
    const match = matchRoute(req.method, url.pathname);
    if (!match) throw new ApiError(404, 'Not found.');
    if (match.admin) {
      const auth = req.headers.authorization || '';
      if (!settings.adminToken || auth !== `Bearer ${settings.adminToken}`) throw new ApiError(401, 'Admin authorization required.');
    }
    res.setHeader('Cache-Control', 'no-store');
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    if (url.pathname.startsWith('/api/auth/')) {
      if (req.method === 'GET' && url.pathname === '/api/auth/me') return send(res, 200, { user: await auth.current(token) });
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const result = await auth.login(body, token);
        res.setHeader('Set-Cookie', sessionCookie(result.token));
        return send(res, 200, { user: result.user });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        await auth.logout(token);
        for (const ws of wss.clients) if (ws.sessionToken === token) ws.close(1000, 'Logged out');
        res.setHeader('Set-Cookie', sessionCookie('').replace(/Max-Age=\d+/, 'Max-Age=0'));
        return send(res, 200, { user: null });
      }
    }
    let session = null;
    if (!match.admin && url.pathname !== '/api/health') {
      const user = await auth.current(token);
      if (!user) throw new ApiError(401, 'Please log in to continue.');
      session = user.id;
    }
    const result = await match.handler({ req, params: match.params, query: url.searchParams, body, session });
    send(res, match.status, result);
  } catch (error) {
    if (error instanceof ApiError) { send(res, error.status, { error: error.message }); return; }
    console.error(error);
    send(res, 500, { error: 'Something went wrong. Please try again.' });
  }
});

const wss = new WebSocketServer({ noServer: true });
wss.on('headers', (headers, req) => { if (req.__setCookie) headers.push(`Set-Cookie: ${req.__setCookie}`); });

server.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const origin = req.headers.origin;
    if (url.pathname !== '/ws/tracking' || (origin && !settings.origins.includes(origin))) { socket.destroy(); return; }
    const cookies = parseCookies(req.headers.cookie);
    const user = await auth.current(cookies[SESSION_COOKIE]);
    if (!user) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => { ws.sessionToken = cookies[SESSION_COOKIE]; wss.emit('connection', ws, req, user.id); });
  } catch {
    socket.destroy();
  }
});

wss.on('connection', (ws, req, session) => {
  let subscribedId = null;
  ws.on('message', async raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type !== 'subscribe' || typeof message.bookingId !== 'string') return;
    try {
      if (!await auth.current(ws.sessionToken)) { ws.close(1008, 'Please log in'); return; }
      const initial = await trackingWithLiveUpdates(session, message.bookingId, simulator);
      if (subscribedId) subscribers.get(subscribedId)?.delete(ws);
      subscribedId = message.bookingId;
      if (!subscribers.has(subscribedId)) subscribers.set(subscribedId, new Set());
      subscribers.get(subscribedId).add(ws);
      ws.send(JSON.stringify({ type: 'tracking', data: initial }));
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', message: error instanceof ApiError ? error.message : 'Unable to subscribe.' }));
    }
  });
  ws.on('close', () => { if (subscribedId) subscribers.get(subscribedId)?.delete(ws); });
});

server.listen(settings.port, settings.host, () => {
  console.log(`Obbian backend listening on http://${settings.host}:${settings.port}`);
});
