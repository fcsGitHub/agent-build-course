/**
 * 极简安全 markdown 渲染器：产出 React 节点（React 默认转义文本，无 HTML 注入面，
 * 可安全渲染不可信模型输出——L28 注入演示课的样本也不会携带可执行标记）。
 * 支持：代码围栏（语言标签 + 复制）、标题、有序/无序列表、引用、分隔线、
 * 粗体 / 斜体 / 行内码 / 安全链接（仅 http/https/mailto）。
 * 流式友好：未闭合代码围栏按"直到文末"解析，随增量文本自然收敛。
 */
import { useState, type ReactNode } from "react";

type Block =
  | { kind: "code"; lang: string; code: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "hr" }
  | { kind: "para"; text: string };

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length > 0) {
      blocks.push({ kind: "para", text: para.join("\n") });
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(/^```([\w+-]*)\s*$/);
    if (fence) {
      flushPara();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        code.push(lines[i]!);
        i += 1;
      }
      i += 1; // 跳过闭合围栏（未闭合时即为 EOF）
      blocks.push({ kind: "code", lang: fence[1] ?? "", code: code.join("\n") });
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      i += 1;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(/^\s*[-*]\s+(.*)$/);
        if (!m) break;
        items.push(m[1]!);
        i += 1;
      }
      blocks.push({ kind: "list", ordered: false, items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(/^\s*\d+[.)]\s+(.*)$/);
        if (!m) break;
        items.push(m[1]!);
        i += 1;
      }
      blocks.push({ kind: "list", ordered: true, items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(/^>\s?(.*)$/);
        if (!m) break;
        quote.push(m[1]!);
        i += 1;
      }
      blocks.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      i += 1;
      continue;
    }
    para.push(line);
    i += 1;
  }
  flushPara();
  return blocks;
}

const INLINE_PATTERN = /(`[^`\n]+`)|(\*\*[^*\n]+(?:\*(?!\*)[^*\n]*)*\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE_PATTERN)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const token = m[0];
    if (token.startsWith("`")) {
      out.push(<code key={key++} className="md-inline-code">{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      out.push(<strong key={key++}>{renderInline(token.slice(2, -2))}</strong>);
    } else if (token.startsWith("*")) {
      out.push(<em key={key++}>{renderInline(token.slice(1, -1))}</em>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      const href = link[2]!;
      if (/^(https?:\/\/|mailto:)/i.test(href)) {
        out.push(
          <a key={key++} href={href} target="_blank" rel="noreferrer noopener">
            {link[1]}
          </a>,
        );
      } else {
        out.push(link[1]);
      }
    }
    last = idx + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function CodeBlock(props: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  };
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{props.lang || "text"}</span>
        <button className="md-code-copy" onClick={() => void copy()}>
          {copied ? "✓ 已复制" : "复制"}
        </button>
      </div>
      <pre>
        <code>{props.code}</code>
      </pre>
    </div>
  );
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case "code":
      return <CodeBlock key={key} lang={block.lang} code={block.code} />;
    case "heading":
      return (
        <div key={key} className={`md-h md-h${block.level}`}>
          {renderInline(block.text)}
        </div>
      );
    case "list": {
      const items = block.items.map((item, i) => <li key={i}>{renderInline(item)}</li>);
      return block.ordered ? (
        <ol key={key} className="md-list">
          {items}
        </ol>
      ) : (
        <ul key={key} className="md-list">
          {items}
        </ul>
      );
    }
    case "quote":
      return (
        <blockquote key={key} className="md-quote">
          {renderInline(block.text)}
        </blockquote>
      );
    case "hr":
      return <hr key={key} className="md-hr" />;
    case "para":
      return (
        <p key={key} className="md-p">
          {renderInline(block.text)}
        </p>
      );
  }
}

export function Markdown(props: { text: string; className?: string }) {
  return <div className={props.className ?? "md"}>{parseBlocks(props.text).map(renderBlock)}</div>;
}
