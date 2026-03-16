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

  const rawInternalLinks = await page.evaluate((base: string) => {
    /* SPA-aware link extraction — 8 discovery methods */
    const hn = new URL(base).hostname;
    const urls = new Set<string>();

    // Helper as object method to avoid esbuild __name transform
    const h = { add(href: string) {
      try { const r = new URL(href, base); if (r.hostname === hn) urls.add(r.href); } catch {}
    }};

    // 1. <a href> links
    document.querySelectorAll('a[href]').forEach((el) => { const v = el.getAttribute('href'); if (v) h.add(v); });

    // 2. SPA routes from pushState/replaceState interceptor
    const sr = (window as any).__spaRoutes;
    if (sr instanceof Set) sr.forEach((u: string) => h.add(u));

    // 3. Router attributes (Vue Router to="", data-href, etc.)
    document.querySelectorAll('[to], [data-href], [data-to], [data-route], [data-link]').forEach((el) => {
      ['to', 'data-href', 'data-to', 'data-route', 'data-link'].forEach((a) => {
        const v = el.getAttribute(a);
        if (v && (v[0] === '/' || v.startsWith('http'))) h.add(v);
      });
    });

    // 4. Hash-based routing (#/ or #!/)
    document.querySelectorAll('a[href^="#/"], a[href^="#!/"]').forEach((el) => {
      const v = el.getAttribute('href');
      if (v) h.add(v.replace(/^#!?/, ''));
    });

    // 5. Nuxt route data
    try {
      const nd = (window as any).__NUXT__;
      if (nd) {
        const ra = nd.routeTree || (nd.config && nd.config.routes) || [];
        const stk = Array.isArray(ra) ? ra.slice() : [];
        while (stk.length) { const r = stk.pop(); if (r && typeof r.path === 'string') h.add(r.path); if (r && Array.isArray(r.children)) stk.push(...r.children); }
      }
    } catch {}

    // 6. Next.js page data
    try {
      const nd = (window as any).__NEXT_DATA__;
      if (nd && nd.props) {
        const q: [any, number][] = [[nd.props, 0]];
        while (q.length) {
          const pair = q.pop()!; const obj = pair[0]; const d = pair[1];
          if (d > 4 || !obj) continue;
          if (typeof obj === 'string' && obj[0] === '/' && obj.length < 200 && obj.indexOf('.') === -1) { h.add(obj); }
          else if (Array.isArray(obj)) { for (let i = 0; i < obj.length; i++) q.push([obj[i], d + 1]); }
          else if (typeof obj === 'object') { const ks = Object.keys(obj); for (let i = 0; i < ks.length; i++) { const k = ks[i]; if (k === 'href' || k === 'url' || k === 'path' || k === 'route' || k === 'slug' || k === 'to' || k === 'link' || k === 'pathname') { const v = obj[k]; if (typeof v === 'string' && v[0] === '/') h.add(v); } q.push([obj[k], d + 1]); } }
        }
      }
    } catch {}

    // 7. JSON route data in script tags
    document.querySelectorAll('script[type="application/json"], script#__NUXT_DATA__').forEach((el) => {
      try {
        const text = el.textContent;
        if (!text || text.length > 50000) return;
        const pm = text.matchAll(/"(\/[a-z0-9][a-z0-9._~:@!$&'()*+,;=/-]{0,150})"/gi);
        for (const m of pm) { const p = m[1]; if (/\.(js|css|png|jpg|svg|woff|json|xml|ico|mp[34]|webp|avif|gif)$/i.test(p)) continue; if (p.startsWith('/api/') || p.startsWith('/_')) continue; h.add(p); }
      } catch {}
    });

    // 8. onclick handlers with route patterns
    document.querySelectorAll('[onclick]').forEach((el) => {
      const oc = el.getAttribute('onclick') || '';
      const rm = oc.matchAll(/(?:push|replace|navigate|goto|href)\s*\(\s*['"](\/?[^'"]+)['"]/gi);
      for (const m of rm) { if (m[1][0] === '/' || m[1].startsWith('http')) h.add(m[1]); }
    });

    return [...urls];
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
