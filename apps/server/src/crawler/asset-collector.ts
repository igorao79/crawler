import type { AssetType } from '@lusion-crawler/shared';

export interface CollectedAsset {
  url: string;
  type: AssetType;
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif', '.ico'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.ogg', '.mov', '.avi'];
const MODEL3D_EXTENSIONS = ['.glb', '.gltf', '.obj', '.fbx', '.usdz'];
const FONT_EXTENSIONS = ['.woff', '.woff2', '.ttf', '.otf', '.eot'];

export function classifyAssetUrl(url: string): AssetType {
  const pathname = extractPathname(url);
  const lower = pathname.toLowerCase();

  if (IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'image';
  if (VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'video';
  if (MODEL3D_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'model3d';
  if (FONT_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'font';
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'script';
  if (lower.endsWith('.css')) return 'stylesheet';

  // Check common CDN patterns
  if (lower.includes('/image') || lower.includes('/img')) return 'image';
  if (lower.includes('/video')) return 'video';

  return 'image'; // Default fallback
}

function extractPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function collectAssets(urls: string[]): CollectedAsset[] {
  return urls.map((url) => ({
    url,
    type: classifyAssetUrl(url),
  }));
}

export function deduplicateAssets(assets: CollectedAsset[]): CollectedAsset[] {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    if (seen.has(asset.url)) return false;
    seen.add(asset.url);
    return true;
  });
}
