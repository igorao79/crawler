import { describe, it, expect } from 'vitest';
import { classifyAssetUrl, collectAssets, deduplicateAssets } from './asset-collector.js';

describe('classifyAssetUrl', () => {
  it('classifies image extensions', () => {
    expect(classifyAssetUrl('https://cdn.lusion.co/img/hero.jpg')).toBe('image');
    expect(classifyAssetUrl('https://cdn.lusion.co/img/hero.png')).toBe('image');
    expect(classifyAssetUrl('https://cdn.lusion.co/img/hero.webp')).toBe('image');
    expect(classifyAssetUrl('https://cdn.lusion.co/img/hero.svg')).toBe('image');
    expect(classifyAssetUrl('https://cdn.lusion.co/img/hero.avif')).toBe('image');
  });

  it('classifies video extensions', () => {
    expect(classifyAssetUrl('https://cdn.lusion.co/vid/demo.mp4')).toBe('video');
    expect(classifyAssetUrl('https://cdn.lusion.co/vid/demo.webm')).toBe('video');
  });

  it('classifies 3D model extensions', () => {
    expect(classifyAssetUrl('https://cdn.lusion.co/models/scene.glb')).toBe('model3d');
    expect(classifyAssetUrl('https://cdn.lusion.co/models/scene.gltf')).toBe('model3d');
    expect(classifyAssetUrl('https://cdn.lusion.co/models/scene.obj')).toBe('model3d');
    expect(classifyAssetUrl('https://cdn.lusion.co/models/scene.usdz')).toBe('model3d');
  });

  it('classifies font extensions', () => {
    expect(classifyAssetUrl('https://cdn.lusion.co/fonts/body.woff2')).toBe('font');
    expect(classifyAssetUrl('https://cdn.lusion.co/fonts/body.ttf')).toBe('font');
  });

  it('classifies script extensions', () => {
    expect(classifyAssetUrl('https://cdn.lusion.co/js/main.js')).toBe('script');
    expect(classifyAssetUrl('https://cdn.lusion.co/js/module.mjs')).toBe('script');
  });

  it('classifies stylesheet extensions', () => {
    expect(classifyAssetUrl('https://cdn.lusion.co/css/style.css')).toBe('stylesheet');
  });

  it('classifies by path pattern when no extension match', () => {
    expect(classifyAssetUrl('https://cdn.lusion.co/image/some-hash')).toBe('image');
    expect(classifyAssetUrl('https://cdn.lusion.co/video/some-hash')).toBe('video');
  });
});

describe('collectAssets', () => {
  it('maps URLs to typed assets', () => {
    const result = collectAssets([
      'https://cdn.lusion.co/img.jpg',
      'https://cdn.lusion.co/vid.mp4',
      'https://cdn.lusion.co/scene.glb',
    ]);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ url: 'https://cdn.lusion.co/img.jpg', type: 'image' });
    expect(result[1]).toEqual({ url: 'https://cdn.lusion.co/vid.mp4', type: 'video' });
    expect(result[2]).toEqual({ url: 'https://cdn.lusion.co/scene.glb', type: 'model3d' });
  });
});

describe('deduplicateAssets', () => {
  it('removes duplicate URLs', () => {
    const assets = [
      { url: 'https://cdn.lusion.co/img.jpg', type: 'image' as const },
      { url: 'https://cdn.lusion.co/img.jpg', type: 'image' as const },
      { url: 'https://cdn.lusion.co/vid.mp4', type: 'video' as const },
    ];
    const result = deduplicateAssets(assets);
    expect(result).toHaveLength(2);
  });

  it('keeps first occurrence', () => {
    const assets = [
      { url: 'https://cdn.lusion.co/file', type: 'image' as const },
      { url: 'https://cdn.lusion.co/file', type: 'video' as const },
    ];
    const result = deduplicateAssets(assets);
    expect(result[0].type).toBe('image');
  });
});
