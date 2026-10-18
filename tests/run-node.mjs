/* =========================================================
   tests/run-node.mjs
   テストを Node.js で実行する入口（architecture.md 13.2 ②・18.6）。
   使い方：プロジェクトのフォルダで  node tests/run-node.mjs
     ・全件の結果を1行ずつ表示し、最後に「全N件中N件合格」を出す
     ・不合格が1件でもあれば終了コード 1（自動チェックに組み込めるように）
     ・保存処理（IndexedDB）・設定の保存（localStorage）のテストは Node.js では動かせないためスキップする（件数は最後に表示）
   正（完了確認に使うの）はブラウザのテストページ tests/index.html。こちらはコードを直すたびの手早い確認用。
   ========================================================= */
import { runTests } from './runner.js';

const { results, total, passed, failed, skipped } = await runTests();

let lastCategory = '';
for (const r of results) {
  if (r.skipped) continue;
  if (r.category !== lastCategory) {
    console.log(`\n■ ${r.category}`);
    lastCategory = r.category;
  }
  console.log(`  ${r.pass ? '○' : '×'} ${r.id}  ${r.title}`);
  if (!r.pass) {
    console.log(`      入力：${r.input}`);
    console.log(`      期待：${r.expected}`);
    console.log(`      実際：${r.actual}`);
  }
}

console.log('\n----------------------------------------');
console.log(`全${total}件中${passed}件合格${failed ? `（不合格 ${failed}件）` : ''}`);
if (skipped) {
  // スキップの理由ごとに分けて出す（T-33：git が使えないときの RL-06 が加わった）
  const BROWSER_ONLY = ['indexedDB', 'localStorage', 'dom'];
  const storage = results.filter((r) => r.skipped && BROWSER_ONLY.includes(r.skipReason)).length;
  const others = results.filter((r) => r.skipped && !BROWSER_ONLY.includes(r.skipReason));
  if (storage) {
    console.log(`※ 保存処理・設定の保存・画面の部品のテスト ${storage}件は、IndexedDB・localStorage・document が Node.js で使えないためスキップしました。`
      + 'ブラウザで http://localhost:8000/tests/ を開いて実行してください。');
  }
  for (const r of others) console.log(`※ ${r.category} ${r.id} は${r.actual}`);
}
console.log(`Node.js ${process.version}／端末のタイムゾーン ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
process.exitCode = failed ? 1 : 0;
