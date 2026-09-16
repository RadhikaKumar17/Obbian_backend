import { destinationPoint, distanceKm } from './geo.js';

const ARRIVAL_THRESHOLD_KM = 0.05;

const toRad = deg => (deg * Math.PI) / 180;
const toDeg = rad => (rad * 180) / Math.PI;
function bearingTo(lat1, lng1, lat2, lng2) {
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Drives a booking's simulated GPS position toward its pickup point.
 * The on-map movement runs on an accelerated demo clock (arrives in ~TARGET_TICKS
 * ticks regardless of starting distance) while etaMinutes is computed from a
 * realistic city driving speed, so the displayed ETA still reads naturally.
 */
export function createTrackingSimulator(store, service, broadcast, options = {}) {
  const TICK_MS = options.tickMs ?? 2000;
  const TARGET_TICKS = options.targetTicks ?? 15;
  const DISPLAY_SPEED_KMH = options.displaySpeedKmh ?? 28;
  const ARRIVAL_TO_ACTIVE_MS = options.arrivalToActiveMs ?? 5000;
  const running = new Map();
  const stepSize = new Map();

  function stop(bookingId) {
    const handle = running.get(bookingId);
    if (handle) { clearInterval(handle); running.delete(bookingId); }
    stepSize.delete(bookingId);
  }

  async function tick(bookingId) {
    const db = store.read();
    const booking = db.bookings.find(b => b.id === bookingId);
    const current = db.tracking[bookingId];
    if (!booking || booking.status !== 'Confirmed' || !current || current.lat == null) { stop(bookingId); return; }
    const vehicle = db.vehicles.find(v => v.id === booking.vehicleId);
    const remaining = distanceKm(current.lat, current.lng, vehicle.lat, vehicle.lng);
    const stepKm = stepSize.get(bookingId) ?? remaining / TARGET_TICKS;
    let next;
    if (remaining <= Math.max(stepKm, ARRIVAL_THRESHOLD_KM)) {
      next = { status: 'Vehicle arrived', distance: 0, etaMinutes: 0, location: vehicle.pickup, lat: vehicle.lat, lng: vehicle.lng, updatedAt: new Date().toISOString() };
    } else {
      const point = destinationPoint(current.lat, current.lng, bearingTo(current.lat, current.lng, vehicle.lat, vehicle.lng), stepKm);
      const dist = remaining - stepKm;
      next = { status: 'Driver en route', distance: Math.round(dist * 10) / 10, etaMinutes: Math.max(1, Math.round((dist / DISPLAY_SPEED_KMH) * 60)), location: 'En route to pickup', lat: point.lat, lng: point.lng, updatedAt: new Date().toISOString() };
    }
    await store.update(db2 => { db2.tracking[bookingId] = next; return null; });
    broadcast(bookingId, { bookingId, bookingStatus: booking.status, ...next });
    if (next.status === 'Vehicle arrived') {
      stop(bookingId);
      setTimeout(async () => {
        try {
          await service.updateStatus(bookingId, 'Active');
          broadcast(bookingId, { bookingId, bookingStatus: 'Active', ...next });
        } catch { /* booking may have been cancelled while the driver was en route */ }
      }, ARRIVAL_TO_ACTIVE_MS);
    }
  }

  return {
    async ensureStarted(bookingId) {
      if (running.has(bookingId)) return;
      const db = store.read();
      const booking = db.bookings.find(b => b.id === bookingId);
      if (!booking || booking.status !== 'Confirmed') return;
      const vehicle = db.vehicles.find(v => v.id === booking.vehicleId);
      const existing = db.tracking[bookingId];
      let startDistance;
      if (existing?.lat != null) {
        startDistance = distanceKm(existing.lat, existing.lng, vehicle.lat, vehicle.lng);
      } else {
        startDistance = 1.5 + Math.random() * 2;
        const start = destinationPoint(vehicle.lat, vehicle.lng, Math.random() * 360, startDistance);
        const initial = { status: 'Driver en route', distance: Math.round(startDistance * 10) / 10, etaMinutes: Math.max(1, Math.round((startDistance / DISPLAY_SPEED_KMH) * 60)), location: 'En route to pickup', lat: start.lat, lng: start.lng, updatedAt: new Date().toISOString() };
        await store.update(db2 => { db2.tracking[bookingId] = initial; return null; });
        broadcast(bookingId, { bookingId, bookingStatus: booking.status, ...initial });
      }
      stepSize.set(bookingId, Math.max(startDistance / TARGET_TICKS, 0.01));
      running.set(bookingId, setInterval(() => { tick(bookingId).catch(error => console.error(error)); }, TICK_MS));
    },
    stop,
  };
}
