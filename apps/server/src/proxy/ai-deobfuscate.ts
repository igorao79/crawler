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

interface AIProvider {
  name: string;
  apiUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  requestDelay: number;
}

function getProvider(): AIProvider {
  // Priority: Gemini (most generous) > Cerebras > Groq
  if (process.env.GEMINI_API_KEY) {
    return {
      name: 'Gemini 2.0 Flash',
      apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      model: 'gemini-2.0-flash',
      apiKey: process.env.GEMINI_API_KEY,
      maxTokens: 8192,
      requestDelay: 4000, // 15 req/min
    };
  }
  if (process.env.CEREBRAS_API_KEY) {
    return {
      name: 'Cerebras Qwen 3 235B',
      apiUrl: 'https://api.cerebras.ai/v1/chat/completions',
      model: 'qwen-3-235b-a22b-instruct-2507',
      apiKey: process.env.CEREBRAS_API_KEY,
      maxTokens: 8000,
      requestDelay: 15000, // 4 req/min to stay under token limits
    };
  }
  if (process.env.GROQ_API_KEY) {
    return {
      name: 'Groq Llama 3.3 70B',
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.3-70b-versatile',
      apiKey: process.env.GROQ_API_KEY,
      maxTokens: 8000,
      requestDelay: 2000,
    };
  }
  throw new Error('No AI API key configured. Set GEMINI_API_KEY, CEREBRAS_API_KEY, or GROQ_API_KEY');
}

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
 * Send a chunk to Gemini API (different format from OpenAI-compatible APIs).
 */
async function annotateChunkGemini(chunk: string, chunkIndex: number, totalChunks: number, provider: AIProvider): Promise<string> {
  const url = `${provider.apiUrl}?key=${provider.apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `${SYSTEM_PROMPT}\n\nThis is chunk ${chunkIndex + 1} of ${totalChunks} from a large JavaScript bundle. Annotate it:\n\n${chunk}`,
        }],
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: provider.maxTokens,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    candidates: { content: { parts: { text: string }[] } }[];
  };

  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Empty response from Gemini API');

  return content
    .replace(/^```(?:javascript|js)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '');
}

/**
 * Send a chunk to OpenAI-compatible API (Cerebras, Groq).
 */
async function annotateChunkOpenAI(chunk: string, chunkIndex: number, totalChunks: number, provider: AIProvider): Promise<string> {
  const response = await fetch(provider.apiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `This is chunk ${chunkIndex + 1} of ${totalChunks} from a large JavaScript bundle. Annotate it:\n\n${chunk}`,
        },
      ],
      temperature: 0.1,
      max_tokens: provider.maxTokens,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${provider.name} API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Empty response from ${provider.name}`);

  return content
    .replace(/^```(?:javascript|js)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '');
}

async function annotateChunk(chunk: string, chunkIndex: number, totalChunks: number): Promise<string> {
  const provider = getProvider();

  if (provider.name.startsWith('Gemini')) {
    return annotateChunkGemini(chunk, chunkIndex, totalChunks, provider);
  }
  return annotateChunkOpenAI(chunk, chunkIndex, totalChunks, provider);
}

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
 */
export async function aiDeobfuscateFile(
  fileName: string,
  onProgress?: ProgressCallback,
): Promise<{ outputPath: string; chunks: number; provider: string }> {
  const provider = getProvider();
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
      message: `[${provider.name}] Processing chunk ${i + 1} of ${chunks.length}...`,
    });

    try {
      let annotated: string | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          annotated = await annotateChunk(chunks[i], i, chunks.length);
          break;
        } catch (retryErr) {
          const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          if (msg.includes('429') && attempt < 2) {
            await delay(15000); // wait 15s on rate limit
            continue;
          }
          throw retryErr;
        }
      }
      annotatedChunks.push(annotated!);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
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

    if (i < chunks.length - 1) {
      await delay(provider.requestDelay);
    }
  }

  const header = `/**
 * ========================================
 * AI-ANNOTATED SOURCE (${provider.name})
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
    message: `AI deobfuscation complete (${provider.name})`,
  });

  return { outputPath, chunks: chunks.length, provider: provider.name };
}
