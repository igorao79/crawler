import { describe, it, expect, beforeEach } from 'vitest';
import { CrawlQueue, normalizeUrl } from './queue.js';

describe('normalizeUrl', () => {
  it('removes trailing slash', () => {
    expect(normalizeUrl('https://lusion.co/projects/')).toBe('https://lusion.co/projects');
  });

  it('removes hash', () => {
    expect(normalizeUrl('https://lusion.co/projects#section')).toBe('https://lusion.co/projects');
  });

  it('preserves root path', () => {
    const result = normalizeUrl('https://lusion.co/');
    expect(result).toBe('https://lusion.co/');
  });

  it('sorts query params', () => {
    const result = normalizeUrl('https://lusion.co/page?b=2&a=1');
    expect(result).toBe('https://lusion.co/page?a=1&b=2');
  });

  it('returns raw string for invalid URL', () => {
    expect(normalizeUrl('not-a-url')).toBe('not-a-url');
  });
});

describe('CrawlQueue', () => {
  let queue: CrawlQueue;

  beforeEach(() => {
    queue = new CrawlQueue(3, 'lusion.co');
  });

  it('adds URL and retrieves it', () => {
    queue.add('https://lusion.co/projects', 1);
    expect(queue.isEmpty()).toBe(false);
    expect(queue.size()).toBe(1);

    const item = queue.next();
    expect(item?.url).toBe('https://lusion.co/projects');
    expect(item?.depth).toBe(1);
    expect(queue.isEmpty()).toBe(true);
  });

  it('deduplicates URLs', () => {
    queue.add('https://lusion.co/projects', 1);
    const added = queue.add('https://lusion.co/projects', 1);
    expect(added).toBe(false);
    expect(queue.size()).toBe(1);
  });

  it('deduplicates URLs with trailing slash difference', () => {
    queue.add('https://lusion.co/projects/', 1);
    const added = queue.add('https://lusion.co/projects', 1);
    expect(added).toBe(false);
    expect(queue.size()).toBe(1);
  });

  it('rejects URLs exceeding max depth', () => {
    const added = queue.add('https://lusion.co/projects', 4);
    expect(added).toBe(false);
    expect(queue.size()).toBe(0);
  });

  it('allows URLs at exactly max depth', () => {
    const added = queue.add('https://lusion.co/projects', 3);
    expect(added).toBe(true);
  });

  it('filters by domain', () => {
    const added1 = queue.add('https://lusion.co/projects', 1);
    const added2 = queue.add('https://google.com/search', 1);
    expect(added1).toBe(true);
    expect(added2).toBe(false);
    expect(queue.size()).toBe(1);
  });

  it('allows subdomains of the allowed domain', () => {
    const added = queue.add('https://cdn.lusion.co/assets/img.png', 1);
    expect(added).toBe(true);
  });

  it('tracks visited URLs', () => {
    queue.add('https://lusion.co/projects', 1);
    expect(queue.hasVisited('https://lusion.co/projects')).toBe(true);
    expect(queue.hasVisited('https://lusion.co/about')).toBe(false);
    expect(queue.visitedCount()).toBe(1);
  });

  it('stores parent URL', () => {
    queue.add('https://lusion.co/work/project-a', 2, 'https://lusion.co/projects');
    const item = queue.next();
    expect(item?.parentUrl).toBe('https://lusion.co/projects');
  });

  it('processes in FIFO order', () => {
    queue.add('https://lusion.co/a', 1);
    queue.add('https://lusion.co/b', 1);
    queue.add('https://lusion.co/c', 1);

    expect(queue.next()?.url).toBe('https://lusion.co/a');
    expect(queue.next()?.url).toBe('https://lusion.co/b');
    expect(queue.next()?.url).toBe('https://lusion.co/c');
  });
});
