/**
 * 分词器（T14/T15）。中文按双字组（bigram），拉丁按词；BM25 与向量哈希共用。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  // 拉丁/数字词
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9._-]*/g)) {
    tokens.push(m[0]);
  }
  // CJK 双字组
  const cjkRuns = lower.matchAll(/[\u4e00-\u9fff]{2,}/g);
  for (const run of cjkRuns) {
    const s = run[0];
    for (let i = 0; i < s.length - 1; i++) {
      tokens.push(s.slice(i, i + 2));
    }
    if (s.length === 1) tokens.push(s);
  }
  // 单个 CJK 字（保证单字查询可命中）
  for (const m of lower.matchAll(/[\u4e00-\u9fff]/g)) {
    tokens.push(m[0]);
  }
  return tokens;
}

export function shaLike(text: string): string {
  // FNV-1a 32bit → hex（教学确定性哈希，非密码学）
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
