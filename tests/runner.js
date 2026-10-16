/* =========================================================
   tests/runner.js
   小さなテスト実行の仕組み（architecture.md 4.1・13.2）。ブラウザのテストページ（tests/index.html）と
   Node.js（tests/run-node.mjs）の両方から同じものを使う。そのため document も process も使わない。

   テスト1件の定義（*.test.js が返す形）：
     { category: '計算', id: 'C-01', title: '…', input: '入力の説明', expected: '期待値の説明',
       requires: 'indexedDB',   // 省略可。IndexedDB が必要なテスト（保存処理）、'localStorage'＝設定の保存（T-15）に付ける
       run: () => ({ actual: '実際の値の説明', pass: true/false }) }   // Promise を返してもよい
   比較・表示の小さな道具は tests/helpers.js（runner.js と *.test.js が互いに import し合わないよう分けた）。

   IndexedDB は Node.js にないため、requires: 'indexedDB' のテストは Node では「スキップ」として数え、
   合否の件数には含めない（ブラウザのテストページで実行する：T-12）。
   requires: 'localStorage'（設定の保存：T-15）も同じく、ブラウザでだけ実行する。
   ========================================================= */
import { collectCalcTests, collectSessionTests } from './calc.test.js';
import { collectValidateTests } from './validate.test.js';
import { collectPairTests } from './pairs.test.js';
import { collectDbTests } from './db.test.js';
import { collectSettingsStoreTests } from './settings-store.test.js';
import { collectDatetimeTests } from './datetime.test.js';
import { collectFormatTests } from './format.test.js';
import { collectFilterTests } from './filter.test.js';
import { collectDetailViewTests } from './detail-view.test.js';

/** すべてのテストの定義を、表示する順番（architecture 13.2 の表の順）で集める */
export function collectAllTests() {
  return [
    ...collectCalcTests(),     // 計算（C・R・J）35件＋fx-rules 14.1（X 8・C-18〜C-20 3・Y 6）17件
    ...collectValidateTests(), // 入力チェック（V）19件＋fx-rules 14.1（V-20〜V-32）13件
    ...collectPairTests(),     // 通貨ペア（P）30件＋fx-rules 14.1（P-31〜P-35）5件
    ...collectSessionTests(),  // セッション（S）35件＋fx-rules 14.1（Z）9件
    ...collectDbTests(),       // 保存処理（DB・SV）※ブラウザのみ
    ...collectSettingsStoreTests(), // 設定の保存（ST）※ブラウザのみ（T-15）
    ...collectDatetimeTests(), // 日時（DT）15件（T-17。architecture 13.2「日時」・13.3 #4）。Node.js でも実行する
    ...collectFormatTests(),   // 表示の整形（FM）18件（T-19 の15件＋T-20 の保有時間・数量・値幅 pips・確認シート用の日時）。Node.js でも実行する
    ...collectFilterTests(),   // 一覧の集計（LV）25件（T-19。並び順・日付見出し・サマリー・日計・続き読み込み：analytics 4.6・4.7・4.11）。Node.js でも実行する
    ...collectDetailViewTests(), // 詳細画面の表示内容（DV）30件（T-20。全項目・未入力の「—」・保有時間・数量・RR の 2 行目・出し分け：design 14.4）。Node.js でも実行する
  ];
}

/** この環境で IndexedDB が使えるか */
export function hasIndexedDB() {
  return typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB !== null;
}

/**
 * この環境で（ブラウザの）localStorage が使えるか。
 * Node.js の版によっては globalThis.localStorage があっても中身が使えないことがあるため、ブラウザ（window）に限る。
 * Safari でサイトデータを禁止しているときなどは、触っただけで例外になるので false。
 */
export function hasLocalStorage() {
  if (typeof window === 'undefined') return false;
  try {
    return Boolean(window.localStorage);
  } catch (e) {
    return false;
  }
}

/**
 * テストを1件ずつ順番に実行して結果を返す（保存処理のテストが同時に DB を触って干渉しないよう、並列にはしない）。
 * 1件が例外で止まっても他のテストは続けて実行し、その件は「不合格（例外）」として記録する。
 * @param {object[]} [defs]
 * @param {{canUseIndexedDB?: boolean, canUseLocalStorage?: boolean}} [options]
 * @returns {Promise<{results: object[], total: number, passed: number, failed: number, skipped: number}>}
 *   total は実行した件数（スキップは含まない）
 */
export async function runTests(defs = collectAllTests(), { canUseIndexedDB = hasIndexedDB(), canUseLocalStorage = hasLocalStorage() } = {}) {
  const results = [];
  for (const d of defs) {
    const base = { category: d.category, id: d.id, title: d.title, input: d.input, expected: d.expected };
    if (d.requires === 'indexedDB' && !canUseIndexedDB) {
      results.push({ ...base, actual: 'スキップ（IndexedDB がない環境）', pass: false, skipped: true });
      continue;
    }
    if (d.requires === 'localStorage' && !canUseLocalStorage) {
      results.push({ ...base, actual: 'スキップ（localStorage がない環境）', pass: false, skipped: true });
      continue;
    }
    try {
      const { actual, pass } = await d.run();
      results.push({ ...base, actual, pass: pass === true });
    } catch (e) {
      results.push({ ...base, actual: `例外：${e && e.message ? e.message : String(e)}`, pass: false });
    }
  }
  const ran = results.filter((r) => !r.skipped);
  const passed = ran.filter((r) => r.pass).length;
  return {
    results,
    total: ran.length,
    passed,
    failed: ran.length - passed,
    skipped: results.length - ran.length,
  };
}
