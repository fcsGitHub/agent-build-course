// 价格格式化（含 BUG：负数与小数处理错误，待修复）
export function formatPrice(n) {
  // BUG: 直接拼接未处理小数位
  return "$" + n;
}
