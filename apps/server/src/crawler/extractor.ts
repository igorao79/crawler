import type { Page } from 'playwright';

export interface ExtractedData {
  title: string | null;
  description: string | null;
  tags: string[];
  fullHtml: string;
  scripts: string[];
  stylesheets: string[];
  imageUrls: string[];
  videoUrls: string[];
  model3dUrls: string[];
  internalLinks: string[];
}

export async function extractPageData(page: Page, baseUrl: string): Promise<ExtractedData> {
  const fullHtml = await page.content();

  const title = await page.title();

  const description = await page.evaluate((): string | null => {
    const meta = document.querySelector('meta[name="description"]');
    return meta ? meta.getAttribute('content') : null;
  });

  const tags = await page.evaluate((): string[] => {
    const tagElements = document.querySelectorAll('[data-tag], .tag, .category, [class*="tag"]');
    const result: string[] = [];
    tagElements.forEach((el) => {
      const text = el.textContent?.trim();
      if (text) result.push(text);
    });
    return result;
  });

  const scripts = await page.evaluate((): string[] => {
    const elements = document.querySelectorAll('script[src]');
    const urls: string[] = [];
    elements.forEach((el) => {
      const src = el.getAttribute('src');
      if (src) urls.push(src);
    });
    return urls;
  });

  const stylesheets = await page.evaluate((): string[] => {
    const elements = document.querySelectorAll('link[rel="stylesheet"]');
    const urls: string[] = [];
    elements.forEach((el) => {
      const href = el.getAttribute('href');
      if (href) urls.push(href);
    });
    return urls;
  });

  const imageUrls = await page.evaluate((): string[] => {
    const elements = document.querySelectorAll('img[src], source[srcset], [style*="background-image"]');
    const urls: string[] = [];
    elements.forEach((el) => {
      const src = el.getAttribute('src');
      if (src) urls.push(src);
      const srcset = el.getAttribute('srcset');
      if (srcset) {
        srcset.split(',').forEach((s) => {
          const url = s.trim().split(/\s+/)[0];
          if (url) urls.push(url);
        });
      }
    });
    return urls;
  });

  const videoUrls = await page.evaluate((): string[] => {
    const elements = document.querySelectorAll('video[src], video source[src]');
    const urls: string[] = [];
    elements.forEach((el) => {
      const src = el.getAttribute('src');
      if (src) urls.push(src);
    });
    return urls;
  });

  const model3dUrls = await page.evaluate((): string[] => {
    const html = document.documentElement.innerHTML;
    const matches = html.match(/["'](https?:\/\/[^"']*\.(glb|gltf|obj|fbx|usdz))['"]/gi) ?? [];
    return matches.map((m) => m.slice(1, -1));
  });

  const rawInternalLinks = await page.evaluate((base: string): string[] => {
    const links = document.querySelectorAll('a[href]');
    const urls: string[] = [];
    links.forEach((el) => {
      const href = el.getAttribute('href');
      if (!href) return;
      try {
        const resolved = new URL(href, base);
        if (resolved.hostname === new URL(base).hostname) {
          urls.push(resolved.href);
        }
      } catch {
        // skip invalid URLs
      }
    });
    return urls;
  }, baseUrl);

  // Resolve relative URLs
  const resolveUrl = (url: string): string => {
    try {
      return new URL(url, baseUrl).href;
    } catch {
      return url;
    }
  };

  return {
    title: title || null,
    description,
    tags,
    fullHtml,
    scripts: scripts.map(resolveUrl),
    stylesheets: stylesheets.map(resolveUrl),
    imageUrls: imageUrls.map(resolveUrl),
    videoUrls: videoUrls.map(resolveUrl),
    model3dUrls: model3dUrls.map(resolveUrl),
    internalLinks: rawInternalLinks,
  };
}
