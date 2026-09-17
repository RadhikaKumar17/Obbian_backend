import { randomUUID, randomBytes } from 'node:crypto';
import { distanceKm, isValidCoordinate } from './geo.js';
import { askRag } from './rag-client.js';
import { rememberChat, recallChat } from './memory.js';

const round1 = n => Math.round(n * 10) / 10;

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new ApiError(status, message); };
export function businessDate(config, offset = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function dateValue(value, config) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, 'A valid pickup date is required.');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value < businessDate(config)) fail(400, 'Pickup date must be a valid date today or later.');
  return value;
}
function text(value, label, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(400, `${label} must contain ${min}–${max} characters.`);
  return value.trim();
}
function vehicle(db, id) { return db.vehicles.find(item => item.id === id) || fail(404, 'Vehicle not found.'); }
function ownedBooking(db, session, id) { return db.bookings.find(item => item.id === id && item.ownerId === session) || fail(404, 'Booking not found.'); }
function available(db, id, date, excludeId) {
  return vehicle(db, id).available && !db.bookings.some(b => b.id !== excludeId && b.vehicleId === id && b.date === date && ['Confirmed', 'Active'].includes(b.status));
}
function publicBooking(b) {
  const { ownerId, mobile, licence, idempotencyKey, ...result } = b;
  return result;
}
function quote(db, vehicleId, date, excludeId) {
  const v = vehicle(db, vehicleId);
  dateValue(date, db.config);
  return { vehicleId, date, rental: v.price, insurance: db.config.insuranceFee, total: v.price + db.config.insuranceFee, currency: db.config.currency, available: available(db, vehicleId, date, excludeId), pickup: v.pickup, timeLabel: db.config.timeLabel, paymentMethods: db.config.paymentMethods };
}
function resolveOrigin(db, params = {}) {
  const lat = Number(params.lat), lng = Number(params.lng);
  if (params.lat !== undefined || params.lng !== undefined) {
    if (!isValidCoordinate(lat, lng)) fail(400, 'lat and lng must be valid coordinates.');
    return { lat, lng };
  }
  return { lat: db.config.originLat, lng: db.config.originLng };
}
function withDistance(vehicles, origin) {
  return vehicles.map(v => ({ ...v, distance: round1(distanceKm(origin.lat, origin.lng, v.lat, v.lng)), distanceMeters: distanceKm(origin.lat, origin.lng, v.lat, v.lng) * 1000 }));
}
export function createService(store) {
  return {
    async session(token) {
      const session = token && store.read().sessions[token];
      if (session && session.expiresAt > Date.now()) return { token, created: false };
      const id = randomBytes(32).toString('hex');
      await store.update(db => {
        for (const [key, value] of Object.entries(db.sessions)) if (value.expiresAt <= Date.now()) delete db.sessions[key];
        db.sessions[id] = { expiresAt: Date.now() + 30 * 86400000 };
        return null;
      });
      return { token: id, created: true };
    },
    config() { const { config } = store.read(); return { ...config, today: businessDate(config), defaultDate: businessDate(config, 1) }; },
    catalog(date, originParams) {
      const db = store.read();
      dateValue(date, db.config);
      const origin = resolveOrigin(db, originParams);
      return withDistance(db.vehicles, origin).map(v => ({ ...v, available: available(db, v.id, date) }));
    },
    search(params) {
      const db = store.read();
      const date = dateValue(params.date || businessDate(db.config, 1), db.config);
      const budget = Number(params.budget ?? db.config.defaultBudget);
      const radius = Number(params.radius ?? db.config.defaultRadius);
      const sort = params.sort || db.config.defaultSort;
      if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(radius) || radius <= 0) fail(400, 'Budget and radius must be positive numbers.');
      if (!db.config.sortOptions.some(option => option.value === sort)) fail(400, 'Invalid sort order.');
      const origin = resolveOrigin(db, params);
      const results = withDistance(db.vehicles, origin).filter(v => available(db, v.id, date) && v.price <= budget && v.distanceMeters <= radius * 1000 && (!params.category || v.category.toLowerCase() === String(params.category).toLowerCase()) && (!params.transmission || v.transmission.toLowerCase() === String(params.transmission).toLowerCase()))
        .sort((a, b) => sort === 'price' ? a.price - b.price : sort === 'rating' ? b.rating - a.rating : a.distance - b.distance || b.rating - a.rating);
      return { results, recommendedId: results[0]?.id ?? null, count: results.length, origin };
    },
    quote(vehicleId, date) { return quote(store.read(), vehicleId, date); },
    saved(session) { return store.read().saved[session] || []; },
    save(session, id, save) { return store.update(db => { vehicle(db, id); const ids = new Set(db.saved[session] || []); if (save) ids.add(id); else ids.delete(id); db.saved[session] = [...ids]; return db.saved[session]; }); },
    bookings(session) { return store.read().bookings.filter(b => b.ownerId === session).map(publicBooking); },
    createBooking(session, input, idempotencyKey) {
      return store.update(db => {
        if (!idempotencyKey || !/^[\w-]{8,100}$/.test(idempotencyKey)) fail(400, 'A valid Idempotency-Key header is required.');
        const previous = db.bookings.find(b => b.ownerId === session && b.idempotencyKey === idempotencyKey);
        if (previous) return publicBooking(previous);
        const price = quote(db, input.vehicleId, input.date);
        if (!price.available) fail(409, 'This vehicle is no longer available on that date.');
        if (input.termsAccepted !== true) fail(400, 'Accept the rental terms to continue.');
        if (!db.config.paymentMethods.some(method => method.value === input.paymentMethod)) fail(400, 'Choose a supported payment method.');
        const name = text(input.name, 'Full name', 2, 80);
        const mobile = text(input.mobile, 'Mobile number', 10, 14);
        if (!/^\+?\d{10,13}$/.test(mobile)) fail(400, 'Enter a valid mobile number.');
        const licence = text(input.licence, 'Driving licence', 6, 24);
        const v = vehicle(db, input.vehicleId);
        const b = { id: `OBB-${randomUUID()}`, ownerId: session, vehicleId: v.id, vehicleName: v.name, date: price.date, name, mobile, licence, rental: price.rental, insurance: price.insurance, total: price.total, currency: price.currency, pickup: price.pickup, timeLabel: price.timeLabel, status: 'Confirmed', paymentMethod: input.paymentMethod, paymentStatus: 'Due at pickup', createdAt: new Date().toISOString(), idempotencyKey };
        db.bookings.unshift(b);
        return publicBooking(b);
      });
    },
    updateBooking(session, id, input) {
      return store.update(db => {
        const b = ownedBooking(db, session, id);
        if (input.action === 'cancel') {
          if (b.status === 'Cancelled') return publicBooking(b);
          if (b.status !== 'Confirmed') fail(409, 'Only upcoming bookings can be cancelled.');
          b.status = 'Cancelled'; b.paymentStatus = 'Cancelled'; delete db.tracking[id];
        } else if (input.action === 'reschedule') {
          if (b.status !== 'Confirmed') fail(409, 'Only upcoming bookings can be rescheduled.');
          dateValue(input.date, db.config);
          if (!available(db, b.vehicleId, input.date, b.id)) fail(409, 'This vehicle is unavailable on the new date.');
          b.date = input.date; delete db.tracking[id];
        } else if (input.action === 'complete') {
          if (b.status !== 'Active') fail(409, 'Only an active trip can be completed.');
          b.status = 'Completed'; b.paymentStatus = 'Paid at pickup'; delete db.tracking[id];
        } else fail(400, 'Choose cancel, reschedule or complete.');
        b.updatedAt = new Date().toISOString();
        return publicBooking(b);
      });
    },
    receipt(session, id) {
      const b = ownedBooking(store.read(), session, id);
      return `OBBIAN — RESERVATION RECEIPT\nBooking: ${b.id}\nVehicle: ${b.vehicleName}\nDate: ${b.date}\nTime: ${b.timeLabel}\nPickup: ${b.pickup}\nDriver: ${b.name}\nStatus: ${b.status}\nRental: INR ${b.rental}\nInsurance: INR ${b.insurance}\nTotal: INR ${b.total}\nPayment: ${b.paymentStatus}\nThis receipt does not confirm payment.\n`;
    },
    tracking(session, id) {
      const db = store.read(); const b = ownedBooking(db, session, id);
      return { bookingId: id, bookingStatus: b.status, ...(db.tracking[id] || { status: 'Awaiting location', distance: null, etaMinutes: null, location: null, lat: null, lng: null, updatedAt: null }) };
    },
    createTicket(session, input) {
      return store.update(db => {
        const email = text(input.email, 'Email', 3, 254);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
        const message = text(input.message, 'Message', 10, 5000);
        if (input.bookingId) ownedBooking(db, session, input.bookingId);
        const ticket = { id: `SUP-${randomUUID()}`, ownerId: session, email, message, bookingId: input.bookingId || null, status: 'Open', createdAt: new Date().toISOString() };
        db.tickets.unshift(ticket);
        const { ownerId, ...result } = ticket; return result;
      });
    },
    tickets(session) { return store.read().tickets.filter(t => t.ownerId === session).map(({ ownerId, ...ticket }) => ticket); },
    policies() { return store.read().policies.map(({ keywords, ...policy }) => policy); },
    askPolicy(question) {
      const q = text(question, 'Question', 1, 2000);
      return askRag(q);
    },
    vehicleCatalog() {
      return store.read().vehicles.map(({ id, name, category, transmission, price }) => ({ id, name, category, transmission, price }));
    },
    vehicleInfo(id) {
      const v = vehicle(store.read(), id);
      return { id: v.id, name: v.name, category: v.category, transmission: v.transmission, price: v.price, pickup: v.pickup };
    },
    recordPolicyChat(session, question, answer) { return rememberChat(session, 'policy', question, answer.answer, answer); },
    recordAssistantChat(session, message, reply) { return rememberChat(session, 'assistant', message, reply.answer, reply); },
    policyChatHistory(session) { return recallChat(session, 'policy'); },
    assistantChatHistory(session) { return recallChat(session, 'assistant'); },
    updateVehicle(id, input) {
      return store.update(db => {
        const v = vehicle(db, id);
        const numeric = { price: [0, 10000000], lat: [-90, 90], lng: [-180, 180], rating: [0, 5], seats: [1, 100], trips: [0, 10000000] };
        const strings = ['name', 'category', 'transmission', 'fuel', 'pickup'];
        const allowed = [...Object.keys(numeric), ...strings, 'available'];
        if (!Object.keys(input).length || Object.keys(input).some(key => !allowed.includes(key))) fail(400, 'Unsupported vehicle fields.');
        for (const [key, value] of Object.entries(input)) {
          if (numeric[key]) {
            if (typeof value !== 'number' || !Number.isFinite(value) || value < numeric[key][0] || value > numeric[key][1]) fail(400, `Invalid ${key}.`);
          } else if (key === 'available') { if (typeof value !== 'boolean') fail(400, 'available must be a boolean.'); }
          else text(value, key, 1, 200);
          v[key] = value;
        }
        return v;
      });
    },
    updateTracking(id, input) {
      return store.update(db => {
        const b = db.bookings.find(b => b.id === id) || fail(404, 'Booking not found.');
        if (!['Confirmed', 'Active'].includes(b.status)) fail(409, 'Tracking cannot be updated for this booking.');
        if (!['Driver en route', 'Vehicle arrived'].includes(input.status)) fail(400, 'Invalid tracking status.');
        for (const key of ['distance', 'etaMinutes']) if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0) fail(400, `Invalid ${key}.`);
        db.tracking[id] = { status: input.status, distance: input.distance, etaMinutes: input.etaMinutes, location: text(input.location, 'Location', 1, 200), updatedAt: new Date().toISOString() };
        return db.tracking[id];
      });
    },
    updateStatus(id, status) {
      return store.update(db => {
        const b = db.bookings.find(b => b.id === id) || fail(404, 'Booking not found.');
        const transitions = { Confirmed: ['Active'], Active: ['Completed'] };
        if (!transitions[b.status]?.includes(status)) fail(409, 'Invalid booking status transition.');
        b.status = status; b.updatedAt = new Date().toISOString(); return publicBooking(b);
      });
    },
  };
}
