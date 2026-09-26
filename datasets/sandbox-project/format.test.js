import assert from "node:assert";
import { formatPrice } from "./format.js";

const checks = [
  [() => formatPrice(5), "$5.00", "整数补两位"],
  [() => formatPrice(3.14159), "$3.14", "四舍五入两位"],
  [() => formatPrice(0), "$0.00", "零"],
];
let failed = 0;
for (const [fn, expected, name] of checks) {
  try {
    assert.strictEqual(fn(), expected);
    console.log(`ok - ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`not ok - ${name}: ${e.message}`);
  }
}
if (failed > 0) {
  console.log(`${failed} CHECK(S) FAILED`);
  process.exit(1);
}
console.log("ALL TESTS PASSED");
