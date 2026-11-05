import NativeCloudflare from '@modules/native-cloudflare';

jest.mock('@modules/native-cloudflare', () => ({
  __esModule: true,
  default: { solveChallenge: jest.fn() },
}));

jest.mock('@hooks/persisted/useUserAgent', () => ({
  getUserAgent: () => 'LNReader test',
}));

const solveChallenge = NativeCloudflare!.solveChallenge as jest.Mock;
const fetchMock = jest.fn();

const response = (status: number, headers: Record<string, string> = {}) =>
  ({ status, ok: status < 400, headers: new Headers(headers) } as Response);

const challenge = () =>
  response(403, { 'cf-mitigated': 'challenge', 'server': 'cloudflare' });

const CLEARANCE = { type: 'clearance' as const };
const FAILED = { type: 'failed' as const };

const webViewResponse = (body: string, url = 'https://site.test/novel') => ({
  type: 'response' as const,
  status: 200,
  statusText: 'OK',
  url,
  headers: { 'content-type': 'text/html' },
  body,
});

const textResponse = (text: string) =>
  ({ ...response(200), blob: async () => ({ text }) } as unknown as Response);

// React Native's FileReader needs the native blob module, which Jest lacks.
class TextFileReader {
  result: string | null = null;
  onloadend?: () => void;
  readAsText(blob: { text: string }) {
    this.result = blob.text;
    this.onloadend?.();
  }
}

// The solver keeps per-host state at module level, so each test gets a fresh copy.
const loadFetch = () => {
  let fetchModule!: typeof import('../fetch');
  jest.isolateModules(() => {
    fetchModule = require('../fetch');
  });
  return fetchModule;
};
const loadFetchApi = () => loadFetch().fetchApi;

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock;
});

