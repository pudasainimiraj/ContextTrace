import { JobError } from "./retry.ts";

/**
 * Workers AI embedding client pinned to one model and one pooling. There is no model or
 * pooling parameter anywhere: the request body is literally { text, pooling: "cls" }, and
 * the result carries these constants after the server's pooling has been checked.
 */
export const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5" as const;
export const EMBEDDING_POOLING = "cls" as const;
export const EMBEDDING_DIMS = 384;
/** The model's sequence length; passages.token_count already includes [CLS] and [SEP]. */
export const EMBEDDING_MAX_TOKENS = 512;
/** Texts per request. The documented ceiling is unofficial; the live CT-23 test confirms it. */
export const EMBEDDING_BATCH_SIZE = 100;
/** Workers AI pricing for this model: $0.020 per million input tokens. */
export const NEURONS_PER_MILLION_TOKENS = 1841;
export const USD_PER_MILLION_TOKENS = 0.02;
export const WORKERS_AI_API_ROOT = "https://api.cloudflare.com/client/v4";

export type EmbeddingResult = {
  model: typeof EMBEDDING_MODEL;
  pooling: typeof EMBEDDING_POOLING;
  vectors: number[][]; // aligned with the input texts
  durationMs: number; // wall time of the call
  /**
   * Input tokens as metered by Workers AI (usage.total_tokens), when reported. Observed:
   * every text in a batch is metered at the longest text's length, so similar lengths
   * should be batched together.
   */
  tokens?: number;
};

export interface EmbeddingClient {
  embed(texts: string[]): Promise<EmbeddingResult>;
}

export type WorkersAiOptions = {
  accountId: string;
  apiToken: string;
  fetch?: typeof globalThis.fetch;
  apiRoot?: string;
};

type Usage = { total_tokens?: unknown; prompt_tokens?: unknown };
type Envelope = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  usage?: Usage;
  result?: { shape?: unknown; data?: unknown; pooling?: unknown; usage?: Usage };
};

export class WorkersAiEmbeddingClient implements EmbeddingClient {
  private readonly url: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: WorkersAiOptions) {
    const root = options.apiRoot ?? WORKERS_AI_API_ROOT;
    this.url = `${root}/accounts/${encodeURIComponent(options.accountId)}/ai/run/${EMBEDDING_MODEL}`;
    this.apiToken = options.apiToken;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) return { model: EMBEDDING_MODEL, pooling: EMBEDDING_POOLING, vectors: [], durationMs: 0 };
    if (texts.length > EMBEDDING_BATCH_SIZE) {
      throw new JobError("ai_bad_request", `A batch of ${texts.length} texts exceeds ${EMBEDDING_BATCH_SIZE}`, { transient: false });
    }

    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "content-type": "application/json",
          "User-Agent": "contexttrace-worker",
        },
        body: JSON.stringify({ text: texts, pooling: EMBEDDING_POOLING }),
      });
    } catch (err) {
      throw new JobError("network", err instanceof Error ? err.message : String(err), { transient: true });
    }
    const durationMs = Date.now() - started;

    const body = (await readJson(res)) as Envelope | undefined;
    const message = body?.errors?.[0]?.message ?? `Workers AI responded ${res.status}`;
    if (res.status === 429) {
      throw new JobError("ai_rate_limited", message, { transient: true, retryAfterSeconds: retryAfterSeconds(res) });
    }
    if (res.status === 401 || res.status === 403) throw new JobError("ai_auth", message, { transient: false });
    if (res.status >= 500) throw new JobError("ai_upstream", message, { transient: true });
    if (!res.ok || body === undefined || body.success === false) {
      throw new JobError("ai_bad_request", message, { transient: false });
    }

    const result = body.result;
    const data = result?.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new JobError("ai_invalid_output", `Expected ${texts.length} vectors from Workers AI`, { transient: false });
    }
    const shape = result?.shape;
    if (Array.isArray(shape) && (shape[0] !== texts.length || shape[1] !== EMBEDDING_DIMS)) {
      throw new JobError("ai_invalid_output", `Unexpected embedding shape ${JSON.stringify(shape)}`, { transient: false });
    }
    if (result?.pooling !== undefined && result.pooling !== EMBEDDING_POOLING) {
      throw new JobError("ai_pooling_mismatch", `Workers AI answered with ${String(result.pooling)} pooling`, { transient: false });
    }
    const usage = result?.usage ?? body.usage;
    const metered = usage?.total_tokens ?? usage?.prompt_tokens;
    const tokens = typeof metered === "number" && Number.isFinite(metered) ? metered : undefined;
    return { model: EMBEDDING_MODEL, pooling: EMBEDDING_POOLING, vectors: data as number[][], durationMs, tokens };
  }
}

/** The client for this environment, or undefined when either credential is missing. */
export function createEmbeddingClient(
  env: Pick<Env, "CLOUDFLARE_ACCOUNT_ID" | "WORKERS_AI_API_TOKEN">,
): EmbeddingClient | undefined {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.WORKERS_AI_API_TOKEN) return undefined;
  return new WorkersAiEmbeddingClient({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.WORKERS_AI_API_TOKEN });
}

export type VectorProblem = "not_array" | "wrong_dims" | "not_finite" | "all_zero";

/** Why a model output cannot be stored, or null when it is a valid embedding. */
export function validateVector(value: unknown, dims = EMBEDDING_DIMS): VectorProblem | null {
  if (!Array.isArray(value)) return "not_array";
  if (value.length !== dims) return "wrong_dims";
  if (!value.every((x) => typeof x === "number" && Number.isFinite(x))) return "not_finite";
  if (value.every((x) => x === 0)) return "all_zero";
  return null;
}

export function neuronsFor(tokens: number): number {
  return (tokens * NEURONS_PER_MILLION_TOKENS) / 1e6;
}

export function usdFor(tokens: number): number {
  return (tokens * USD_PER_MILLION_TOKENS) / 1e6;
}

/** Deterministic test double: the text seeds a unit vector, so equal texts embed equally. */
export class FakeEmbeddingClient implements EmbeddingClient {
  readonly calls: string[][] = [];
  private readonly vectorFor?: (text: string, index: number, call: number) => number[] | undefined;
  private readonly fail?: (texts: string[], call: number) => Error | undefined;

  constructor(options: { vectorFor?: FakeEmbeddingClient["vectorFor"]; fail?: FakeEmbeddingClient["fail"] } = {}) {
    this.vectorFor = options.vectorFor;
    this.fail = options.fail;
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    const call = this.calls.length;
    this.calls.push(texts);
    const failure = this.fail?.(texts, call);
    if (failure) throw failure;
    const vectors = texts.map((text, index) => this.vectorFor?.(text, index, call) ?? fakeVector(text));
    return { model: EMBEDDING_MODEL, pooling: EMBEDDING_POOLING, vectors, durationMs: 0 };
  }
}

/** FNV-1a seeds mulberry32; the values are scaled to a unit vector. */
export function fakeVector(text: string, dims = EMBEDDING_DIMS): number[] {
  const next = mulberry32(fnv1a(text));
  const values = Array.from({ length: dims }, () => next() * 2 - 1);
  const norm = Math.hypot(...values) || 1;
  return values.map((x) => x / norm);
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const ch of text) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function retryAfterSeconds(res: Response): number {
  const header = res.headers.get("Retry-After");
  return header && /^\d+$/.test(header) ? Number(header) : 60;
}
