/* =========================================================
   tests/test-page.js
   ブラウザのテストページ（tests/index.html）の表示（architecture.md 13.2 ①）。
   ・全テストを実行し、最上部に「全N件中N件合格」、その下に分類ごとの表
     （ID・内容・入力・期待値・実際の値・合否）を出す。
   ・不合格の行は赤字＋「×」（色だけに頼らない：architecture 13.2）。
   ・画面に文字を入れるときは ui/dom.js の h()（必ずテキストとして入る）を使い、innerHTML は使わない（14.1）。
   ========================================================= */
import { runTests, hasIndexedDB, hasLocalStorage } from './runner.js';
import { cleanupTestDatabases } from './db.test.js';
import { cleanupTestSettings } from './settings-store.test.js';
import { h, clear } from '../js/ui/dom.js';

/** 分類の表示順と、元の資料の章（見出しに添える） */
const CATEGORY_INFO = {
  '計算': 'fx-rules 9.1〜9.3（C・R・J）、14.1 の追加テスト（X・C-18〜C-20・Y）',
  '入力チェック': 'fx-rules 9.4（V-01〜V-19）、14.1 の追加テスト（V-20〜V-32）',
  '通貨ペア': 'fx-rules 10.8（P-01〜P-30）、14.1 の追加テスト（P-31〜P-35）',
  'セッション': 'fx-rules 11.8（S。画面IDの S-01 などとは無関係）、14.1 の追加テスト（Z）',
  '保存処理': 'architecture 6章・8〜10章・15章（DB＝db.js、SV＝trades / images / drafts の保存の土台）。'
    + 'IndexedDB を使うためブラウザでのみ実行。テスト用の別名 DB を作って使い、終わったら削除する（本物の記録には触れない）',
  '設定の保存': 'architecture 7章・15章、requirements 6.3（ST＝settings-store.js）。localStorage を使うためブラウザでのみ実行。'
    + '本物の設定（fxnote:）には触れず、テスト用の接頭辞（fxnote-test:）で読み書きして、終わったら消す',
  '日時': 'architecture 6.6・13.2「日時」・13.3 #4（DT＝datetime.js）。保存形式の生成・入力欄（datetime-local）との変換・'
    + '端末のタイムゾーンが日本以外でも日本時間になること',
  '表示の整形': 'design 6.3・14.3.4・14.3.8（FM＝format.js）。円（＋2,500円・−1,885円・±0円）・pips・ロット・日時・下書きの時刻の表示',
  '一覧': 'analytics 4.2〜4.8・4.11、design 14.3.4〜14.3.10（LV・L・D・N・LF＝filter.js）。並び順・決済日の見出し・本番/デモ別のサマリー・日計・'
    + '「最初の約50件→続き」の切り出し（LV）／絞り込み L-01〜L-27・期間の境目 D-01〜D-09・表記ゆれ N-01〜N-02（analytics 4.11.3 のとおり）／'
    + '条件チップの文言・1項目だけの解除・個数・30分以内の復元・壊れた保存値の補い・通貨ペアの選択肢・日本時間の境目（LF）',
  '詳細画面': 'design 14.4（DV＝detail-view.js・calc.js の calcQuantity）。見出し・全項目の表示・未入力の「—」・保有時間・数量・'
    + 'リスクリワードの 2 行目・円換算レート・手入力のときの参考損益・保有中/決済済みの出し分け・メモ・壊れたデータ',
  '決済画面': 'design 14.2、fx-rules 4.4・4.5・8章（CL＝close-form.js・trades.js の決済の組み立て、FL＝row-flash.js）。入力欄の初期値・下書きの読み込み・'
    + '損益の即時計算・入力チェック（E-08〜E-11・W-02・W-05・W-06）・符号付きの貼り付け・決済と決済の取り消しの組み立て・戻った直後のハイライトの受け渡し',
  'エントリー画面': 'design 14.1、fx-rules 5・8・11章（EF＝entry-form.js・calc.js の calcSlTpPips・trades.js の recompute・choice-list.js の planTagAdd）。'
    + 'セッションの自動判定と手動の優先・下書きの読み直し（T-17 の古い下書きも）・「変更あり」の判定・リスクリワードの表示（14.1.7）・'
    + '警告 W-01・W-03・W-06 とエラー E-01〜E-04・保存する任意項目の組み立て・損切り幅/利確幅・保存時の RR/セッションの再計算・タグの追加の判断',
  '編集・削除': 'design 14.5・14.3.8・14.7.5、fx-rules 4.4・4.5、architecture 9.3・10章（ED＝edit-form.js、DN＝draft-notice.js、DL＝deleted-toast.js）。'
    + '記録→入力欄の値・変更の検出・口座区分を変えたときの1lot（元に戻したら記録時の値）・価格/ロット変更での再計算・手入力損益を変えない・'
    + '保存する記録の組み立て（画像など編集しない項目を落とさない・空は null）・別の画面で変更されたときの重ね合わせ・下書きの対象の判定（元の記録が変わったら破棄）・'
    + '一覧のお知らせ行の文言（1件／［選ぶ］）・削除トーストの受け渡し',
  'チャート画像': 'architecture 11章・design 14.1.9・14.2.10・14.4.6、requirements F-05（IM＝images.js・trades.js・detail-view.js の画像まわり）。'
    + '縮小後の大きさ（長辺1280px・拡大しない）・JPEG の品質の段階（0.82→0.5 で250KB以内、超えたら1024px）・サイズが超えても添付を失敗させない・'
    + '半分ずつ縮める中間の大きさ・4枚の判定・imageIds の組み立て・孤立画像の判定・表示用URLの解放・壊れたBlobの見分け・端末の空き容量・'
    + '決済での画像の追加・詳細の画像グループ。実際の縮小・保存・掃除（Canvas・IndexedDB）は「保存処理」の SV-18 以降',
  'CSV': 'architecture 14.2・design 14.6.5、requirements F-09・6.1（CS＝csv.js）。BOM付きUTF-8・列の見出しと順（6.1 の順、imageIds だけ imageCount）・'
    + 'エスケープ（カンマ・ダブルクォート・改行）・配列の区切り「|」・CSVインジェクション対策（先頭が = + - @ のとき先頭にシングルクォートを付ける。数値は対象外）・'
    + '論理削除の含める/除く・並び順・ファイル名（日本時間）・件数と説明文の文言・1000件・読み戻し・共有シートの使い分けと共有の結果',
  '選択肢の編集': 'design 14.6.3・14.6.4、fx-rules 10.4、architecture 7.1（CH＝choice-list.js・master.js の初期値・settings-store.js）。'
    + '名前のチェック（空白だけ・20文字以内・同じ名前）・追加/削除/並び替え・通貨ペアの追加（E-12〜E-16・W-07）・最後の1つは削除できない・'
    + '「通貨ペアを追加」シートの絞り込み・初期値が master.js にあること・壊れた値の補い方・保存の読み直し・削除した選択肢を持つ記録の表示',
};

