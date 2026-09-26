/**
 * Embedding 服务（T14）。两种提供方：
 * - fake-embedding：确定性字符 trigram 哈希向量（离线教学；显式标记 fake）；
 * - openai-compatible：真实 /embeddings 端点。
 * embedding 版本进入索引快照；不同版本向量不得混用（§12.2 版本一致性）。
 */
import { tokenize, shaLike } from "./tokenize";

export const FAKE_EMBEDDING_VERSION = "fake-emb-1";
export const FAKE_EMBEDDING_DIM = 128;

export interface EmbeddingResult {
  vectors: number[][];
  embeddingVersion: string;
}

export interface EmbeddingProfile {
  provider: "fake-embedding" | "openai-compatible";
  endpoint?: string;
  modelId?: string;
  secretRef?: string;
}

function resolveSecret(profile: EmbeddingProfile): string | undefined {
  if (profile.secretRef?.startsWith("env:")) {
    const v = process.env[profile.secretRef.slice(4)];
    return v && v.length > 0 ? v : undefined;
  }
  return undefined;
}

export async function embed(
  profile: EmbeddingProfile,
  texts: string[],
): Promise<EmbeddingResult> {
  if (profile.provider === "fake-embedding") {
    return {
      vectors: texts.map(fakeEmbed),
      embeddingVersion: FAKE_EMBEDDING_VERSION,
    };
  }
  // 真实端点
  const res = await fetch(`${profile.endpoint!.replace(/\/+$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(resolveSecret(profile) ? { authorization: `Bearer ${resolveSecret(profile)}` } : {}),
    },
    body: JSON.stringify({ model: profile.modelId, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`EMBEDDING_HTTP_${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
  const vectors = (json.data ?? []).map((d) => d.embedding);
  if (vectors.length !== texts.length) throw new Error("EMBEDDING_COUNT_MISMATCH");
  return {
    vectors,
    embeddingVersion: `openai-compatible:${profile.modelId}`,
  };
}

/**
 * fake-embedding：字符 trigram + 词哈希到固定维度，L2 归一化。
 * 确定性、离线；相关文本共享大量 trigram → 余弦相似可用于教学检索演示。
 */
export function fakeEmbed(text: string): number[] {
  const v = new Array<number>(FAKE_EMBEDDING_DIM).fill(0);
  const add = (token: string, weight: number): void => {
    const bucket = Number.parseInt(shaLike(token).slice(0, 6), 16) % FAKE_EMBEDDING_DIM;
    v[bucket]! += weight;
  };
  const tokens = tokenize(text);
  for (const t of tokens) {
    add(t, 1);
    add("g:" + t, 0.5);
  }
  // 字符 trigram（捕捉词形相似）
  const compact = text.replace(/\s+/g, "");
  for (let i = 0; i < compact.length - 2; i++) {
    add("t:" + compact.slice(i, i + 3), 0.35);
  }
  // L2 归一化
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function vectorsToBlob(v: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(v).buffer);
}

export function blobToVectors(b: ArrayBuffer, dim: number): number[] {
  const arr = new Float32Array(b);
  return Array.from(arr.slice(0, dim));
}
