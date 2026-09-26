/** 简易行级 LCS diff（教学对照展示用） */
export type DiffLine = { kind: "same" | "add" | "del"; text: string };

export function lineDiff(a: string, b: string): DiffLine[] {
  const al = a.split("\n");
  const bl = b.split("\n");
  const n = al.length;
  const m = bl.length;
  // LCS DP 表（行数受控：课程文件都是小文件）
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = al[i] === bl[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      out.push({ kind: "same", text: al[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "del", text: al[i]! });
      i += 1;
    } else {
      out.push({ kind: "add", text: bl[j]! });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: "del", text: al[i]! });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: "add", text: bl[j]! });
    j += 1;
  }
  return out;
}
