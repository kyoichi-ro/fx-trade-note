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
import { collectCloseFormTests } from './close-form.test.js';
import { collectChoiceListTests } from './choice-list.test.js';
import { collectEntryFormTests } from './entry-form.test.js';
import { collectEditFormTests } from './edit-form.test.js';
import { collectImageTests } from './images.test.js';
import { collectCsvTests } from './csv.test.js';
import { collectDataProtectionTests } from './data-protection.test.js';
import { collectReleaseTests } from './release.test.js';

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
    ...collectFilterTests(),   // 一覧（LV）25件（T-19。並び順・日付見出し・サマリー・日計・続き読み込み）＋T-23 の60件（L-01〜L-27・D-01〜D-09・N-01〜N-02 の38件＋条件の扱い LF 22件：analytics 4.2〜4.11）。Node.js でも実行する
    ...collectDetailViewTests(), // 詳細画面の表示内容（DV）30件（T-20。全項目・未入力の「—」・保有時間・数量・RR の 2 行目・出し分け：design 14.4）。Node.js でも実行する
    ...collectCloseFormTests(),  // 決済画面（CL・FL）28件（T-21。入力チェック・損益の即時計算・符号付きの貼り付け・決済/取り消しの組み立て・ハイライトの受け渡し：design 14.2）。Node.js でも実行する
    ...collectEntryFormTests(),  // エントリー画面（EF）36件（T-18。セッションの自動判定と手動の優先・下書きの読み直し・RR の表示と W-01 などの警告・損切り幅/利確幅・保存時の再計算・タグの追加の判断：design 14.1）。Node.js でも実行する
    ...collectEditFormTests(),   // 編集・削除（ED・DN・DL）T-22。記録→入力欄・変更の検出・口座区分変更時の1lot・再計算・保存する記録の組み立て・別の画面で変更されたときの重ね合わせ・下書きの対象の判定とお知らせ行・削除トーストの受け渡し：design 14.5・14.3.8・14.7.5。Node.js でも実行する
    ...collectImageTests(),      // チャート画像（IM）T-24。縮小後の大きさ・JPEG の品質の段階と250KB・サイズが超えても失敗させない・半分ずつ縮める・4枚の判定・imageIds の組み立て・孤立画像の判定・表示用URLの解放・壊れたBlobの見分け・空き容量・決済での画像の追加：architecture 11章・design 14.1.9。Node.js でも実行する
    ...collectCsvTests(),        // CSVエクスポート（CS）T-25。BOM・列の見出しと順・エスケープ・配列の区切り・CSVインジェクション対策・論理削除の含める/除く・ファイル名・1000件・読み戻し・共有シートの使い分け：architecture 14.2・design 14.6.5。Node.js でも実行する
    ...collectDataProtectionTests(), // データ保護（DP）15件 T-29。ホーム画面版・iPhone の判定・お知らせ行を出す条件・今の状態の文言・永続化リクエスト（保護済みなら頼まない・1回の起動で1回）・データの保護の値と説明文・使用量の表示：architecture 12.5・design 14.3.8・14.6.1・14.6.2・14.6.6。Node.js でも実行する
    ...collectChoiceListTests(), // 選択肢の編集（CH）35件（T-16。名前のチェック・追加/削除/並び替え・通貨ペアの追加 E-12〜E-16・W-07・初期値の master.js への移動・保存の読み直し：design 14.6.3・14.6.4）。Node.js でも実行する
    ...collectReleaseTests(),    // リリース確認（RL・SU）8件 T-28。sw.js と config.js のバージョンの一致・キャッシュの一覧（SHELL_FILES）の書き忘れ／消し忘れ・Service Worker を登録するかの判定と更新の確認の間隔：architecture 12章・13.2・18.4。Node.js でも実行する（ブラウザでは fetch でファイルを読む）
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
