import type { FetchLike } from '../src/index.js';

export interface FakeRequest {
  method: string;
  url: string;
  body: unknown;
}

type Route = (request: FakeRequest) => unknown;

/**
 * A `fetch` that answers from `routes` (matched by URL prefix, longest first) and records requests.
 * A route returning `undefined` answers 404; a `Response` is passed through as is.
 */
export function fakeFetch(routes: Record<string, Route>): FetchLike & { requests: FakeRequest[] } {
  const prefixes = Object.keys(routes).sort((a, b) => b.length - a.length);
  const requests: FakeRequest[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const request = {
      method: init?.method ?? 'GET',
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const prefix = prefixes.find((p) => url.startsWith(p));
    const result = prefix === undefined ? undefined : routes[prefix]!(request);
    if (result instanceof Response) return result;
    if (result === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(result), { status: 200 });
  };
  return Object.assign(fetch, { requests });
}
