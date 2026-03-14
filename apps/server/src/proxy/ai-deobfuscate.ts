import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const READABLE_SOURCE_DIR = './readable-source';
const AI_OUTPUT_DIR = join(READABLE_SOURCE_DIR, 'ai-deobfuscated');

const SYSTEM_PROMPT = `You are a JavaScript reverse-engineering expert. Your task is to make minified/obfuscated JavaScript code more readable.

Rules:
1. Add clear comments explaining what each function does
2. Rename obviously-named single-letter variables when the purpose is clear (e.g., "e" for event, "el" for element, "ctx" for context)
3. Add section headers (/* === Section Name === */) to group related code
4. Preserve ALL original logic exactly — do NOT change behavior
5. If you see Three.js, WebGL, GSAP, or shader code, label it clearly
6. Return ONLY the annotated JavaScript code, no explanations before or after
7. Do not wrap the code in markdown code blocks`;

interface DeobfuscateProgress {
  totalChunks: number;
  currentChunk: number;
  fileName: string;
  status: 'processing' | 'done' | 'error';
  message?: string;
}

type ProgressCallback = (progress: DeobfuscateProgress) => void;

/**
 * Split source code into chunks of roughly `targetLines` lines,
 * breaking at lines ending with `}` or `;` to avoid splitting mid-statement.
 */
function splitIntoChunks(source: string, targetLines = 500): string[] {
  const lines = source.split('\n');
  const chunks: string[] = [];
  let currentChunk: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    currentChunk.push(lines[i]);

    if (currentChunk.length >= targetLines) {
      const trimmed = lines[i].trimEnd();
      if (trimmed.endsWith('}') || trimmed.endsWith(';') || i === lines.length - 1) {
        chunks.push(currentChunk.join('\n'));
        currentChunk = [];
      }
      // If we're well past the target, force a split to avoid runaway chunks
      if (currentChunk.length >= targetLines + 200) {
        chunks.push(currentChunk.join('\n'));
        currentChunk = [];
      }
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n'));
  }

  return chunks;
}

/**
 * Send a single chunk to the Groq API for annotation.
 */
async function annotateChunk(chunk: string, chunkIndex: number, totalChunks: number): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY environment variable is not set');
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `This is chunk ${chunkIndex + 1} of ${totalChunks} from a large JavaScript bundle. Annotate it:\n\n${chunk}`,
        },
      ],
      temperature: 0.1,
      max_tokens: 8000,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from Groq API');
  }

  // Strip markdown code fences if the model wrapped the output
  return content
    .replace(/^```(?:javascript|js)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '');
}

/**
 * Delay helper for rate limiting (Groq free tier: 30 req/min).
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * List JS files available for AI deobfuscation.
 */
export function listJsFiles(): { name: string; sizeBytes: number }[] {
  const jsDir = join(READABLE_SOURCE_DIR, 'js');
  if (!existsSync(jsDir)) return [];

  return readdirSync(jsDir)
    .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
    .map((f) => {
      const stat = statSync(join(jsDir, f));
      return { name: f, sizeBytes: stat.size };
    });
}

/**
 * Run AI deobfuscation on a single JS file.
 * Reads from readable-source/js/, outputs to readable-source/ai-deobfuscated/.
 */
export async function aiDeobfuscateFile(
  fileName: string,
  onProgress?: ProgressCallback,
): Promise<{ outputPath: string; chunks: number }> {
  const inputPath = join(READABLE_SOURCE_DIR, 'js', fileName);
  if (!existsSync(inputPath)) {
    throw new Error(`File not found: ${inputPath}`);
  }

  if (!existsSync(AI_OUTPUT_DIR)) {
    mkdirSync(AI_OUTPUT_DIR, { recursive: true });
  }

  const source = readFileSync(inputPath, 'utf-8');
  const chunks = splitIntoChunks(source, 500);
  const annotatedChunks: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({
      totalChunks: chunks.length,
      currentChunk: i + 1,
      fileName,
      status: 'processing',
      message: `Processing chunk ${i + 1} of ${chunks.length}...`,
    });

    try {
      const annotated = await annotateChunk(chunks[i], i, chunks.length);
      annotatedChunks.push(annotated);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // On error, keep the original chunk with an error comment
      annotatedChunks.push(
        `/* === AI ANNOTATION FAILED FOR THIS CHUNK ===\n * Error: ${errMsg}\n * Original code preserved below\n */\n\n${chunks[i]}`,
      );
      onProgress?.({
        totalChunks: chunks.length,
        currentChunk: i + 1,
        fileName,
        status: 'error',
        message: `Chunk ${i + 1} failed: ${errMsg}`,
      });
    }

    // Rate limit: wait 2 seconds between requests (30 req/min)
    if (i < chunks.length - 1) {
      await delay(2000);
    }
  }

  // Build output
  const header = `/**
 * ========================================
 * AI-ANNOTATED SOURCE (Groq LLaMA 3.3 70B)
 * Original: ${fileName}
 * Processed: ${new Date().toISOString()}
 * Chunks: ${chunks.length}
 * ========================================
 */\n\n`;

  const output = header + annotatedChunks.join('\n\n// ──────────────────────────────────────\n\n');
  const outputPath = join(AI_OUTPUT_DIR, fileName);
  writeFileSync(outputPath, output, 'utf-8');

  onProgress?.({
    totalChunks: chunks.length,
    currentChunk: chunks.length,
    fileName,
    status: 'done',
    message: 'AI deobfuscation complete',
  });

  return { outputPath, chunks: chunks.length };
}
