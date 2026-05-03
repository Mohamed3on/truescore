type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;

export function createThrottledFetcher(concurrency: number, fetcher: Fetcher = fetch) {
  let active = 0;
  const queue: { fn: () => Promise<Response>; resolve: (v: Response) => void; reject: (e: any) => void }[] = [];
  const next = () => {
    while (active < concurrency && queue.length) {
      active++;
      const { fn, resolve, reject } = queue.shift()!;
      fn().then(resolve, reject).finally(() => { active--; next(); });
    }
  };
  return (url: string, options?: RequestInit) => new Promise<Response>((resolve, reject) => {
    queue.push({ fn: () => fetcher(url, options), resolve, reject });
    next();
  });
}