describe('fetchApi Cloudflare bypass', () => {
  it('returns normal responses without starting a solve', async () => {
    const ok = response(200);
    fetchMock.mockResolvedValue(ok);

    await expect(loadFetchApi()('https://site.test/novel')).resolves.toBe(ok);
    expect(solveChallenge).not.toHaveBeenCalled();
  });

  it('does not treat a plain 403 as a challenge', async () => {
    const forbidden = response(403, { server: 'cloudflare' });
    fetchMock.mockResolvedValue(forbidden);

    await expect(loadFetchApi()('https://site.test/novel')).resolves.toBe(
      forbidden,
    );
    expect(solveChallenge).not.toHaveBeenCalled();
  });

  it('solves the challenge with the request user agent and retries', async () => {
    const ok = response(200);
    fetchMock.mockResolvedValueOnce(challenge()).mockResolvedValueOnce(ok);
    solveChallenge.mockResolvedValue(CLEARANCE);

    const result = await loadFetchApi()('https://site.test/novel', {
      headers: { 'user-agent': 'Plugin UA' },
    });

    expect(result).toBe(ok);
    expect(solveChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://site.test/novel',
        method: 'GET',
        userAgent: 'Plugin UA',
        timeoutMs: expect.any(Number),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns the challenge response when it cannot be solved', async () => {
    const blocked = challenge();
    fetchMock.mockResolvedValue(blocked);
    solveChallenge.mockResolvedValue(FAILED);

    await expect(loadFetchApi()('https://site.test/novel')).resolves.toBe(
      blocked,
    );
    expect(solveChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ userAgent: 'LNReader test' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a solver error as unsolved', async () => {
    const blocked = challenge();
    fetchMock.mockResolvedValue(blocked);
    solveChallenge.mockRejectedValue(new Error('WebView unavailable'));

    await expect(loadFetchApi()('https://site.test/novel')).resolves.toBe(
      blocked,
    );
  });

  it('shares one solve between concurrent requests to the same host', async () => {
    fetchMock.mockImplementation(async () =>
      solveChallenge.mock.calls.length ? response(200) : challenge(),
    );
    let finishSolve!: (result: typeof CLEARANCE) => void;
    solveChallenge.mockReturnValue(
      new Promise(resolve => (finishSolve = resolve)),
    );
    const fetchApi = loadFetchApi();

    const requests = Promise.all([
      fetchApi('https://site.test/chapter/1'),
      fetchApi('https://site.test/chapter/2'),
      fetchApi('https://site.test/chapter/3'),
    ]);
    await new Promise(setImmediate);
    finishSolve(CLEARANCE);
    const results = await requests;

    expect(solveChallenge).toHaveBeenCalledTimes(1);
    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
  });

  it('reuses a clearance for a request sent before it was issued', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      let answerSlowRequest!: (result: Response) => void;
      let finishSolve!: (result: typeof CLEARANCE) => void;
      fetchMock
        .mockResolvedValueOnce(challenge())
        .mockReturnValueOnce(
          new Promise<Response>(resolve => (answerSlowRequest = resolve)),
        )
        .mockResolvedValue(response(200));
      solveChallenge.mockReturnValueOnce(
        new Promise(resolve => (finishSolve = resolve)),
      );
      const fetchApi = loadFetchApi();

      const first = fetchApi('https://site.test/chapter/1');
      const second = fetchApi('https://site.test/chapter/2');
      await new Promise(setImmediate);
      now.mockReturnValue(2_000);
      finishSolve(CLEARANCE);
      await first;
      answerSlowRequest(challenge());

      expect((await second).status).toBe(200);
      expect(solveChallenge).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it('solves again when a request is challenged after the last clearance', async () => {
    fetchMock.mockResolvedValue(challenge());
    solveChallenge.mockResolvedValue(CLEARANCE);
    const fetchApi = loadFetchApi();

    await fetchApi('https://site.test/novel/1');
    await fetchApi('https://site.test/novel/2');

    expect(solveChallenge).toHaveBeenCalledTimes(2);
  });

  it('does not retry a failed host until the cooldown passes', async () => {
    jest.useFakeTimers({ now: 0 });
    try {
      fetchMock.mockResolvedValue(challenge());
      solveChallenge.mockResolvedValue(FAILED);
      const fetchApi = loadFetchApi();

      await fetchApi('https://site.test/novel/1');
      await fetchApi('https://site.test/novel/2');
      expect(solveChallenge).toHaveBeenCalledTimes(1);

      await fetchApi('https://other.test/novel');
      expect(solveChallenge).toHaveBeenCalledTimes(2);

      jest.setSystemTime(5 * 60_000);
      await fetchApi('https://site.test/novel/3');
      expect(solveChallenge).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps solves for different user agents on the same host apart', async () => {
    fetchMock.mockResolvedValue(challenge());
    solveChallenge.mockResolvedValue(FAILED);
    const fetchApi = loadFetchApi();

    await fetchApi('https://site.test/novel/1');
    await fetchApi('https://site.test/novel/2', {
      headers: { 'User-Agent': 'Plugin UA' },
    });

    expect(
      solveChallenge.mock.calls.map(([request]) => request.userAgent),
    ).toEqual(['LNReader test', 'Plugin UA']);
  });

  it('runs solves for different user agents on one host one at a time', async () => {
    fetchMock.mockResolvedValue(challenge());
    let finishFirst!: (result: typeof FAILED) => void;
    solveChallenge
      .mockReturnValueOnce(new Promise(resolve => (finishFirst = resolve)))
      .mockResolvedValue(FAILED);
    const fetchApi = loadFetchApi();

    const requests = Promise.all([
      fetchApi('https://site.test/novel/1'),
      fetchApi('https://site.test/novel/2', {
        headers: { 'User-Agent': 'Plugin UA' },
      }),
    ]);
    await new Promise(setImmediate);
    expect(solveChallenge).toHaveBeenCalledTimes(1);

    finishFirst(FAILED);
    await requests;
    expect(solveChallenge).toHaveBeenCalledTimes(2);
  });

  it('returns the WebView response when no clearance is issued', async () => {
    const body = '<p>Café, 第一章</p>';
    fetchMock.mockResolvedValue(challenge());
    solveChallenge.mockResolvedValue(webViewResponse(body));

    const result = await loadFetchApi()('https://site.test/novel');

    expect(result.status).toBe(200);
    await expect(result.text()).resolves.toBe(body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('replays a non-GET request in the page without unsafe headers', async () => {
    fetchMock.mockResolvedValue(challenge());
    solveChallenge.mockResolvedValue(FAILED);

    await loadFetchApi()('https://site.test/wp-admin/admin-ajax.php', {
      method: 'POST',
      body: 'action=toc&id=1',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': 'session=1',
        'Referer': 'https://site.test/novel',
      },
    });

    const [request] = solveChallenge.mock.calls[0];
    expect(request).toMatchObject({
      method: 'POST',
      body: 'action=toc&id=1',
      captureResponse: true,
    });
    expect(request.headers).toMatchObject({
      'content-type': 'application/x-www-form-urlencoded',
      'referer': 'https://site.test/novel',
    });
    expect(request.headers).not.toHaveProperty('cookie');
    expect(request.headers).not.toHaveProperty('user-agent');
  });

  it('does not capture a response for a body the page cannot replay', async () => {
    fetchMock.mockResolvedValue(challenge());
    solveChallenge.mockResolvedValue(FAILED);

    await loadFetchApi()('https://site.test/upload', {
      method: 'POST',
      body: new FormData(),
    });

    expect(solveChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ body: undefined, captureResponse: false }),
    );
  });

  it('gives each concurrent request its own WebView response', async () => {
    fetchMock.mockResolvedValue(challenge());
    solveChallenge.mockImplementation(async ({ url }) =>
      webViewResponse(url, url),
    );
    const fetchApi = loadFetchApi();

    const results = await Promise.all([
      fetchApi('https://site.test/chapter/1'),
      fetchApi('https://site.test/chapter/2'),
    ]);

    expect(solveChallenge).toHaveBeenCalledTimes(2);
    await expect(
      Promise.all(results.map(result => result.text())),
    ).resolves.toEqual([
      'https://site.test/chapter/1',
      'https://site.test/chapter/2',
    ]);
  });

  it('does not start the cooldown after a WebView response', async () => {
    fetchMock.mockResolvedValue(challenge());
    solveChallenge.mockResolvedValue(webViewResponse('<p>ok</p>'));
    const fetchApi = loadFetchApi();

    await fetchApi('https://site.test/novel/1');
    await fetchApi('https://site.test/novel/2');

    expect(solveChallenge).toHaveBeenCalledTimes(2);
  });
});

describe('fetchText Cloudflare bypass', () => {
  const originalFileReader = global.FileReader;
  beforeAll(() => {
    global.FileReader = TextFileReader as unknown as typeof FileReader;
  });
  afterAll(() => {
    global.FileReader = originalFileReader;
  });

  it('returns the page text after solving the challenge', async () => {
    fetchMock
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(textResponse('<p>chapter</p>'));
    solveChallenge.mockResolvedValue(CLEARANCE);

    await expect(
      loadFetch().fetchText('https://site.test/chapter'),
    ).resolves.toBe('<p>chapter</p>');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns WebView text without decoding it again', async () => {
    const body = '<p>第一章 开始</p>';
    fetchMock.mockResolvedValue(challenge());
    solveChallenge.mockResolvedValue(webViewResponse(body));

    await expect(
      loadFetch().fetchText('https://site.test/chapter', undefined, 'gbk'),
    ).resolves.toBe(body);
  });

  it('returns an empty string when the challenge cannot be solved', async () => {
    fetchMock.mockResolvedValue(challenge());
    solveChallenge.mockResolvedValue(FAILED);

    await expect(
      loadFetch().fetchText('https://site.test/chapter'),
    ).resolves.toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
