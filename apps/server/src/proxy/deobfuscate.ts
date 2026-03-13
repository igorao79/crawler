import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { format } from 'prettier';

const CACHE_DIR = './proxy-cache';
const OUTPUT_DIR = './readable-source';

// Known Three.js / WebGL patterns to annotate
const ANNOTATIONS: [RegExp, string][] = [
  [/new\s+THREE\.WebGLRenderer/g, '/* === WebGL Renderer Setup === */'],
  [/new\s+THREE\.PerspectiveCamera/g, '/* === Perspective Camera === */'],
  [/new\s+THREE\.OrthographicCamera/g, '/* === Orthographic Camera === */'],
  [/new\s+THREE\.Scene/g, '/* === Scene Creation === */'],
  [/new\s+THREE\.Mesh/g, '/* === Mesh Creation === */'],
  [/new\s+THREE\.ShaderMaterial/g, '/* === Custom Shader Material === */'],
  [/new\s+THREE\.RawShaderMaterial/g, '/* === Raw Shader Material === */'],
  [/new\s+THREE\.BufferGeometry/g, '/* === Buffer Geometry === */'],
  [/new\s+THREE\.TextureLoader/g, '/* === Texture Loader === */'],
  [/GLTFLoader/g, '/* GLTF 3D Model Loader */'],
  [/DRACOLoader/g, '/* Draco Compressed Model Loader */'],
  [/requestAnimationFrame/g, '/* Animation Loop */'],
  [/gl_Position/g, '/* GLSL: Vertex Position Output */'],
  [/gl_FragColor/g, '/* GLSL: Fragment Color Output */'],
  [/uniform\s+/g, '/* GLSL Uniform */ uniform '],
  [/varying\s+/g, '/* GLSL Varying */ varying '],
];

// Extract GLSL shaders from JS source
function extractShaders(source: string): { vertex: string[]; fragment: string[] } {
  const vertex: string[] = [];
  const fragment: string[] = [];

  // Common patterns for inline GLSL in Three.js apps
  // Pattern 1: template literals with GLSL keywords
  const shaderRegex = /[`"'](\s*(?:precision|attribute|uniform|varying|void\s+main|#version|gl_Position|gl_FragColor|gl_FragData)[\s\S]*?)[`"']/g;
  let match;
  while ((match = shaderRegex.exec(source)) !== null) {
    const code = match[1].trim();
    if (code.length < 20) continue; // too short, probably not a shader

    if (code.includes('gl_Position')) {
      vertex.push(code);
    } else if (code.includes('gl_FragColor') || code.includes('gl_FragData')) {
      fragment.push(code);
    } else {
      // Generic shader
      fragment.push(code);
    }
  }

  // Pattern 2: vertexShader: "..." or fragmentShader: "..."
  const namedShaderRegex = /(vertex|fragment)Shader\s*[:=]\s*[`"']([\s\S]*?)[`"']/g;
  while ((match = namedShaderRegex.exec(source)) !== null) {
    const type = match[1];
    const code = match[2].trim().replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    if (code.length < 20) continue;
    if (type === 'vertex') vertex.push(code);
    else fragment.push(code);
  }

  return { vertex, fragment };
}

// Extract CSS custom properties and design tokens
function extractDesignTokens(css: string): string {
  const tokens: string[] = [];
  const varRegex = /--([\w-]+)\s*:\s*([^;]+);/g;
  let match;
  while ((match = varRegex.exec(css)) !== null) {
    tokens.push(`--${match[1]}: ${match[2].trim()};`);
  }
  if (tokens.length === 0) return '';
  return `/* ========================================\n * DESIGN TOKENS (CSS Custom Properties)\n * ======================================== */\n\n:root {\n  ${tokens.join('\n  ')}\n}\n`;
}

// Extract animation keyframes
function extractAnimations(css: string): string {
  const animations: string[] = [];
  const keyframeRegex = /@keyframes\s+[\w-]+\s*\{[^}]*(?:\{[^}]*\}[^}]*)*\}/g;
  let match;
  while ((match = keyframeRegex.exec(css)) !== null) {
    animations.push(match[0]);
  }
  if (animations.length === 0) return '';
  return `/* ========================================\n * ANIMATIONS\n * ======================================== */\n\n${animations.join('\n\n')}\n`;
}

function walkDir(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...walkDir(fullPath));
    } else if (!entry.endsWith('.meta.json')) {
      files.push(fullPath);
    }
  }
  return files;
}

