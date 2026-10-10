/**
 * 快速排序（QuickSort）
 * ====================
 *
 * 思路（分治法 Divide & Conquer）：
 *   1. 选一个基准值 pivot。
 *   2. 把数组分成三部分：小于 pivot、等于 pivot、大于 pivot。
 *   3. 对小于和大于的两部分递归排序，再拼起来。
 *
 * 本实现特点：
 *   - 三路分区（Dutch National Flag 思想）：对含大量重复元素的数组更高效，
 *     重复元素不会反复参与递归。
 *   - 基准值取中位数（首、中、尾三个元素的中位数），避免已排序/逆序数组
 *     退化成 O(n^2) 的最坏情况。
 *   - 纯函数：不修改输入数组，返回新数组。
 *
 * 复杂度：
 *   - 平均 / 最好：O(n log n)
 *   - 最坏：O(n^2)（概率极低，因基准取中位数）
 *   - 空间：O(log n) 递归栈（平均），O(n) 最坏
 */

/**
 * 返回三个数的中位数。
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @param {(a: unknown, b: unknown) => number} compare
 * @returns {unknown}
 */
export function medianOfThree(a, b, c, compare = defaultCompare) {
  if (compare(a, b) < 0) {
    // a < b
    if (compare(b, c) < 0) return b; // a < b < c
    if (compare(a, c) < 0) return c; // a < c <= b
    return a; // c <= a < b
  }
  // b <= a
  if (compare(a, c) < 0) return a; // b <= a < c
  if (compare(b, c) < 0) return c; // b < c <= a
  return b; // c <= b <= a
}

/**
 * 对数组进行快速排序。
 *
 * @template T
 * @param {T[]} arr 待排序数组（不会被修改）
 * @param {(a: T, b: T) => number} [compare] 比较函数，默认按升序（数字/字符串）
 * @returns {T[]} 排序后的新数组
 *
 * @example
 *   quickSort([3, 1, 2]);                       // [1, 2, 3]
 *   quickSort([3, 1, 2], (a, b) => b - a);      // [3, 2, 1] 降序
 */
export function quickSort(arr, compare = defaultCompare) {
  if (!Array.isArray(arr)) {
    throw new TypeError("quickSort 需要一个数组");
  }
  const out = arr.slice(); // 复制，保持纯函数
  sortRange(out, 0, out.length - 1, compare);
  return out;
}

function defaultCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 对 out[lo..hi] 做原地三路快速排序。
 */
function sortRange(out, lo, hi, compare) {
  // 小数组用插入排序更快（也可直接 return 由递归处理）
  while (lo < hi) {
    // 元素太少时改用插入排序收尾
    if (hi - lo < 16) {
      insertionSort(out, lo, hi, compare);
      return;
    }

    // --- 选基准：首、中、尾三者的中位数 ---
    const mid = lo + ((hi - lo) >> 1);
    const pivot = medianOfThree(out[lo], out[mid], out[hi], compare);

    // --- 三路分区：lt（<pivot）| i（待处理）| gt（>pivot）---
    let lt = lo;
    let i = lo;
    let gt = hi;
    while (i <= gt) {
      const cmp = compare(out[i], pivot);
      if (cmp < 0) {
        swap(out, lt, i);
        lt++;
        i++;
      } else if (cmp > 0) {
        swap(out, i, gt);
        gt--;
      } else {
        i++;
      }
    }
    // 现在：out[lo..lt-1] < pivot，out[lt..gt] == pivot，out[gt+1..hi] > pivot

    // --- 递归较小的一侧，循环处理较大的一侧，递归深度 O(log n) ---
    if (lt - lo < hi - gt) {
      sortRange(out, lo, lt - 1, compare);
      lo = gt + 1;
    } else {
      sortRange(out, gt + 1, hi, compare);
      hi = lt - 1;
    }
  }
}

function insertionSort(out, lo, hi, compare) {
  for (let i = lo + 1; i <= hi; i++) {
    const v = out[i];
    let j = i - 1;
    while (j >= lo && compare(out[j], v) > 0) {
      out[j + 1] = out[j];
      j--;
    }
    out[j + 1] = v;
  }
}

function swap(out, a, b) {
  const t = out[a];
  out[a] = out[b];
  out[b] = t;
}

/* ----------------------------- 示例用法 ----------------------------- */

import { pathToFileURL } from "node:url";

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  console.log("1) 基本升序：", quickSort([10, 7, 8, 9, 1, 5]));
  console.log("2) 含重复值：", quickSort([3, 6, 3, 1, 3, 2, 6, 1]));
  console.log("3) 已排序：  ", quickSort([1, 2, 3, 4, 5]));
  console.log("4) 空数组：  ", quickSort([]));
  console.log("5) 降序自定义：", quickSort([3, 1, 2], (a, b) => b - a));
  console.log(
    "6) 对象数组：  ",
    quickSort(
      [{ n: 3 }, { n: 1 }, { n: 2 }],
      (a, b) => a.n - b.n,
    ).map((x) => x.n),
  );

  // 简单正确性校验
  const big = Array.from({ length: 1000 }, () => Math.floor(Math.random() * 100) - 50);
  const sorted = quickSort(big);
  const ok = sorted.every((v, idx) => idx === 0 || sorted[idx - 1] <= v);
  console.log("7) 随机 1000 个元素（含重复）是否有序:", ok);
}
