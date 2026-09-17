import { randomUUID } from 'node:crypto';
import { settings } from './config.js';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_vehicles',
      description: "Search Obbian's available rental vehicles near the user, filtered by type, transmission and budget.",
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Vehicle category such as SUV, Sedan or Hatchback' },
          transmission: { type: 'string', enum: ['Automatic', 'Manual'] },
          budget: { type: 'number', description: 'Maximum price per day in INR' },
          radius: { type: 'number', description: 'Search radius in km' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_vehicle_quote',
      description: 'Get the price, insurance and availability for one specific vehicle by its catalog id.',
      parameters: {
        type: 'object',
        properties: { vehicleId: { type: 'string', description: 'The vehicle id from the catalog list below' } },
        required: ['vehicleId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_trips',
      description: "Show the user's current and past bookings.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'track_vehicle',
      description: "Show live GPS tracking and ETA for the user's booking. The system already knows which booking to track, so call this with an empty bookingId unless the user explicitly names a booking id.",
      parameters: {
        type: 'object',
        properties: { bookingId: { type: 'string', description: 'Leave empty unless the user explicitly stated a booking id' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_policy',
      description: 'Answer a question about rental policy: cancellation, refunds, insurance, security deposit, fuel or late returns.',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    },
  },
];

function money(n) { return `₹${n}`; }

function systemPrompt(context, vehicles) {
  const catalog = vehicles.map(v => `${v.id}: ${v.name} (${v.category}, ${v.transmission}, ${money(v.price)}/day)`).join('\n');
  return [
    'You are the Obbian rental assistant. You help users find, price and book rental vehicles, view their trips, track a vehicle, or answer rental policy questions.',
    "Always respond by calling exactly one tool that best matches the user's latest message; never answer from memory or invent prices, availability or policy text.",
    `Current search context: date=${context.date || 'unset'}, budget=${money(context.budget || 0)}, radius=${context.radius || 0}km, category=${context.category || 'any'}, transmission=${context.transmission || 'any'}.`,
    context.vehicleId ? `The user currently has vehicle "${context.vehicleId}" selected.` : '',
    context.bookingId ? `The user's most relevant booking id is ${context.bookingId}.` : '',
    'Vehicle catalog:',
    catalog || '(no vehicles available)',
  ].filter(Boolean).join('\n');
}

async function callGroq(messages) {
  let response;
  try {
    response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.groqApiKey}` },
      body: JSON.stringify({ model: settings.assistantModel, messages, tools: TOOLS, tool_choice: 'required', temperature: 0 }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new Error('assistant_unavailable');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (body?.error?.code === 'tool_use_failed') return { clarification: body.error.failed_generation };
    throw new Error('assistant_unavailable');
  }
  return body;
}

function fallback(answer) {
  return { tool: 'fallback', answer, request_id: randomUUID(), actions: [] };
}

function matchCasing(value, knownValues) {
  if (!value) return value;
  const match = knownValues.find(known => known.toLowerCase() === String(value).toLowerCase());
  return match || value;
}

function handleSearch(args, context, service, vehicles) {
  const categories = [...new Set(vehicles.map(v => v.category))];
  const transmissions = [...new Set(vehicles.map(v => v.transmission))];
  const params = {
    date: context.date,
    sort: 'recommended',
    budget: args.budget ?? context.budget,
    radius: args.radius ?? context.radius,
    category: matchCasing(args.category ?? context.category, categories),
    transmission: matchCasing(args.transmission ?? context.transmission, transmissions),
    lat: context.lat,
    lng: context.lng,
  };
  const result = service.search(params);
  const top = result.results[0];
  const lowest = result.results.length ? Math.min(...result.results.map(v => v.price)) : null;
  const answer = result.count
    ? `Found ${result.count} vehicle${result.count > 1 ? 's' : ''} within ${params.radius}km, from ${money(lowest)}/day.` +
      (top ? ` Top pick: ${top.name} at ${money(top.price)}/day, ${top.distance}km away.` : '')
    : `No vehicles matched that search within ${params.radius}km under ${money(params.budget)}/day. Try a wider radius or a higher budget.`;
  return {
    tool: 'search',
    answer,
    request_id: randomUUID(),
    vehicles: result.results.slice(0, 5),
    filters: {
      date: params.date,
      budget: String(params.budget),
      radius: String(params.radius),
      category: params.category || '',
      transmission: params.transmission || '',
    },
    actions: [
      { type: 'search', label: 'See all results' },
      ...(top ? [{ type: 'vehicle', label: `View ${top.name}`, vehicleId: top.id }] : []),
    ],
  };
}

function handleQuote(args, context, service) {
  const info = service.vehicleInfo(args.vehicleId);
  const quote = service.quote(args.vehicleId, context.date);
  const answer = quote.available
    ? `${info.name}: ${money(quote.rental)} rental + ${money(quote.insurance)} insurance = ${money(quote.total)} total for ${quote.date}, pickup at ${info.pickup}.`
    : `${info.name} is not available on ${quote.date}. Try a different date.`;
  return {
    tool: 'quote',
    answer,
    request_id: randomUUID(),
    quote,
    actions: [
      { type: 'vehicle', label: 'View vehicle', vehicleId: args.vehicleId },
      ...(quote.available ? [{ type: 'checkout', label: 'Book now', vehicleId: args.vehicleId, date: quote.date }] : []),
    ],
  };
}

function handleTrips(session, service) {
  const trips = service.bookings(session);
  const counts = trips.reduce((acc, t) => ({ ...acc, [t.status]: (acc[t.status] || 0) + 1 }), {});
  const summary = Object.entries(counts).map(([status, n]) => `${n} ${status.toLowerCase()}`).join(', ');
  const answer = trips.length ? `You have ${trips.length} trip${trips.length > 1 ? 's' : ''}: ${summary}.` : "You don't have any trips yet.";
  return { tool: 'trips', answer, request_id: randomUUID(), actions: [{ type: 'trips', label: 'View trips' }] };
}

function handleTracking(session, args, context, service) {
  let bookingId = args.bookingId || context.bookingId;
  if (!bookingId) {
    const trips = service.bookings(session);
    const active = trips.find(t => t.status === 'Active') || trips.find(t => t.status === 'Confirmed');
    bookingId = active?.id;
  }
  if (!bookingId) return fallback("You don't have an active booking to track yet.");
  const info = service.tracking(session, bookingId);
  const answer = info.status === 'Awaiting location'
    ? `No live location yet for this booking (status: ${info.bookingStatus}).`
    : `${info.location || 'En route'} — ${info.distance != null ? `${info.distance}km away, ` : ''}${info.etaMinutes != null ? `ETA ${info.etaMinutes} min.` : ''}`;
  return { tool: 'tracking', answer, request_id: randomUUID(), actions: [{ type: 'tracking', label: 'Track live', bookingId }] };
}

async function handlePolicy(args, service) {
  const result = await service.askPolicy(args.question);
  return {
    tool: 'policy',
    answer: result.answer,
    request_id: result.request_id,
    trace_id: result.trace_id ?? null,
    status: result.status,
    citations: result.citations,
    actions: [],
  };
}

export async function runAssistant({ session, message, history, context, service }) {
  if (typeof message !== 'string' || !message.trim() || message.length > 2000) {
    return fallback('Ask a question about vehicles, trips, tracking or rental policy.');
  }
  const safeHistory = Array.isArray(history)
    ? history.filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content.slice(0, 600) }))
    : [];
  const vehicles = service.vehicleCatalog();
  const messages = [
    { role: 'system', content: systemPrompt(context, vehicles) },
    ...safeHistory.slice(-6),
    { role: 'user', content: message },
  ];
  let completion;
  try {
    completion = await callGroq(messages);
  } catch {
    return fallback('The assistant is temporarily unavailable. Please retry.');
  }
  if (completion.clarification) return fallback(completion.clarification);
  const call = completion.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) return fallback("I'm not sure how to help with that — try asking to search for a vehicle, check a price, view your trips, track your vehicle, or ask a policy question.");
  let args;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return fallback('I had trouble understanding that request. Could you rephrase it?');
  }
  try {
    switch (call.function.name) {
      case 'search_vehicles':
        return handleSearch(args, context, service, vehicles);
      case 'get_vehicle_quote':
        return handleQuote(args, context, service);
      case 'list_trips':
        return handleTrips(session, service);
      case 'track_vehicle':
        return handleTracking(session, args, context, service);
      case 'ask_policy':
        return await handlePolicy(args, service);
      default:
        return fallback("I'm not sure how to help with that.");
    }
  } catch (error) {
    return fallback(error?.message && error.status ? error.message : 'I could not complete that request. Please try again.');
  }
}
