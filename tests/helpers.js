/* =========================================================
   tests/helpers.js
   テスト用の小さな道具（比較と表示）。*.test.js から使う。ブラウザでも Node.js でも動くよう document 等は使わない。
   ========================================================= */

/**
 * 小数を「scale 倍した整数」に直す（pips は ×10、RR は ×100）。
 * fx-rules 9.5・6.3 ルール5：計算結果どうしを === で比べず、整数に直してから比べるため。
 * テストに出てくる値は整数のごく近く（-377.00000000000006 など）なので Math.round で正しく整数になる。
 */
export function toInt(x, scale) {
  return x == null ? null : Math.round(x * scale);
}

/** 符号付きで小数 digits 桁の文字にする（表示用。例 25 → '+25.0'、-37.7 → '-37.7'、0 → '0.0'） */
export function signed(x, digits) {
  if (x == null) return 'null';
  const s = x.toFixed(digits);
  if (x > 0) return `+${s}`;
  return Number(s) === 0 ? (0).toFixed(digits) : s; // 「-0.0」と出さない
}

/** 円の表示（例 2500 → '+2,500'、-1885 → '-1,885'）。null は 'null' */
export function yen(x) {
  if (x == null) return 'null';
  const s = Math.abs(x).toLocaleString('en-US');
  return x > 0 ? `+${s}` : x < 0 ? `-${s}` : '0';
}

/** 配列どうしが同じ並びで同じ値か */
export function sameArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 表示用：値を短い文字にする（文字列は「'」で囲み、どこからどこまでが入力か分かるようにする） */
export function show(v) {
  if (v === null) return 'null';
  if (v === undefined) return '—';
  if (typeof v === 'string') return `'${v}'`;
  if (Array.isArray(v)) return `[${v.map(show).join(', ')}]`;
  return String(v);
}
