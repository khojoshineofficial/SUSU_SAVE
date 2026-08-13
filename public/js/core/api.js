/**
 * API client.
 *
 * The access token lives in memory only; the refresh token is an httpOnly
 * cookie the page script cannot read. On a 401 the client silently refreshes
 * once and replays the request, so a expired access token is invisible to the UI.
 */

const BASE = '/api';

let accessToken = null;
let refreshing = null;

export const setToken = (token) => { accessToken = token; };
export const getToken = () => accessToken;
export const clearToken = () => { accessToken = null; };

export class ApiError extends Error {
  constructor(message, { status, errorCode, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.details = details;
  }
}

async function refreshSession() {
  if (!refreshing) {
    refreshing = fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new ApiError('Session expired', { status: 401, errorCode: 'SESSION_EXPIRED' });
        const body = await res.json();
        accessToken = body.data.accessToken;
        return body.data;
      })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function call(method, path, { body, query, headers = {}, retry = true, raw = false } = {}) {
  const url = new URL(BASE + path, window.location.origin);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });

  const options = {
    method,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  const response = await fetch(url, options);

  if (response.status === 401 && retry && !path.startsWith('/auth/')) {
    try {
      await refreshSession();
      return call(method, path, { body, query, headers, retry: false, raw });
    } catch {
      window.dispatchEvent(new CustomEvent('susu:session-expired'));
      throw new ApiError('Your session has expired. Please sign in again.', { status: 401, errorCode: 'SESSION_EXPIRED' });
    }
  }

  if (raw) return response;

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new ApiError(payload.message || `Request failed (${response.status})`, {
      status: response.status,
      errorCode: payload.errorCode,
      details: payload.details,
    });
  }
  return payload.data;
}

export const api = {
  get: (path, query, opts) => call('GET', path, { query, ...opts }),
  post: (path, body, opts) => call('POST', path, { body, ...opts }),
  patch: (path, body, opts) => call('PATCH', path, { body, ...opts }),
  put: (path, body, opts) => call('PUT', path, { body, ...opts }),
  del: (path, opts) => call('DELETE', path, opts),
  refreshSession,
};

/**
 * Restores a session on page load using the refresh cookie. Returns the user or
 * null — callers decide whether to redirect.
 */
export async function bootstrapSession() {
  try {
    const data = await refreshSession();
    return data.user;
  } catch {
    return null;
  }
}
