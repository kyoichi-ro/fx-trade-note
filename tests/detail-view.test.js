/* =========================================================
   tests/detail-view.test.js
   詳細画面に出す内容の組み立て（js/detail-view.js、calc.js の calcQuantity）のテスト（T-20。design.md 14.4）。
   ・見出し（損益・pips の符号と色、保有中の「151.234 で保有中・2時間15分」）
   ・全項目の表示と、未入力の任意項目が「—」になること（行は消えない）
   ・保有時間・数量（記録時の 1lot）・リスクリワードの 2 行目・円換算レート・手入力のときの「自動計算（参考）」
   ・「決済済み／保有中」の出し分け（決済価格か決済日時が欠けた記録は保有中扱い）
   ・メモ（全文・改行・HTML に見える文字をそのまま）、壊れたデータでも例外にならないこと
   画面（document）も IndexedDB も使わないので、Node.js でもブラウザでも実行する。

   ID：DV-xx（詳細画面の表示内容）
   ========================================================= */
import { buildDetailView, describeTrade, quantityText, EMPTY } from '../js/detail-view.js';
import { calcQuantity } from '../js/calc.js';
import { show } from './helpers.js';

const CATEGORY = '詳細画面';

/** 「今」＝ 2026-10-15（木）23:30（日本時間） */
const NOW = new Date('2026-10-15T23:30:00+09:00');

function verdict(checks) {
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) return { actual: `確認${checks.length}項目すべて一致`, pass: true };
  return { actual: failed.map(([label, , detail]) => `×${label}（実際：${show(detail)}）`).join('／'), pass: false };
}

const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run });

/** 項目名（key）から行を取り出す */
function rowOf(view, key) {
  for (const s of view.sections) {
    const r = s.rows.find((x) => x.key === key);
    if (r) return r;
  }
  return undefined;
}
const valueOf = (view, key) => (rowOf(view, key) ? rowOf(view, key).value : '（行なし）');
const sectionKeys = (view) => view.sections.map((s) => s.key).join(',');

/** 記録 1 件（design 14.4.2 の例：USD/JPY 買い 0.5lot、エントリー 151.234 → 決済 151.487、保有 1時間35分、＋1,265円） */
function closedTrade(extra = {}) {
  return {
    id: 'a1', accountType: 'real', pair: 'USD/JPY', side: 'buy',
    entryPrice: 151.234, entryAt: '2026-10-15T21:30:00+09:00', lots: 0.5, lotUnitSize: 10000,
    slPrice: 151.034, tpPrice: 151.634, riskReward: 2,
    exitPrice: 151.487, exitAt: '2026-10-15T23:05:00+09:00', pips: 25.3, profitJpy: 1265, profitSource: 'auto',
    quoteToJpyRate: null, status: 'closed',
    entryReasons: ['トレンドフォロー'], timeframe: 'M15', session: 'newyork', emotion: '冷静',
    exitReason: 'manual', exitEmotion: '冷静', tags: ['指標前', 'ルール違反'], memo: 'NY開始直後の上抜けで買い。\n指標前に半分の値幅で手動決済。',
    imageIds: [], syncStatus: 'pending', syncedAt: null, deletedAt: null,
    createdAt: '2026-10-15T21:31:00+09:00', updatedAt: '2026-10-15T23:06:00+09:00',
    ...extra,
  };
}

/** 保有中（決済情報なし） */
function openTrade(extra = {}) {
  return closedTrade({
    exitPrice: null, exitAt: null, pips: null, profitJpy: null, profitSource: null, status: 'open',
    exitReason: null, exitEmotion: null, ...extra,
  });
}

/** 任意項目がすべて空の保有中 */
function bareOpenTrade(extra = {}) {
  return openTrade({
    slPrice: null, tpPrice: null, riskReward: null, entryReasons: [], timeframe: null, session: null, emotion: null,
    tags: [], memo: null, ...extra,
  });
}