async function deobfuscate() {
  console.log('='.repeat(60));
  console.log('  Deobfuscation & Beautification');
  console.log('  Input:  ' + CACHE_DIR);
  console.log('  Output: ' + OUTPUT_DIR);
  console.log('='.repeat(60));

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  const allFiles = walkDir(CACHE_DIR);
  let processed = 0;
  let skipped = 0;

  // Separate directories for organized output
  const dirs = ['js', 'css', 'html', 'shaders', 'assets-index'];
  for (const d of dirs) {
    const p = join(OUTPUT_DIR, d);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }

  const allShaders: { vertex: string[]; fragment: string[] } = { vertex: [], fragment: [] };
  const assetIndex: Record<string, string[]> = {
    images: [], videos: [], models: [], fonts: [], audio: [],
  };

  for (const filePath of allFiles) {
    const ext = extname(filePath).toLowerCase();
    const relPath = relative(CACHE_DIR, filePath);

    // Categorize assets
    if (['.webp', '.png', '.jpg', '.jpeg', '.svg', '.avif', '.gif', '.ico'].includes(ext)) {
      assetIndex.images.push(relPath);
      skipped++;
      continue;
    }
    if (['.mp4', '.webm', '.mov', '.ogg'].includes(ext)) {
      if (ext === '.ogg' && relPath.includes('audio')) assetIndex.audio.push(relPath);
      else if (ext === '.ogg') assetIndex.audio.push(relPath);
      else assetIndex.videos.push(relPath);
      skipped++;
      continue;
    }
    if (['.glb', '.gltf', '.obj', '.buf', '.fbx', '.usdz'].includes(ext)) {
      assetIndex.models.push(relPath);
      skipped++;
      continue;
    }
    if (['.woff', '.woff2', '.ttf', '.otf'].includes(ext)) {
      assetIndex.fonts.push(relPath);
      skipped++;
      continue;
    }
    if (['.webmanifest', '.json'].includes(ext) && !filePath.endsWith('.meta.json')) {
      // Copy JSON files as-is but prettified
      try {
        const content = readFileSync(filePath, 'utf-8');
        const pretty = JSON.stringify(JSON.parse(content), null, 2);
        const outPath = join(OUTPUT_DIR, 'js', relPath.replace(/[\\/]/g, '_'));
        writeFileSync(outPath, pretty, 'utf-8');
        processed++;
      } catch {
        skipped++;
      }
      continue;
    }

    // Process JS files
    if (ext === '.js' || ext === '.mjs') {
      console.log(`\n  Processing JS: ${relPath} (${(statSync(filePath).size / 1024).toFixed(0)}KB)`);
      let source = readFileSync(filePath, 'utf-8');

      // Extract shaders before beautification
      const shaders = extractShaders(source);
      allShaders.vertex.push(...shaders.vertex);
      allShaders.fragment.push(...shaders.fragment);

      // Beautify with prettier
      try {
        source = await format(source, {
          parser: 'babel',
          printWidth: 100,
          tabWidth: 2,
          semi: true,
          singleQuote: true,
          trailingComma: 'all',
        });
        console.log(`    Beautified successfully`);
      } catch (err) {
        console.warn(`    Prettier failed, using basic formatting`);
        // Basic formatting fallback
        source = source
          .replace(/;/g, ';\n')
          .replace(/\{/g, '{\n')
          .replace(/\}/g, '\n}\n')
          .replace(/,(?=[^\s])/g, ', ');
      }

      // Add section annotations
      for (const [pattern, comment] of ANNOTATIONS) {
        source = source.replace(pattern, `${comment}\n$&`);
      }

      // Add header
      const header = `/**
 * ========================================
 * DEOBFUSCATED SOURCE
 * Original: ${relPath}
 * Size: ${(statSync(filePath).size / 1024).toFixed(0)}KB
 * Beautified: ${new Date().toISOString()}
 *
 * NOTE: Variable names are minified.
 * Look for annotated sections (/* === ... === */)
 * for key Three.js / WebGL components.
 * ========================================
 */\n\n`;

      const outName = relPath.replace(/[\\/]/g, '_');
      writeFileSync(join(OUTPUT_DIR, 'js', outName), header + source, 'utf-8');
      processed++;
      continue;
    }

    // Process CSS files
    if (ext === '.css') {
      console.log(`\n  Processing CSS: ${relPath} (${(statSync(filePath).size / 1024).toFixed(0)}KB)`);
      let source = readFileSync(filePath, 'utf-8');

      // Extract design tokens and animations before beautification
      const tokens = extractDesignTokens(source);
      const animations = extractAnimations(source);

      // Beautify
      try {
        source = await format(source, {
          parser: 'css',
          printWidth: 100,
          tabWidth: 2,
        });
        console.log(`    Beautified successfully`);
      } catch {
        console.warn(`    Prettier failed, using basic formatting`);
        source = source
          .replace(/\{/g, ' {\n  ')
          .replace(/\}/g, '\n}\n')
          .replace(/;/g, ';\n  ');
      }

      const header = `/**
 * ========================================
 * BEAUTIFIED STYLESHEET
 * Original: ${relPath}
 * Size: ${(statSync(filePath).size / 1024).toFixed(0)}KB
 * Beautified: ${new Date().toISOString()}
 * ========================================
 */\n\n`;

      const outName = relPath.replace(/[\\/]/g, '_');
      writeFileSync(join(OUTPUT_DIR, 'css', outName), header + source, 'utf-8');

      // Save extracted tokens separately
      if (tokens) {
        writeFileSync(join(OUTPUT_DIR, 'css', 'design-tokens.css'), tokens, 'utf-8');
        console.log(`    Extracted design tokens`);
      }
      if (animations) {
        writeFileSync(join(OUTPUT_DIR, 'css', 'animations.css'), animations, 'utf-8');
        console.log(`    Extracted animations`);
      }

      processed++;
      continue;
    }

    // Process HTML files
    if (ext === '.html') {
      console.log(`\n  Processing HTML: ${relPath}`);
      let source = readFileSync(filePath, 'utf-8');

      try {
        source = await format(source, {
          parser: 'html',
          printWidth: 120,
          tabWidth: 2,
        });
      } catch {
        // HTML might be too complex for prettier, use basic indent
        source = source
          .replace(/></g, '>\n<')
          .replace(/><\//g, '>\n</');
      }

      const outName = relPath.replace(/[\\/]/g, '_');
      writeFileSync(join(OUTPUT_DIR, 'html', outName), source, 'utf-8');
      processed++;
      continue;
    }

    skipped++;
  }

  // Save extracted shaders
  if (allShaders.vertex.length > 0 || allShaders.fragment.length > 0) {
    let shaderFile = `/**
 * ========================================
 * EXTRACTED GLSL SHADERS
 * From: lusion.co JavaScript bundles
 * ========================================
 */\n\n`;

    if (allShaders.vertex.length > 0) {
      shaderFile += `/* ========== VERTEX SHADERS ========== */\n\n`;
      allShaders.vertex.forEach((s, i) => {
        shaderFile += `/* --- Vertex Shader #${i + 1} --- */\n${s}\n\n`;
      });
    }

    if (allShaders.fragment.length > 0) {
      shaderFile += `/* ========== FRAGMENT SHADERS ========== */\n\n`;
      allShaders.fragment.forEach((s, i) => {
        shaderFile += `/* --- Fragment Shader #${i + 1} --- */\n${s}\n\n`;
      });
    }

    writeFileSync(join(OUTPUT_DIR, 'shaders', 'extracted-shaders.glsl'), shaderFile, 'utf-8');
    console.log(`\n  Extracted ${allShaders.vertex.length} vertex + ${allShaders.fragment.length} fragment shaders`);
  }

  // Save asset index
  const indexContent = `# Lusion.co — Asset Index
Generated: ${new Date().toISOString()}

## 3D Models (${assetIndex.models.length})
${assetIndex.models.map(f => `- ${f}`).join('\n') || 'None found'}

## Images (${assetIndex.images.length})
${assetIndex.images.map(f => `- ${f}`).join('\n') || 'None found'}

## Videos (${assetIndex.videos.length})
${assetIndex.videos.map(f => `- ${f}`).join('\n') || 'None found'}

## Audio (${assetIndex.audio.length})
${assetIndex.audio.map(f => `- ${f}`).join('\n') || 'None found'}

## Fonts (${assetIndex.fonts.length})
${assetIndex.fonts.map(f => `- ${f}`).join('\n') || 'None found'}

## Total Assets: ${Object.values(assetIndex).flat().length}
`;
  writeFileSync(join(OUTPUT_DIR, 'assets-index', 'ASSETS.md'), indexContent, 'utf-8');

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('  DEOBFUSCATION COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Processed: ${processed} files`);
  console.log(`  Skipped (binary): ${skipped} files`);
  console.log(`  Output: ${OUTPUT_DIR}/`);
  console.log(`    js/       — Beautified JavaScript with annotations`);
  console.log(`    css/      — Beautified CSS + design tokens + animations`);
  console.log(`    html/     — Formatted HTML pages`);
  console.log(`    shaders/  — Extracted GLSL shaders`);
  console.log(`    assets-index/ — Full asset inventory`);
  console.log('');
}

deobfuscate().catch((err) => {
  console.error('Deobfuscation failed:', err);
  process.exit(1);
});
