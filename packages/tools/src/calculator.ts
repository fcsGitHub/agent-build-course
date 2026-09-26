/**
 * calculator：确定性表达式求值。递归下降解析器（+ - * / ( ) 一元负号、小数），
 * 绝不 eval/Function。
 */
import type { JsonValue, ToolExecutionResult, ToolExecutionContext, ToolHandler } from "@agentglass/contracts";

export function evaluateExpression(input: string): number {
  const tokens = tokenize(input);
  const parser = new Parser(tokens);
  const value = parser.parseExpression();
  parser.expectEnd();
  return value;
}

type Token = { kind: "num"; value: number } | { kind: "op"; value: string } | { kind: "paren"; value: "(" | ")" };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j]!)) j += 1;
      const numStr = input.slice(i, j);
      const value = Number(numStr);
      if (Number.isNaN(value)) throw new Error(`CALC_INVALID_NUMBER: ${numStr}`);
      tokens.push({ kind: "num", value });
      i = j;
      continue;
    }
    if ("+-*/".includes(ch)) {
      tokens.push({ kind: "op", value: ch });
      i += 1;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ kind: "paren", value: ch });
      i += 1;
      continue;
    }
    throw new Error(`CALC_INVALID_CHAR: ${ch}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}
  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token | undefined {
    const t = this.tokens[this.pos];
    this.pos += 1;
    return t;
  }
  parseExpression(): number {
    // 加减
    let left = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t && t.kind === "op" && (t.value === "+" || t.value === "-")) {
        this.next();
        const right = this.parseTerm();
        left = t.value === "+" ? left + right : left - right;
      } else {
        return left;
      }
    }
  }
  parseTerm(): number {
    // 乘除
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t && t.kind === "op" && (t.value === "*" || t.value === "/")) {
        this.next();
        const right = this.parseUnary();
        if (t.value === "/" && right === 0) throw new Error("CALC_DIVISION_BY_ZERO");
        left = t.value === "*" ? left * right : left / right;
      } else {
        return left;
      }
    }
  }
  parseUnary(): number {
    const t = this.peek();
    if (t && t.kind === "op" && t.value === "-") {
      this.next();
      return -this.parseUnary();
    }
    if (t && t.kind === "op" && t.value === "+") {
      this.next();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }
  parsePrimary(): number {
    const t = this.next();
    if (!t) throw new Error("CALC_UNEXPECTED_END");
    if (t.kind === "num") return t.value;
    if (t.kind === "paren" && t.value === "(") {
      const v = this.parseExpression();
      const close = this.next();
      if (!close || close.kind !== "paren" || close.value !== ")") {
        throw new Error("CALC_UNBALANCED_PAREN");
      }
      return v;
    }
    throw new Error(`CALC_UNEXPECTED_TOKEN: ${JSON.stringify(t)}`);
  }
  expectEnd(): void {
    if (this.pos !== this.tokens.length) {
      throw new Error(`CALC_TRAILING_INPUT: ${JSON.stringify(this.tokens.slice(this.pos))}`);
    }
  }
}

export const CALCULATOR_TOOL: ToolHandler = {
  revision: {
    toolId: "calculator",
    revision: "1.0.0",
    title: "确定性计算器",
    description: "对算术表达式（+ - * / 与括号）做确定性求值，例如 '12+34*2'。",
    riskLevel: "readonly_pure",
    parametersSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "算术表达式" },
      },
      required: ["expression"],
    },
    idempotent: true,
    supportsStatusQuery: false,
  },
  async execute(args, _ctx): Promise<ToolExecutionResult> {
    void _ctx;
    const parsed = args as { expression?: unknown };
    if (typeof parsed.expression !== "string" || parsed.expression.length === 0) {
      return { status: "failed", reasonCode: "INVALID_ARGUMENTS", errorMessage: "expression 必须是非空字符串" };
    }
    if (parsed.expression.length > 10_000) {
      return { status: "failed", reasonCode: "EXPRESSION_TOO_LONG", errorMessage: "表达式过长" };
    }
    try {
      const value = evaluateExpression(parsed.expression);
      const summary: JsonValue = { expression: parsed.expression, value };
      return { status: "succeeded", outputSummary: summary };
    } catch (err) {
      return {
        status: "failed",
        reasonCode: "EVALUATION_FAILED",
        errorMessage: String(err).slice(0, 300),
      };
    }
  },
};