function renderSummary(el, { total, passed, failed }) {
  clear(el);
  el.classList.toggle('is-fail', failed > 0);
  el.classList.toggle('is-pass', failed === 0);
  el.append(
    h('p', { class: 't-summary__main num' },
      failed === 0 ? '○ ' : '× ',
      `全${total}件中${passed}件合格`),
    h('p', { class: 't-sub' },
      failed === 0 ? 'すべての期待値と一致しました。' : `不合格が ${failed}件あります。赤字（×）の行を確認してください。`),
  );
}

function renderTables(el, results, onlyFailed) {
  clear(el);
  const categories = [...new Set(results.map((r) => r.category))];
  for (const cat of categories) {
    const all = results.filter((r) => r.category === cat);
    // スキップした行（ブラウザでは確かめられない RL-06 など：T-33）は件数に入れず、「－」で表に残す
    const rows = all.filter((r) => !r.skipped);
    const shown = onlyFailed ? rows.filter((r) => !r.pass) : all;
    const passed = rows.filter((r) => r.pass).length;

    const section = h('section', { class: 't-group' },
      h('h2', { class: 't-group__title' },
        `${cat}`,
        h('span', { class: 't-group__count num' }, `${passed} / ${rows.length} 件合格`)),
      h('p', { class: 't-group__src' }, CATEGORY_INFO[cat] || ''),
    );

    if (shown.length === 0) {
      section.append(h('p', { class: 't-empty' }, '不合格はありません。'));
    } else {
      section.append(h('div', { class: 't-table-wrap' },
        h('table', { class: 't-table' },
          h('thead', {}, h('tr', {},
            h('th', { scope: 'col' }, '合否'),
            h('th', { scope: 'col' }, 'ID'),
            h('th', { scope: 'col' }, '内容'),
            h('th', { scope: 'col' }, '入力'),
            h('th', { scope: 'col' }, '期待値'),
            h('th', { scope: 'col' }, '実際の値'))),
          h('tbody', {}, shown.map((r) => h('tr', { class: r.skipped ? 'is-skip' : r.pass ? 'is-pass' : 'is-fail' },
            h('td', { class: 't-mark' }, r.skipped ? '－' : r.pass ? '○' : '×',
              h('span', { class: 'visually-hidden' }, r.skipped ? 'スキップ' : r.pass ? '合格' : '不合格')),
            // 分類名を付けて表示する（例「セッション S-01」：architecture 13.2）
            h('td', { class: 't-id' }, `${cat} ${r.id}`),
            h('td', {}, r.title),
            h('td', { class: 'num' }, r.input),
            h('td', { class: 'num' }, r.expected),
            h('td', { class: 'num' }, r.actual)))),
        )));
    }
    el.append(section);
  }
}