export function collectDetailViewTests() {
  return [
    t('DV-01', '決済済み・利益（design 14.4.2 の例）：見出しと「エントリー」「決済」「タグ・メモ」のグループ', 'USD/JPY 買い 0.5lot 151.234→151.487 ＋1,265円',
      "バッジ real/closed・'＋1,265円'(profit)・'＋25.3 pips'(profit)・グループ entry,exit,memo",
      () => {
        const v = buildDetailView(closedTrade(), NOW);
        return verdict([
          ['決済済み', v.closed === true, v.closed],
          ['口座・状態', v.head.account === 'real' && v.head.status === 'closed', `${v.head.account}/${v.head.status}`],
          ['通貨ペア・方向', v.head.pair === 'USD/JPY' && v.head.side === 'buy', `${v.head.pair}/${v.head.side}`],
          ['損益', v.head.profit.text === '＋1,265円' && v.head.profit.tone === 'profit', show(v.head.profit.text)],
          ['pips', v.head.pips.text === '＋25.3 pips' && v.head.pips.tone === 'profit', show(v.head.pips.text)],
          ['手入力ではない', v.head.manual === false, v.head.manual],
          ['保有中の一行はない', v.head.openLine === null, v.head.openLine],
          ['グループ', sectionKeys(v) === 'entry,exit,memo', sectionKeys(v)],
          ['決済を取り消せる', v.canCancelClose === true, v.canCancelClose],
        ]);
      }),

    t('DV-02', '決済済み・損失と±0：符号と色（色は記号と併用）', '−1,885円／±0円',
      "'−1,885円'(loss)／'±0円'(even)・'±0.0 pips'(even)",
      () => {
        const loss = buildDetailView(closedTrade({ profitJpy: -1885, pips: -37.7 }), NOW);
        const even = buildDetailView(closedTrade({ profitJpy: 0, pips: 0 }), NOW);
        return verdict([
          ['損失の円', loss.head.profit.text === '−1,885円' && loss.head.profit.tone === 'loss', loss.head.profit.text],
          ['損失の pips', loss.head.pips.text === '−37.7 pips' && loss.head.pips.tone === 'loss', loss.head.pips.text],
          ['ゼロの円', even.head.profit.text === '±0円' && even.head.profit.tone === 'even', even.head.profit.text],
          ['ゼロの pips', even.head.pips.text === '±0.0 pips' && even.head.pips.tone === 'even', even.head.pips.text],
        ]);
      }),

    t('DV-03', '円が損失でも pips は自分の符号で色を付ける（一覧と同じ）', '手入力 −30円・pips ＋0.5',
      "円 loss・pips profit・手入力 true",
      () => {
        const v = buildDetailView(closedTrade({ profitJpy: -30, pips: 0.5, profitSource: 'manual' }), NOW);
        return verdict([
          ['円', v.head.profit.tone === 'loss', v.head.profit.tone],
          ['pips', v.head.pips.tone === 'profit', v.head.pips.tone],
          ['手入力', v.head.manual === true, v.head.manual],
        ]);
      }),

    t('DV-04', 'エントリーのグループ：全項目の表示（日時・価格・ロット・数量・SL・TP・RR・セッション・時間足・根拠・感情）', 'DV-01 の記録',
      "'10/15(木) 21:30'・'151.234'・'0.5lot'・'5,000通貨（1lot＝10,000）'・'151.034'・'151.634'・'2.00'・'ニューヨーク'・'15分'・'トレンドフォロー'・'冷静'",
      () => {
        const v = buildDetailView(closedTrade(), NOW);
        const want = [
          ['entryAt', '10/15(木) 21:30'], ['entryPrice', '151.234'], ['lots', '0.5lot'],
          ['quantity', '5,000通貨（1lot＝10,000）'], ['slPrice', '151.034'], ['tpPrice', '151.634'],
          ['riskReward', '2.00'], ['session', 'ニューヨーク'], ['timeframe', '15分'],
          ['entryReasons', 'トレンドフォロー'], ['emotion', '冷静'],
        ];
        return verdict(want.map(([key, value]) => [`${key}=${value}`, valueOf(v, key) === value, valueOf(v, key)]));
      }),

    t('DV-05', '決済のグループ：日時・価格・保有時間・損益の算出・決済理由・決済時の感情。自動計算の注記は自動計算のときだけ', 'DV-01 の記録',
      "'10/15(木) 23:05'・'151.487'・'1時間35分'・'自動計算'・'裁量決済'・'冷静'・注記あり。JPY ペアに円換算レートの行なし。参考の行なし",
      () => {
        const v = buildDetailView(closedTrade(), NOW);
        const exit = v.sections.find((s) => s.key === 'exit');
        const want = [
          ['exitAt', '10/15(木) 23:05'], ['exitPrice', '151.487'], ['holding', '1時間35分'],
          ['profitSource', '自動計算'], ['exitReason', '裁量決済'], ['exitEmotion', '冷静'],
        ];
        return verdict([
          ...want.map(([key, value]) => [`${key}=${value}`, valueOf(v, key) === value, valueOf(v, key)]),
          ['注記', exit.footer === '自動計算はスワップ・手数料を含みません。', exit.footer],
          ['円換算レートの行なし', rowOf(v, 'quoteToJpyRate') === undefined, rowOf(v, 'quoteToJpyRate')],
          ['参考の行なし', rowOf(v, 'referenceProfit') === undefined, rowOf(v, 'referenceProfit')],
        ]);
      }),

    t('DV-06', '手入力の損益：「手入力（業者の確定値）」＋「自動計算（参考）」の行（色なしの数字）。注記は出さない', '手入力 −5,700円（自動計算なら＋1,265円）',
      "損益の算出 '手入力（業者の確定値）'・参考 '＋1,265円'・注記 null",
      () => {
        const v = buildDetailView(closedTrade({ profitJpy: -5700, profitSource: 'manual' }), NOW);
        const exit = v.sections.find((s) => s.key === 'exit');
        return verdict([
          ['算出', valueOf(v, 'profitSource') === '手入力（業者の確定値）', valueOf(v, 'profitSource')],
          ['参考は calc.js の結果', valueOf(v, 'referenceProfit') === '＋1,265円', valueOf(v, 'referenceProfit')],
          ['見出しは保存済みの確定値', v.head.profit.text === '−5,700円', v.head.profit.text],
          ['注記なし', exit.footer === null, exit.footer],
        ]);
      }),

    t('DV-07', '非JPY ペア：円換算レートの行（USD/JPY 149.850）。JPY ペアでは行ごと出さない。非JPY でレートが空なら「—」。手入力でレートなしの参考は「—」', 'EUR/USD 買い 1.08500→1.08750・レート 149.85',
      "'USD/JPY 149.850'・JPY ペアは行なし・空なら '—'・参考 '—'",
      () => {
        const base = closedTrade({
          pair: 'EUR/USD', entryPrice: 1.085, exitPrice: 1.0875, slPrice: null, tpPrice: null, riskReward: null,
          quoteToJpyRate: 149.85, pips: 25, profitJpy: 3746,
        });
        const noRate = closedTrade({
          pair: 'EUR/USD', entryPrice: 1.085, exitPrice: 1.0875, slPrice: null, tpPrice: null, riskReward: null,
          quoteToJpyRate: null, pips: 25, profitJpy: -100, profitSource: 'manual',
        });
        return verdict([
          ['レート', valueOf(buildDetailView(base, NOW), 'quoteToJpyRate') === 'USD/JPY 149.850', valueOf(buildDetailView(base, NOW), 'quoteToJpyRate')],
          ['JPY ペアは行なし', rowOf(buildDetailView(closedTrade(), NOW), 'quoteToJpyRate') === undefined, ''],
          ['レート空は —', valueOf(buildDetailView(noRate, NOW), 'quoteToJpyRate') === EMPTY, valueOf(buildDetailView(noRate, NOW), 'quoteToJpyRate')],
          ['レートなしの参考は —', valueOf(buildDetailView(noRate, NOW), 'referenceProfit') === EMPTY, valueOf(buildDetailView(noRate, NOW), 'referenceProfit')],
          ['価格は5桁', valueOf(buildDetailView(base, NOW), 'entryPrice') === '1.08500', valueOf(buildDetailView(base, NOW), 'entryPrice')],
        ]);
      }),

    t('DV-08', '保有中：見出しは「151.234 で保有中・2時間15分」（保有時間は今まで）。「決済」グループは出さず、取り消しもなし', '21:30 エントリー、今 23:45',
      "closed=false・'151.234 で保有中・2時間15分'・グループ entry,memo・canCancelClose=false・損益なし",
      () => {
        const v = buildDetailView(openTrade(), new Date('2026-10-15T23:45:00+09:00'));
        return verdict([
          ['保有中', v.closed === false && v.head.status === 'open', v.head.status],
          ['見出し', v.head.openLine === '151.234 で保有中・2時間15分', v.head.openLine],
          ['損益・pips なし', v.head.profit === null && v.head.pips === null, ''],
          ['グループ', sectionKeys(v) === 'entry,memo', sectionKeys(v)],
          ['取り消し不可', v.canCancelClose === false, v.canCancelClose],
        ]);
      }),

    t('DV-09', '決済取り消し後の保有中：決済理由・決済時の感情が残っていても詳細には出さない（消えてはいない）', 'status=open・exitReason=tp・exitEmotion=焦り',
      '「決済」グループなし・行 exitReason なし',
      () => {
        const v = buildDetailView(openTrade({ exitReason: 'tp', exitEmotion: '焦り' }), NOW);
        return verdict([
          ['グループ', sectionKeys(v) === 'entry,memo', sectionKeys(v)],
          ['決済理由の行なし', rowOf(v, 'exitReason') === undefined, ''],
        ]);
      }),

    t('DV-10', '任意項目がすべて空：行は消さずに「—」。メモは「メモなし」', 'SL・TP・RR・セッション・時間足・根拠・感情・タグ・メモ が空',
      "すべて '—'・メモ 'メモなし'（empty=true）・RR の 2 行目なし",
      () => {
        const v = buildDetailView(bareOpenTrade(), NOW);
        const keys = ['slPrice', 'tpPrice', 'riskReward', 'session', 'timeframe', 'entryReasons', 'emotion', 'tags'];
        const memo = rowOf(v, 'memo');
        return verdict([
          ...keys.map((k) => [`${k}=—`, valueOf(v, k) === EMPTY && rowOf(v, k).empty === true, valueOf(v, k)]),
          ['メモなし', memo.value === 'メモなし' && memo.empty === true, memo.value],
          ['RR の 2 行目なし', rowOf(v, 'riskReward').sub === null, rowOf(v, 'riskReward').sub],
          ['必須の項目は出る', valueOf(v, 'entryPrice') === '151.234' && valueOf(v, 'lots') === '0.5lot', valueOf(v, 'lots')],
        ]);
      }),

    t('DV-11', '決済済みで決済理由・決済時の感情・損益の算出が空：「—」', 'exitReason・exitEmotion・profitSource が null',
      "すべて '—'",
      () => {
        const v = buildDetailView(closedTrade({ exitReason: null, exitEmotion: null, profitSource: null }), NOW);
        return verdict(['exitReason', 'exitEmotion', 'profitSource'].map((k) => [`${k}=—`, valueOf(v, k) === EMPTY, valueOf(v, k)]));
      }),

    t('DV-12', '任意項目がすべてある：根拠・タグは「、」区切りで複数', '根拠2つ・タグ2つ',
      "'トレンドフォロー、ブレイクアウト'・'指標前、ルール違反'",
      () => {
        const v = buildDetailView(closedTrade({ entryReasons: ['トレンドフォロー', 'ブレイクアウト'] }), NOW);
        return verdict([
          ['根拠', valueOf(v, 'entryReasons') === 'トレンドフォロー、ブレイクアウト', valueOf(v, 'entryReasons')],
          ['タグ', valueOf(v, 'tags') === '指標前、ルール違反', valueOf(v, 'tags')],
        ]);
      }),

    t('DV-13', 'リスクリワード：2 行目に「損切り 20.0 pips・利確 40.0 pips」（買い）', 'USD/JPY 買い 151.234／SL 151.034／TP 151.634',
      "値 '2.00'・'損切り 20.0 pips・利確 40.0 pips'",
      () => {
        const r = rowOf(buildDetailView(closedTrade(), NOW), 'riskReward');
        return verdict([
          ['値', r.value === '2.00', r.value],
          ['2 行目', r.sub === '損切り 20.0 pips・利確 40.0 pips', r.sub],
        ]);
      }),

    t('DV-14', 'リスクリワード：売りでも幅は距離（正の数）で出す。非JPY は 0.1 pips まで', 'EUR/USD 売り 1.08500／SL 1.08700／TP 1.08000',
      "'損切り 20.0 pips・利確 50.0 pips'・値 '2.50'",
      () => {
        const r = rowOf(buildDetailView(closedTrade({
          pair: 'EUR/USD', side: 'sell', entryPrice: 1.085, slPrice: 1.087, tpPrice: 1.08, riskReward: 2.5,
          exitPrice: 1.083, quoteToJpyRate: 150,
        }), NOW), 'riskReward');
        return verdict([
          ['値', r.value === '2.50', r.value],
          ['2 行目', r.sub === '損切り 20.0 pips・利確 50.0 pips', r.sub],
        ]);
      }),

    t('DV-15', 'リスクリワード：SL/TP が売買方向と逆（W-01）なら「—」＋理由。どちらかが空なら「—」だけ', '買いで SL がエントリーより上／TP が空',
      "値 '—'・'SL/TPが売買方向と逆のため計算していません'／値 '—'・2 行目なし",
      () => {
        const wrong = rowOf(buildDetailView(closedTrade({ slPrice: 151.5, riskReward: null }), NOW), 'riskReward');
        const noTp = rowOf(buildDetailView(closedTrade({ tpPrice: null, riskReward: null }), NOW), 'riskReward');
        // 保存済みの値が古く残っていても、方向が逆なら出さない
        const stale = rowOf(buildDetailView(closedTrade({ slPrice: 151.5, riskReward: 2 }), NOW), 'riskReward');
        return verdict([
          ['逆の値', wrong.value === EMPTY, wrong.value],
          ['逆の理由', wrong.sub === 'SL/TPが売買方向と逆のため計算していません', wrong.sub],
          ['古い値は出さない', stale.value === EMPTY, stale.value],
          ['TP 空の値', noTp.value === EMPTY, noTp.value],
          ['TP 空の 2 行目なし', noTp.sub === null, noTp.sub],
        ]);
      }),

    t('DV-16', '数量：lots × 記録時の lotUnitSize（誤差なし）。0.07lot × 1万通貨 = 700 通貨', '0.5×10000・0.07×10000・12.5×100000・0.5×null',
      "5000・700・1250000・null／'700通貨（1lot＝10,000）'・'—'",
      () => verdict([
        ['0.5×10000', calcQuantity(0.5, 10000) === 5000, calcQuantity(0.5, 10000)],
        ['0.07×10000（700.0000000000001 にならない）', calcQuantity(0.07, 10000) === 700, calcQuantity(0.07, 10000)],
        ['12.5×100000', calcQuantity(12.5, 100000) === 1250000, calcQuantity(12.5, 100000)],
        ['空は null', calcQuantity(0.5, null) === null && calcQuantity(null, 10000) === null, ''],
        ['表示', quantityText({ lots: 0.07, lotUnitSize: 10000 }) === '700通貨（1lot＝10,000）', quantityText({ lots: 0.07, lotUnitSize: 10000 })],
        ['空の表示', quantityText({ lots: 0.5, lotUnitSize: null }) === EMPTY, quantityText({ lots: 0.5, lotUnitSize: null })],
      ])),

    t('DV-17', '数量は記録時の lotUnitSize を使う（本番の 10万通貨の記録）', '1lot=100,000 で 2lot',
      "'200,000通貨（1lot＝100,000）'",
      () => {
        const v = buildDetailView(closedTrade({ lots: 2, lotUnitSize: 100000 }), NOW);
        return verdict([['数量', valueOf(v, 'quantity') === '200,000通貨（1lot＝100,000）', valueOf(v, 'quantity')]]);
      }),

    t('DV-18', '保有時間：決済済みは エントリー〜決済、日をまたぐと「日・時間」、分だけなら「25分」', '1時間35分／25分／3日4時間／ちょうど2時間',
      "'1時間35分'・'25分'・'3日4時間'・'2時間'",
      () => {
        const hold = (exitAt) => valueOf(buildDetailView(closedTrade({ exitAt }), NOW), 'holding');
        return verdict([
          ['1時間35分', hold('2026-10-15T23:05:00+09:00') === '1時間35分', hold('2026-10-15T23:05:00+09:00')],
          ['25分', hold('2026-10-15T21:55:00+09:00') === '25分', hold('2026-10-15T21:55:00+09:00')],
          ['3日4時間', hold('2026-10-19T01:30:00+09:00') === '3日4時間', hold('2026-10-19T01:30:00+09:00')],
          ['2時間', hold('2026-10-15T23:30:00+09:00') === '2時間', hold('2026-10-15T23:30:00+09:00')],
        ]);
      }),

    t('DV-19', '保有時間：決済日時がエントリーより前（壊れた記録）なら「—」。保有中は今までの時間', '決済がエントリーの 10分前／保有中で今=22:00',
      "'—'／'30分'",
      () => {
        const broken = buildDetailView(closedTrade({ exitAt: '2026-10-15T21:20:00+09:00' }), NOW);
        const open = buildDetailView(openTrade(), new Date('2026-10-15T22:00:00+09:00'));
        return verdict([
          ['壊れた記録', valueOf(broken, 'holding') === EMPTY, valueOf(broken, 'holding')],
          ['保有中', open.head.openLine === '151.234 で保有中・30分', open.head.openLine],
        ]);
      }),

    t('DV-20', '保有中でエントリー日時が未来（端末の時計が戻った）なら、保有時間を付けずに「151.234 で保有中」', '今がエントリーより前',
      "'151.234 で保有中'",
      () => {
        const v = buildDetailView(openTrade(), new Date('2026-10-15T20:00:00+09:00'));
        return verdict([['見出し', v.head.openLine === '151.234 で保有中', v.head.openLine]]);
      }),

    t('DV-21', '決済価格か決済日時が欠けた記録は、status が closed でも保有中として表示（一覧と同じ判定）', 'status=closed・exitAt=null',
      "closed=false・「決済」グループなし",
      () => {
        const v = buildDetailView(closedTrade({ exitAt: null }), NOW);
        const v2 = buildDetailView(closedTrade({ exitPrice: null }), NOW);
        return verdict([
          ['決済日時なし', v.closed === false && sectionKeys(v) === 'entry,memo', sectionKeys(v)],
          ['決済価格なし', v2.closed === false && sectionKeys(v2) === 'entry,memo', sectionKeys(v2)],
        ]);
      }),

    t('DV-22', 'メモ：全文をそのまま（改行・HTML に見える文字・長文）。空白だけなら「メモなし」', '改行つき／<b>x</b>／3,000文字／空白だけ',
      '入力と同じ文字・empty=false／空白だけは empty=true',
      () => {
        const long = 'あ'.repeat(3000);
        const memoOf = (memo) => rowOf(buildDetailView(closedTrade({ memo }), NOW), 'memo');
        return verdict([
          ['改行', memoOf('1行目\n2行目').value === '1行目\n2行目', memoOf('1行目\n2行目').value],
          ['HTML に見える文字', memoOf('<b>x</b>&amp;').value === '<b>x</b>&amp;', memoOf('<b>x</b>&amp;').value],
          ['長文は省略しない', memoOf(long).value.length === 3000 && memoOf(long).empty === false, memoOf(long).value.length],
          ['空白だけ', memoOf('  \n ').empty === true && memoOf('  \n ').value === 'メモなし', memoOf('  \n ').value],
          ['null', memoOf(null).empty === true, ''],
        ]);
      }),

    t('DV-23', '作成・更新日時の行：今年は「10/15(木) 21:31」、今年以外は年つき', '作成 2026-10-15 21:31・更新 2025-12-30 09:00',
      "'作成 10/15(木) 21:31・更新 2025/12/30(火) 09:00'",
      () => {
        const v = buildDetailView(closedTrade({ updatedAt: '2025-12-30T09:00:00+09:00' }), NOW);
        return verdict([['行', v.timestamps === '作成 10/15(木) 21:31・更新 2025/12/30(火) 09:00', v.timestamps]]);
      }),

    t('DV-24', '今年以外のエントリー・決済日時には年が付く', '2025-12-30 09:00',
      "'2025/12/30(火) 09:00'",
      () => {
        const v = buildDetailView(closedTrade({ entryAt: '2025-12-30T09:00:00+09:00', exitAt: '2025-12-30T10:00:00+09:00' }), NOW);
        return verdict([['エントリー', valueOf(v, 'entryAt') === '2025/12/30(火) 09:00', valueOf(v, 'entryAt')]]);
      }),

    t('DV-25', '表にない保存値（将来の選択肢・壊れた値）は消さずにそのまま見せる', "session='asia'・timeframe='H2'・exitReason='x'",
      "'asia'・'H2'・'x'",
      () => {
        const v = buildDetailView(closedTrade({ session: 'asia', timeframe: 'H2', exitReason: 'x' }), NOW);
        return verdict([
          ['session', valueOf(v, 'session') === 'asia', valueOf(v, 'session')],
          ['timeframe', valueOf(v, 'timeframe') === 'H2', valueOf(v, 'timeframe')],
          ['exitReason', valueOf(v, 'exitReason') === 'x', valueOf(v, 'exitReason')],
        ]);
      }),

    t('DV-26', '全選択肢の日本語名（セッション・時間足・決済理由）', '4種・8種・5種',
      '東京/ロンドン/ニューヨーク/その他・1分〜週足・TP到達/SL到達/裁量決済/建値決済/その他',
      () => {
        const get = (extra, key) => valueOf(buildDetailView(closedTrade(extra), NOW), key);
        return verdict([
          ['セッション', ['tokyo', 'london', 'newyork', 'other'].map((s) => get({ session: s }, 'session')).join('/') === '東京/ロンドン/ニューヨーク/その他', ''],
          ['時間足', ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'].map((s) => get({ timeframe: s }, 'timeframe')).join('/') === '1分/5分/15分/30分/1時間/4時間/日足/週足', ''],
          ['決済理由', ['tp', 'sl', 'manual', 'breakeven', 'other'].map((s) => get({ exitReason: s }, 'exitReason')).join('/') === 'TP到達/SL到達/裁量決済/建値決済/その他', ''],
        ]);
      }),

    t('DV-27', '読み上げ用の見出し：記号（▲・＋）を使わず言葉で', '決済済み／保有中',
      "'本番、USD/JPY、買い、決済済み、プラス1,265円、プラス25.3 pips'／'…保有中、エントリー価格 151.234、保有時間 2時間15分'",
      () => {
        const closed = buildDetailView(closedTrade(), NOW);
        const open = buildDetailView(openTrade({ accountType: 'demo', side: 'sell' }), new Date('2026-10-15T23:45:00+09:00'));
        return verdict([
          ['決済済み', closed.head.speech === '本番、USD/JPY、買い、決済済み、プラス1,265円、プラス25.3 pips', closed.head.speech],
          ['保有中', open.head.speech === 'デモ、USD/JPY、売り、保有中、エントリー価格 151.234、保有時間 2時間15分', open.head.speech],
        ]);
      }),

    t('DV-28', '確認シートの要約：決済済みは決済日時、保有中はエントリー日時。「本番 USD/JPY ▲買い 10/15 23:05 の記録」', '決済済み／保有中の売り／今年以外',
      "'本番 USD/JPY ▲買い 10/15 23:05 の記録'・'デモ USD/JPY ▼売り 10/15 21:30 の記録'・'… 2025/12/30 09:00 の記録'",
      () => verdict([
        ['決済済み', describeTrade(closedTrade(), NOW) === '本番 USD/JPY ▲買い 10/15 23:05 の記録', describeTrade(closedTrade(), NOW)],
        ['保有中', describeTrade(openTrade({ accountType: 'demo', side: 'sell' }), NOW) === 'デモ USD/JPY ▼売り 10/15 21:30 の記録', describeTrade(openTrade({ accountType: 'demo', side: 'sell' }), NOW)],
        ['今年以外', describeTrade(openTrade({ entryAt: '2025-12-30T09:00:00+09:00' }), NOW) === '本番 USD/JPY ▲買い 2025/12/30 09:00 の記録', describeTrade(openTrade({ entryAt: '2025-12-30T09:00:00+09:00' }), NOW)],
      ])),

    t('DV-29', '壊れたデータ（通貨ペア・価格・ロット・日時が空や文字）でも例外にならず、「—」で表示する', 'pair=null／entryPrice="x"／lots="abc"／entryAt="x"',
      '例外なし・価格・数量・日時が「—」',
      () => {
        const broken = closedTrade({
          pair: null, side: 'hold', accountType: 'x', entryPrice: 'x', lots: 'abc', lotUnitSize: undefined,
          entryAt: 'x', exitPrice: 'y', slPrice: 'z', profitJpy: 'q', pips: NaN, entryReasons: 'まとめて', tags: null,
        });
        const v = buildDetailView(broken, NOW);
        const desc = describeTrade(broken, NOW);
        return verdict([
          ['見出し', v.head.pair === EMPTY && v.head.side === null && v.head.account === null, `${v.head.pair}/${v.head.side}/${v.head.account}`],
          ['価格', valueOf(v, 'entryPrice') === EMPTY && valueOf(v, 'exitPrice') === EMPTY, valueOf(v, 'entryPrice')],
          ['数量', valueOf(v, 'quantity') === EMPTY, valueOf(v, 'quantity')],
          ['日時', valueOf(v, 'entryAt') === EMPTY, valueOf(v, 'entryAt')],
          ['根拠・タグ', valueOf(v, 'entryReasons') === EMPTY && valueOf(v, 'tags') === EMPTY, valueOf(v, 'tags')],
          ['要約', typeof desc === 'string' && desc.endsWith('の記録'), desc],
        ]);
      }),

    t('DV-30', '日時の保存値が壊れている（保有中・決済済みとも）ときも保有時間は「—」で止まらない', 'entryAt=null の保有中',
      "見出し '151.234 で保有中'",
      () => {
        const v = buildDetailView(openTrade({ entryAt: null }), NOW);
        return verdict([
          ['見出し', v.head.openLine === '151.234 で保有中', v.head.openLine],
          ['日時の行', valueOf(v, 'entryAt') === EMPTY, valueOf(v, 'entryAt')],
        ]);
      }),
  ];
}
