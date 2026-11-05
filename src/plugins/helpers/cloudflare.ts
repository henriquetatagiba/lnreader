import NativeCloudflare, {
  CloudflareSolveRequest,
  CloudflareSolveResult,
} from '@modules/native-cloudflare';

const SOLVE_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_LENGTH = 10 * 1024 * 1024;
// A challenge the hidden WebView could not clear (interactive Turnstile, IP
// block) fails the same way on the next request, so a library update must not
// spend the full timeout again for every novel from that site.
const FAILURE_COOLDOWN_MS = 5 * 60_000;

// The WebView sends its own cookies, user agent and connection headers.
const WEBVIEW_UNSAFE_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'host',
  'keep-alive',
  'origin',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
]);

const FAILED: CloudflareSolveResult = { type: 'failed' };

type SolveResult = { solved: boolean; at: number };

const inFlightSolves = new Map<string, Promise<CloudflareSolveResult>>();
const lastResults = new Map<string, SolveResult>();
const hostQueues = new Map<string, Promise<unknown>>();
const webViewResponses = new WeakSet<Response>();

/**
 * `cf-mitigated: challenge` is Cloudflare's documented marker for a challenge page:
 * https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/
 */
export const isCloudflareChallenge = (response: Response) =>
  response.headers.get('cf-mitigated') === 'challenge';

const getHost = (url: string) => {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
};

// cf_clearance is one cookie per host, so solves for different User-Agents on
// a host must not run at once: one WebView would take the other's new cookie
// for its own clearance.
const runOnHost = <T>(host: string, task: () => Promise<T>) => {
  const previous = hostQueues.get(host) ?? Promise.resolve();
  const result = previous.then(task, task);
  const tail = result.catch(() => undefined);
  hostQueues.set(host, tail);
  tail.then(() => {
    if (hostQueues.get(host) === tail) {
      hostQueues.delete(host);
    }
  });
  return result;
};

const toWebViewHeaders = (headers: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !WEBVIEW_UNSAFE_HEADERS.has(name) && !name.startsWith('proxy-'),
    ),
  );

export type ChallengeRequest = Pick<
  CloudflareSolveRequest,
  'url' | 'method' | 'body' | 'captureResponse' | 'userAgent'
> & {
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** When the challenged request was sent, from `Date.now()`. */
  sentAt: number;
};

/**
 * Solves the Cloudflare challenge for a request in a hidden WebView. At most one
 * solve runs per host and User-Agent; a clearance or failure is shared with the
 * requests that waited on it, while a WebView response answers only its own
 * request.
 *
 * `userAgent` must match the User-Agent of the request being retried, because
 * Cloudflare binds `cf_clearance` to it.
 */
export const solveCloudflareChallenge = async (
  request: ChallengeRequest,
): Promise<CloudflareSolveResult> => {
  const host = getHost(request.url);
  const nativeModule = NativeCloudflare;
  if (!nativeModule || !host) {
    return FAILED;
  }
  // cf_clearance is bound to the User-Agent, so a clearance (or failure) for
  // one User-Agent says nothing about another on the same host.
  const key = `${host}\n${request.userAgent}`;

  const inFlight = inFlightSolves.get(key);
  if (inFlight) {
    const shared = await inFlight;
    return shared.type === 'response'
      ? solveCloudflareChallenge(request)
      : shared;
  }
  const lastResult = lastResults.get(key);
  if (lastResult?.solved) {
    // A request sent before the clearance was issued only missed the cookie.
    // One sent after it was challenged anyway, so the cookie no longer works
    // (cleared, expired, or the network changed) and must be solved again.
    if (request.sentAt < lastResult.at) {
      return { type: 'clearance' };
    }
  } else if (lastResult && Date.now() - lastResult.at < FAILURE_COOLDOWN_MS) {
    return FAILED;
  }

  const { sentAt: _sentAt, ...nativeRequest } = request;
  const solve = runOnHost(host, () =>
    nativeModule.solveChallenge({
      ...nativeRequest,
      headers: toWebViewHeaders(request.headers),
      timeoutMs: SOLVE_TIMEOUT_MS,
      maxResponseLength: MAX_RESPONSE_LENGTH,
    }),
  )
    .catch(() => FAILED)
    .then(result => {
      if (result.type !== 'response') {
        lastResults.set(key, {
          solved: result.type === 'clearance',
          at: Date.now(),
        });
      }
      inFlightSolves.delete(key);
      return result;
    });
  inFlightSolves.set(key, solve);
  return solve;
};

/**
 * Whether the body is text the WebView already decoded with the page's charset,
 * so it must not be decoded again with another encoding.
 */
export const isWebViewResponse = (response: Response) =>
  webViewResponses.has(response);

export const toWebViewResponse = (
  result: Extract<CloudflareSolveResult, { type: 'response' }>,
) => {
  // A string body: React Native's fetch polyfill reads ArrayBuffer bodies as
  // Latin-1 in text() and cannot build a Blob from them.
  const response = new Response(result.body || null, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
  Object.defineProperty(response, 'url', { value: result.url });
  webViewResponses.add(response);
  return response;
};
