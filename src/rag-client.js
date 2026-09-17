import { settings } from './config.js';
import { ApiError } from './service.js';

export async function askRag(question) {
  if (!settings.ragServiceUrl || !settings.ragApiKey) {
    throw new ApiError(503, 'The policy assistant is not configured.');
  }
  let response;
  try {
    response = await fetch(`${settings.ragServiceUrl}/v1/answer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.ragApiKey}`,
      },
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new ApiError(503, 'The policy assistant is temporarily unavailable. Please retry.');
  }
  if (response.status === 429) throw new ApiError(429, 'Too many questions right now. Please wait a moment.');
  if (!response.ok) throw new ApiError(503, 'The policy assistant is temporarily unavailable. Please retry.');
  return response.json();
}