function renderEnv(el, { results, leftover, leftoverSettings }) {
  let tz = '不明';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* 表示用なので無視 */ }
  const notes = [];
  // スキップの理由ごとに分けて出す（T-33：git を使う RL-06 はブラウザでは必ずスキップになる）
  const storage = results.filter((r) => r.skipped && (r.skipReason === 'indexedDB' || r.skipReason === 'localStorage')).length;
  if (storage) notes.push(`保存処理・設定の保存のテスト ${storage}件は、このブラウザで IndexedDB・localStorage が使えないためスキップしました`);
  for (const r of results.filter((x) => x.skipped && x.skipReason !== 'indexedDB' && x.skipReason !== 'localStorage')) {
    notes.push(`${r.category} ${r.id} は${r.actual}`);
  }
  // 後片付けの結果（各テストは自分の DB を消すので、通常は 0）。databases() がないブラウザでは調べられない
  if (leftover === null) notes.push('残ったテスト用 DB の確認：このブラウザでは調べられません');
  else notes.push(`残っていたテスト用 DB：${leftover}件（削除済み）`);
  if (leftoverSettings !== null) notes.push(`残っていたテスト用の設定：${leftoverSettings}件（削除済み）`);
  el.textContent = `実行環境：${navigator.userAgent}／端末のタイムゾーン ${tz}（セッション判定は端末のタイムゾーンに関係なく日本時間基準で判定します）／${notes.join('／')}`;
}

async function main() {
  // 保存処理のテストは IndexedDB を順番に読み書きするので、全件が終わるまで待ってから表示する
  const summary = await runTests();
  let leftover = null;
  if (hasIndexedDB()) {
    try { leftover = await cleanupTestDatabases(); } catch (e) { console.error('テスト用 DB の後片付けに失敗しました', e); }
  }
  // 設定の保存のテストは各テストで自分のキーを消すので、通常は 0。途中で止まって残ったキー（fxnote-test:…）を消す
  let leftoverSettings = null;
  if (hasLocalStorage()) {
    try { leftoverSettings = cleanupTestSettings(); } catch (e) { console.error('テスト用の設定の後片付けに失敗しました', e); }
  }
  const resultsEl = document.getElementById('results');
  const onlyFailed = document.getElementById('only-failed');

  renderSummary(document.getElementById('summary'), summary);
  renderTables(resultsEl, summary.results, onlyFailed.checked);
  onlyFailed.addEventListener('change', () => renderTables(resultsEl, summary.results, onlyFailed.checked));
  renderEnv(document.getElementById('env'), { results: summary.results, leftover, leftoverSettings });
  // 集計をタブ名にも出す（スマホでタブを切り替えても結果が分かるように）
  document.title = `${summary.failed === 0 ? '○' : '×'} ${summary.passed}/${summary.total} テスト - FXトレードノート`;
}

main().catch((e) => {
  // 実行の仕組みそのものが失敗した場合も、黙って「実行しています…」のまま止まらないようにする
  console.error(e);
  const el = document.getElementById('summary');
  clear(el);
  el.classList.add('is-fail');
  el.append(h('p', { class: 't-summary__main' }, '× テストを最後まで実行できませんでした'), h('p', { class: 't-sub' }, String(e && e.message ? e.message : e)));
});
