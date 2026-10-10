/**
 * 二分查找（Binary Search）
 * ========================
 *
 * 前提：**数组必须已按 compare 升序排好序**（调用方负责保证）。
 *
 * 本文件提供三个互补的函数，覆盖绝大多数使用场景：
 *   - lowerBound(arr, target)：第一个 >= target 的下标（不存在则 arr.length）
 *   - upperBound(arr, target)：第一个 >  target 的下标（不存在则 arr.length）
 *   - binarySearch(arr, target)：任意一个等于 target 的下标，找不到返回 -1
 *
 * 为什么优先用 lowerBound / upperBound：
 *   - 「任意一个」版本在含重复元素的数组上返回哪个下标不确定，容易写出脆弱代码；
 *     lowerBound/upperBound 的结果是确定的，且可以直接推导出：
 *       · 命中区间     [lowerBound, upperBound)
 *       · 是否存在     lowerBound < arr.length && arr[lowerBound] === target
 *       · 出现次数     upperBound - lowerBound
 *       · 插入位置     lowerBound（保持有序）
 *
 * 实现要点（避免常见坑）：
 *   - 用**半开区间 [lo, hi)**，循环条件 `lo < hi`，mid 用 `lo + ((hi-lo)>>1)`
 *     防止 lo+hi 溢出，也不会死循环。
 *   - 每次收缩区间，区间长度严格减小，必然终止。
 *   - 纯函数：不修改输入。
 *
 * 复杂度：时间 O(log n)，空间 O(1)。
 */

/**
 * 默认比较函数：升序。返回负数/0/正数分别表示 a<b、a==b、a>b。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
export function defaultCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 第一个 **大于等于** target 的元素下标。
 * 返回值范围 [0, arr.length]：等于 arr.length 表示所有元素都 < target。
 *
 * @template T
 * @param {T[]} arr 已按 compare 升序排序的数组
 * @param {T} target
 * @param {(a: T, b: T) => number} [compare]
 * @returns {number}
 */
export function lowerBound(arr, target, compare = defaultCompare) {
  assertArray(arr);
  let lo = 0;
  let hi = arr.length; // 半开区间 [lo, hi)
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    if (compare(arr[mid], target) < 0) {
      lo = mid + 1; // arr[mid] < target → 答案在右半区
    } else {
      hi = mid; // arr[mid] >= target → mid 可能是答案，保留
    }
  }
  return lo;
}

/**
 * 第一个 **严格大于** target 的元素下标。
 * 返回值范围 [0, arr.length]：等于 arr.length 表示所有元素都 <= target。
 *
 * @template T
 * @param {T[]} arr
 * @param {T} target
 * @param {(a: T, b: T) => number} [compare]
 * @returns {number}
 */
export function upperBound(arr, target, compare = defaultCompare) {
  assertArray(arr);
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    if (compare(arr[mid], target) <= 0) {
      lo = mid + 1; // arr[mid] <= target → 答案在右半区
    } else {
      hi = mid; // arr[mid] > target → mid 可能是答案，保留
    }
  }
  return lo;
}

/**
 * 查找任意一个等于 target 的元素下标，找不到返回 -1。
 * 在含重复元素的数组上，返回的是 lowerBound（第一个匹配位置）。
 *
 * @template T
 * @param {T[]} arr
 * @param {T} target
 * @param {(a: T, b: T) => number} [compare]
 * @returns {number} 下标或 -1
 */
export function binarySearch(arr, target, compare = defaultCompare) {
  const i = lowerBound(arr, target, compare);
  if (i < arr.length && compare(arr[i], target) === 0) return i;
  return -1;
}

/**
 * 统计 target 在有序数组中出现的次数。
 * @template T
 * @param {T[]} arr
 * @param {T} target
 * @param {(a: T, b: T) => number} [compare]
 * @returns {number}
 */
export function countOccurrences(arr, target, compare = defaultCompare) {
  return upperBound(arr, target, compare) - lowerBound(arr, target, compare);
}

function assertArray(arr) {
  if (!Array.isArray(arr)) {
    throw new TypeError("二分查找需要一个数组");
  }
}

/* ----------------------------- 示例用法 ----------------------------- */

import { pathToFileURL } from "node:url";

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const arr = [1, 3, 3, 3, 5, 7, 9];

  console.log("数组：", arr);
  console.log("1) binarySearch(5)      =", binarySearch(arr, 5)); // 4
  console.log("2) binarySearch(6)      =", binarySearch(arr, 6)); // -1
  console.log("3) lowerBound(3)        =", lowerBound(arr, 3)); // 1
  console.log("4) upperBound(3)        =", upperBound(arr, 3)); // 4
  console.log("5) countOccurrences(3)  =", countOccurrences(arr, 3)); // 3
  console.log("6) lowerBound(0)        =", lowerBound(arr, 0)); // 0（插入位置）
  console.log("7) lowerBound(100)      =", lowerBound(arr, 100)); // 7（插入到末尾）
  console.log("8) 空数组 binarySearch  =", binarySearch([], 1)); // -1
  console.log(
    "9) 降序自定义 compare   =",
    binarySearch([9, 7, 5, 3, 1], 5, (a, b) => b - a),
  ); // 2
  console.log(
    "10) 对象数组 lowerBound =",
    lowerBound([{ n: 1 }, { n: 3 }, { n: 5 }], { n: 4 }, (a, b) => a.n - b.n),
  ); // 2

  // 与线性扫描对拍：随机有序数组，验证三个函数结论一致
  let allOk = true;
  for (let trial = 0; trial < 2000; trial += 1) {
    const size = Math.floor(Math.random() * 40);
    const sorted = [];
    for (let i = 0; i < size; i += 1) sorted.push(Math.floor(Math.random() * 20) - 10);
    sorted.sort((a, b) => a - b);

    const target = Math.floor(Math.random() * 22) - 11;
    const expected = sorted.findIndex((v) => v === target);
    const got = binarySearch(sorted, target);
    const lb = lowerBound(sorted, target);
    const ub = upperBound(sorted, target);

    if ((got === -1) !== (expected === -1)) allOk = false;
    if (got !== -1 && sorted[got] !== target) allOk = false;
    if (ub - lb !== sorted.filter((v) => v === target).length) allOk = false;
    if (lb > 0 && !(sorted[lb - 1] < target)) allOk = false;
    if (lb < sorted.length && !(sorted[lb] >= target)) allOk = false;
    if (ub > 0 && !(sorted[ub - 1] <= target)) allOk = false;
    if (ub < sorted.length && !(sorted[ub] > target)) allOk = false;
  }
  console.log("11) 随机对拍 2000 次（对比线性扫描）:", allOk ? "全部通过" : "存在不一致");
}
