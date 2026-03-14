import { describe, it, expect } from 'vitest';
import { isCrawlStatus, isAssetType, isPageStatus, isCreateCrawlJobRequest } from './types.js';

describe('type guards', () => {
  describe('isCrawlStatus', () => {
    it('returns true for valid statuses', () => {
      expect(isCrawlStatus('pending')).toBe(true);
      expect(isCrawlStatus('running')).toBe(true);
      expect(isCrawlStatus('done')).toBe(true);
      expect(isCrawlStatus('error')).toBe(true);
    });

    it('returns false for invalid values', () => {
      expect(isCrawlStatus('invalid')).toBe(false);
      expect(isCrawlStatus(123)).toBe(false);
      expect(isCrawlStatus(null)).toBe(false);
    });
  });

  describe('isAssetType', () => {
    it('returns true for valid asset types', () => {
      expect(isAssetType('image')).toBe(true);
      expect(isAssetType('video')).toBe(true);
      expect(isAssetType('model3d')).toBe(true);
      expect(isAssetType('font')).toBe(true);
      expect(isAssetType('script')).toBe(true);
      expect(isAssetType('stylesheet')).toBe(true);
    });

    it('returns false for invalid values', () => {
      expect(isAssetType('audio')).toBe(false);
      expect(isAssetType(42)).toBe(false);
    });
  });

  describe('isPageStatus', () => {
    it('validates page statuses', () => {
      expect(isPageStatus('pending')).toBe(true);
      expect(isPageStatus('parsed')).toBe(true);
      expect(isPageStatus('error')).toBe(true);
      expect(isPageStatus('other')).toBe(false);
    });
  });

  describe('isCreateCrawlJobRequest', () => {
    it('accepts object with valid url', () => {
      expect(isCreateCrawlJobRequest({ url: 'https://example.com' })).toBe(true);
      expect(isCreateCrawlJobRequest({ url: 'http://example.com' })).toBe(true);
    });

    it('rejects object without url', () => {
      expect(isCreateCrawlJobRequest({})).toBe(false);
    });

    it('rejects invalid url protocols', () => {
      expect(isCreateCrawlJobRequest({ url: 'ftp://example.com' })).toBe(false);
      expect(isCreateCrawlJobRequest({ url: 'not-a-url' })).toBe(false);
    });

    it('accepts valid maxDepth with url', () => {
      expect(isCreateCrawlJobRequest({ url: 'https://example.com', maxDepth: 3 })).toBe(true);
      expect(isCreateCrawlJobRequest({ url: 'https://example.com', maxDepth: 1 })).toBe(true);
      expect(isCreateCrawlJobRequest({ url: 'https://example.com', maxDepth: 5 })).toBe(true);
    });

    it('rejects invalid maxDepth', () => {
      expect(isCreateCrawlJobRequest({ url: 'https://example.com', maxDepth: 0 })).toBe(false);
      expect(isCreateCrawlJobRequest({ url: 'https://example.com', maxDepth: 6 })).toBe(false);
      expect(isCreateCrawlJobRequest({ url: 'https://example.com', maxDepth: 'three' })).toBe(false);
    });

    it('rejects non-objects', () => {
      expect(isCreateCrawlJobRequest(null)).toBe(false);
      expect(isCreateCrawlJobRequest('string')).toBe(false);
      expect(isCreateCrawlJobRequest(42)).toBe(false);
    });
  });
});
