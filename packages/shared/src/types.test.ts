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
    it('accepts empty object', () => {
      expect(isCreateCrawlJobRequest({})).toBe(true);
    });

    it('accepts valid maxDepth', () => {
      expect(isCreateCrawlJobRequest({ maxDepth: 3 })).toBe(true);
      expect(isCreateCrawlJobRequest({ maxDepth: 1 })).toBe(true);
      expect(isCreateCrawlJobRequest({ maxDepth: 5 })).toBe(true);
    });

    it('rejects invalid maxDepth', () => {
      expect(isCreateCrawlJobRequest({ maxDepth: 0 })).toBe(false);
      expect(isCreateCrawlJobRequest({ maxDepth: 6 })).toBe(false);
      expect(isCreateCrawlJobRequest({ maxDepth: 'three' })).toBe(false);
    });

    it('rejects non-objects', () => {
      expect(isCreateCrawlJobRequest(null)).toBe(false);
      expect(isCreateCrawlJobRequest('string')).toBe(false);
      expect(isCreateCrawlJobRequest(42)).toBe(false);
    });
  });
});
