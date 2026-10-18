/* =========================================================
   tests/filter.test.js
   一覧の並び順・日付グループ・件数/合計損益（js/filter.js）のテスト（T-19。analytics.md 4.6・4.7・4.11）。
   ・analytics 4.11 のサンプルデータ（T01〜T12）で、条件なしの L-01 と同じ結果になること
     （表示順・日付の見出し・本番とデモ別の件数/合計損益/合計 pips・削除済みの除外）
   ・日計は「その日の全件」で計算すること、サマリーが1口座のときだけ日計を出すこと（design 14.3.5）
   ・「最初の約50件→続き」の切り出し（flattenView / nextChunkEnd）で行が欠けたり重なったりしないこと
   ・status は決済価格と決済日時の両方があるときだけ「決済済み」として扱うこと
   【T-23】絞り込み条件つきの L-01〜L-27（4.11.3）、期間の境目 D-01〜D-09、表記ゆれ N-01〜N-02 を足した（期待値は tests/cases.js）。
   あわせて条件の扱い（チップの文言・1項目の解除・個数・30分の復元・壊れた保存値の補い・通貨ペアの選択肢）の LF テストも足した。
   IndexedDB・localStorage を使わないので、Node.js でもブラウザでも実行する。

   ID：LV-xx（一覧の集計）、L-xx（絞り込み）、D-xx（期間）、N-xx（表記ゆれ）、LF-xx（条件の扱い）
   ========================================================= */
import {
  isClosedTrade, summarize, summaryRows, canShowDailyTotals, buildListView as buildView, flattenView, nextChunkEnd,
  DEFAULT_FILTER, defaultFilter, cloneFilter, periodRange, normalizeForSearch, toTokens, countMatches, countActiveConditions,
  isFilterKeyActive, clearCondition, fixConflicts, describeFilter, describePeriodRange, formatYmdLabel, pairOptions,
  normalizeFilter, packFilter, restoreFilter, FILTER_KEYS, SUMMARY_PENDING_TEXT, showSummaryPipsNote,
} from '../js/filter.js';
import { judgeResult } from '../js/calc.js';
import { toJstString } from '../js/datetime.js';
import { LIST_CASES, PERIOD_CASES, PERIOD_HEADING_CASE, NORMALIZE_CASES } from './cases.js';
import { show } from './helpers.js';

const CATEGORY = '一覧';

/** T-19 の LV テストは「条件なし」の一覧を確かめるので、初期値の条件で呼ぶ短い形（絞り込みつきのテストは buildView を直接使う） */
const buildListView = (trades, nowMs) => buildView(trades, DEFAULT_FILTER, nowMs);

/** analytics 4.11.1：「今」＝ 2026-10-15（木）12:00（日本時間） */
const NOW = Date.parse('2026-10-15T12:00:00+09:00');

/** 確認項目 [説明, 合否, 実際の値] の一覧から合否を作る（datetime.test.js と同じ形） */
function verdict(checks) {
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) return { actual: `確認${checks.length}項目すべて一致`, pass: true };
  return { actual: failed.map(([label, , detail]) => `×${label}（実際：${show(detail)}）`).join('／'), pass: false };
}

const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run });

/** 日時（'2026-10-15 09:10'）→ 保存形式 */
const at = (s) => (s ? `${s.replace(' ', 'T')}:00+09:00` : null);

/** 記録を1件作る（一覧の集計に関係しない項目は仮の値） */
function trade(id, accountType, pair, side, entry, exit, pips, profitJpy, extra = {}) {
  return {
    id, accountType, pair, side,
    status: exit ? 'closed' : 'open',
    entryAt: at(entry), exitAt: at(exit),
    entryPrice: 150, exitPrice: exit ? 150.25 : null, lots: 1,
    pips, profitJpy, profitSource: 'auto', deletedAt: null,
    memo: '', entryReasons: [], tags: [], // キーワード検索の対象（サンプルは下の SAMPLE で指定）
    ...extra,
  };
}

/** analytics 4.11.2 のサンプルデータ（12件）。T11 は論理削除 */
export const SAMPLE = [
  trade('T01', 'real', 'USD/JPY', 'buy', '2026-10-15 09:10', '2026-10-15 10:30', 25.0, 2500, { entryReasons: ['押し目買い・戻り売り'], memo: '東京時間の押し目。ルール通り' }),
  trade('T02', 'real', 'EUR/USD', 'buy', '2026-10-14 21:00', '2026-10-14 23:40', 25.0, 3750, { entryReasons: ['経済指標・ニュース'], tags: ['指標前'], memo: '指標発表後の流れに乗った' }),
  trade('T03', 'demo', 'USD/JPY', 'buy', '2026-10-15 10:45', '2026-10-15 11:20', -37.7, -1885, { entryReasons: ['ブレイクアウト'], tags: ['ルール違反'], memo: '焦って飛び乗った' }),
  trade('T04', 'real', 'GBP/JPY', 'sell', '2026-10-13 16:00', '2026-10-13 17:30', -25.0, -50000, { entryReasons: ['レンジ逆張り'], memo: 'ﾎﾟﾝﾄﾞ急騰で損切り' }),
  trade('T05', 'demo', 'EUR/JPY', 'buy', '2026-10-12 08:00', '2026-10-12 09:00', 0.0, 0, { entryReasons: ['トレンドフォロー'], tags: ['建値'] }),
  trade('T06', 'real', 'USD/JPY', 'buy', '2026-10-09 22:00', '2026-10-09 22:30', 0.5, -30, { profitSource: 'manual', tags: ['指標前'], memo: 'ＵＳＤ ＣＰＩ前に建値で逃げた' }),
  trade('T07', 'real', 'GBP/USD', 'buy', '2026-09-30 22:00', '2026-09-30 23:50', -37.7, -5700, { profitSource: 'manual', entryReasons: ['ブレイクアウト'], tags: ['ルール違反'], memo: 'ロンドン後半' }),
  trade('T08', 'real', 'USD/JPY', 'sell', '2026-09-30 21:00', '2026-10-01 00:05', 25.0, 2500, { entryReasons: ['トレンドフォロー'], memo: '月またぎ' }),
  trade('T09', 'real', 'USD/JPY', 'buy', '2026-10-15 11:30', null, null, null, { entryReasons: ['押し目買い・戻り売り'], memo: 'サポートで反発を確認' }),
  trade('T10', 'demo', 'AUD/JPY', 'buy', '2026-09-28 10:00', null, null, null),
  trade('T11', 'real', 'USD/JPY', 'buy', '2026-10-15 08:00', '2026-10-15 08:30', 25.0, 2500, { deletedAt: at('2026-10-15 08:40'), tags: ['ルール違反'], memo: '誤登録' }),
  trade('T12', 'demo', 'EUR/GBP', 'sell', '2026-10-14 17:00', '2026-10-14 18:10', 18.0, 3428, { entryReasons: ['レンジ逆張り'] }),
];

const ids = (items) => items.map((p) => p.trade.id);
const byAccount = (accountType) => SAMPLE.filter((x) => x.accountType === accountType);

/** 同じ決済日時の記録を n 件（並び順・続き読み込みのテスト用） */
function manyTrades(days, perDay) {
  const list = [];
  for (let d = 0; d < days; d += 1) {
    for (let i = 0; i < perDay; i += 1) {
      const day = String(20 - d).padStart(2, '0');
      const hh = String(8 + i % 12).padStart(2, '0');
      list.push(trade(`M${String(d).padStart(2, '0')}-${String(i).padStart(2, '0')}`, 'real', 'USD/JPY', 'buy',
        `2026-09-${day} ${hh}:00`, `2026-09-${day} ${hh}:30`, 1.0, 100));
    }
  }
  return list;
}

export function collectFilterTests() {
  return [
    t('LV-01', '条件なし：表示順（保有中が上・決済済みは決済日時の新しい順）。削除済みは出ない', 'analytics 4.11 L-01 のサンプル12件',
      '保有中 T09 T10 ／ 決済済み T03 T01 T02 T12 T04 T05 T06 T08 T07（T11 は除外）・11件',
      () => {
        const v = buildListView(SAMPLE, NOW);
        const closed = v.groups.flatMap((g) => g.items);
        return verdict([
          ['保有中の順', ids(v.open).join(' ') === 'T09 T10', ids(v.open).join(' ')],
          ['決済済みの順', ids(closed).join(' ') === 'T03 T01 T02 T12 T04 T05 T06 T08 T07', ids(closed).join(' ')],
          ['件数', v.total === 11, v.total],
        ]);
      }),

    t('LV-02', '条件なし：決済日ごとの見出し（日本時間。今年は年を付けない）', 'L-01 の日付見出し',
      '10月15日（木）T03 T01 ／ 10月14日（水）T02 T12 ／ 10月13日（火）T04 ／ 10月12日（月）T05 ／ 10月9日（金）T06 ／ 10月1日（木）T08 ／ 9月30日（水）T07',
      () => {
        const v = buildListView(SAMPLE, NOW);
        const got = v.groups.map((g) => `${g.label} ${ids(g.items).join(' ')}`);
        const want = ['10月15日（木） T03 T01', '10月14日（水） T02 T12', '10月13日（火） T04', '10月12日（月） T05',
          '10月9日（金） T06', '10月1日（木） T08', '9月30日（水） T07'];
        return verdict([['見出しと行', got.join('／') === want.join('／'), got.join('／')]]);
      }),

    t('LV-03', '月またぎの記録は決済日で見出しに入る（T08：9/30 21:00 エントリー → 10/1 00:05 決済）', 'T08',
      '10月1日（木）の下（9月30日ではない）',
      () => {
        const v = buildListView(SAMPLE, NOW);
        const g = v.groups.find((x) => ids(x.items).includes('T08'));
        return verdict([['見出し', g && g.label === '10月1日（木）', g && g.label]]);
      }),

    t('LV-04', '今年以外の決済日は年付きの見出し（D-09）', '決済 2025-12-30 09:00・今 2026-10-15',
      '2025年12月30日（火）',
      () => {
        const v = buildListView([trade('X1', 'real', 'USD/JPY', 'buy', '2025-12-30 08:00', '2025-12-30 09:00', 1, 100)], NOW);
        return verdict([['見出し', v.groups[0].label === '2025年12月30日（火）', v.groups[0].label]]);
      }),

    t('LV-05', 'サマリー：本番（件数・保有中・合計損益・合計 pips）', 'L-01 の本番',
      '7件（保有中1）・−46,980円・＋12.8 pips（128）',
      () => {
        const [real] = summaryRows(buildListView(SAMPLE, NOW).summary);
        return verdict([
          ['口座', real.account === 'real', real.account],
          ['件数', real.count === 7 && real.openCount === 1, `${real.count}/${real.openCount}`],
          ['合計損益', real.profitJpy === -46980, real.profitJpy],
          ['合計 pips（0.1単位）', real.pipsTenths === 128, real.pipsTenths],
        ]);
      }),

    t('LV-06', 'サマリー：デモ（本番が上・デモが下の2行）', 'L-01 のデモ',
      '4件（保有中1）・＋1,543円・−19.7 pips（−197）',
      () => {
        const rows = summaryRows(buildListView(SAMPLE, NOW).summary);
        const demo = rows[1];
        return verdict([
          ['行数と順', rows.length === 2 && rows[0].account === 'real' && demo.account === 'demo', rows.map((r) => r.account).join(',')],
          ['件数', demo.count === 4 && demo.openCount === 1, `${demo.count}/${demo.openCount}`],
          ['合計損益', demo.profitJpy === 1543, demo.profitJpy],
          ['合計 pips（0.1単位）', demo.pipsTenths === -197, demo.pipsTenths],
        ]);
      }),

    t('LV-07', 'サマリー：全体の件数は11件。本番とデモを混ぜた合計損益は作らない', 'L-01',
      'total = 11。summaryRows に合計の行がない（2行だけ）',
      () => {
        const v = buildListView(SAMPLE, NOW);
        const rows = summaryRows(v.summary);
        return verdict([
          ['全体の件数', v.summary.total === 11, v.summary.total],
          ['行は口座別の2行だけ', rows.length === 2, rows.length],
          ['混ぜた合計の項目がない', v.summary.profitJpy === undefined && v.summary.pipsTenths === undefined, show(v.summary.profitJpy)],
        ]);
      }),

    t('LV-08', 'サマリー：決済済みが1件もない口座は損益・pips が null（「—」。±0円ではない）', 'L-04：保有中 T09・T10 だけ',
      '本番1件（保有中1）・デモ1件（保有中1）。損益 null・pips null',
      () => {
        const open = SAMPLE.filter((x) => x.id === 'T09' || x.id === 'T10');
        const rows = summaryRows(buildListView(open, NOW).summary);
        return verdict([
          ['行数', rows.length === 2, rows.length],
          ['本番', rows[0].count === 1 && rows[0].profitJpy === null && rows[0].pipsTenths === null, show(rows[0].profitJpy)],
          ['デモ', rows[1].count === 1 && rows[1].profitJpy === null && rows[1].pipsTenths === null, show(rows[1].profitJpy)],
        ]);
      }),

    t('LV-09', 'サマリー：決済済みがあり合計がちょうど0なら 0（null ではない＝「±0円」）', 'L-14：デモ T05 だけ（損益0・0.0 pips）',
      '損益 0・pips 0',
      () => {
        const [r] = summaryRows(buildListView(SAMPLE.filter((x) => x.id === 'T05'), NOW).summary);
        return verdict([['損益', r.profitJpy === 0, show(r.profitJpy)], ['pips', r.pipsTenths === 0, show(r.pipsTenths)]]);
      }),

    t('LV-10', 'サマリー：pips は 0.1 単位の整数で足す（円と pips の符号が逆でもそのまま）', 'L-11 の本番：T04（−25.0）＋T02（＋25.0）、円 −46,250',
      '円 −46,250・pips 0（＝±0.0 pips）',
      () => {
        const pair = SAMPLE.filter((x) => x.id === 'T04' || x.id === 'T02');
        const [r] = summaryRows(buildListView(pair, NOW).summary);
        return verdict([['円', r.profitJpy === -46250, r.profitJpy], ['pips', r.pipsTenths === 0, r.pipsTenths]]);
      }),

    t('LV-11', 'サマリー：浮動小数点の誤差を積まない（0.1 pips を10回足して 1.0）', '0.1 pips の決済を10件',
      '合計 pips = 10（0.1単位）',
      () => {
        const list = Array.from({ length: 10 }, (_, i) => trade(`F${i}`, 'real', 'USD/JPY', 'buy', '2026-10-14 10:00', '2026-10-14 10:10', 0.1, 10));
        const [r] = summaryRows(buildListView(list, NOW).summary);
        return verdict([['合計 pips', r.pipsTenths === 10, r.pipsTenths]]);
      }),

    t('LV-12', '日計を出すのは1口座のときだけ（混在は出さない）', 'L-01（混在）／本番だけ／デモだけ／保有中だけ（本番1・デモ1）',
      '混在 false／本番だけ true／デモだけ true／混在の保有中だけ false',
      () => {
        const open = SAMPLE.filter((x) => x.id === 'T09' || x.id === 'T10');
        return verdict([
          ['混在', buildListView(SAMPLE, NOW).showDailyTotals === false, buildListView(SAMPLE, NOW).showDailyTotals],
          ['本番だけ', buildListView(byAccount('real'), NOW).showDailyTotals === true, 'real'],
          ['デモだけ', buildListView(byAccount('demo'), NOW).showDailyTotals === true, 'demo'],
          ['混在の保有中だけ', canShowDailyTotals(summarize([])) === false && buildListView(open, NOW).showDailyTotals === false, 'open'],
        ]);
      }),

    t('LV-13', '日計：その日に決済した全件の損益（円）を整数で足す', '本番だけの一覧',
      '10/15 ＋2,500／10/14 ＋3,750／10/13 −50,000／10/9 −30／10/1 ＋2,500／9/30 −5,700',
      () => {
        const v = buildListView(byAccount('real'), NOW);
        const got = v.groups.map((g) => `${g.label.replace(/（.）/, '')} ${g.profitJpy}`).join('／');
        const want = '10月15日 2500／10月14日 3750／10月13日 -50000／10月9日 -30／10月1日 2500／9月30日 -5700';
        return verdict([['日計', got === want, got]]);
      }),

    t('LV-14', '日計：同じ日の合計が0なら 0（デモの 10/12：T05 の損益0）。足せる記録がなければ null', 'デモだけ／損益(円)が空の決済済み1件',
      '10/12 は 0／損益が空の日は null',
      () => {
        const demo = buildListView(byAccount('demo'), NOW).groups.find((g) => g.label.startsWith('10月12日'));
        const blank = buildListView([trade('B1', 'real', 'GBP/USD', 'buy', '2026-10-14 10:00', '2026-10-14 10:10', 1, null)], NOW);
        return verdict([['10/12', demo.profitJpy === 0, show(demo.profitJpy)], ['損益が空の日', blank.groups[0].profitJpy === null, show(blank.groups[0].profitJpy)]]);
      }),

    t('LV-15', '同じ決済日時のときの順：エントリー日時の新しい順 → id の昇順', '決済 10:30 が同じ3件',
      'B（エントリーが新しい）→ A1 → A2（エントリー・決済が同じなら id 順）',
      () => {
        const list = [
          trade('A2', 'real', 'USD/JPY', 'buy', '2026-10-14 09:00', '2026-10-14 10:30', 1, 1),
          trade('B', 'real', 'USD/JPY', 'buy', '2026-10-14 10:00', '2026-10-14 10:30', 1, 1),
          trade('A1', 'real', 'USD/JPY', 'buy', '2026-10-14 09:00', '2026-10-14 10:30', 1, 1),
        ];
        const got = ids(buildListView(list, NOW).groups[0].items).join(' ');
        return verdict([['順', got === 'B A1 A2', got]]);
      }),

    t('LV-16', '保有中の順：エントリー日時の新しい順。同じなら id の昇順', 'T09（10/15）・T10（9/28）・同時刻の2件',
      'T09 → T10。同時刻は id 順',
      () => {
        const open = [
          trade('Z2', 'real', 'USD/JPY', 'buy', '2026-10-01 10:00', null, null, null),
          trade('Z1', 'real', 'USD/JPY', 'buy', '2026-10-01 10:00', null, null, null),
          SAMPLE.find((x) => x.id === 'T10'), SAMPLE.find((x) => x.id === 'T09'),
        ];
        const got = ids(buildListView(open, NOW).open).join(' ');
        return verdict([['順', got === 'T09 Z1 Z2 T10', got]]);
      }),

    t('LV-17', '論理削除（deletedAt あり）は表示にも件数にも合計にも入らない', 'T11（10/15 決済 ＋2,500円・削除済み）',
      'どの一覧・サマリーにも T11 がない。本番の合計は −46,980円',
      () => {
        const v = buildListView(SAMPLE, NOW);
        const all = [...v.open, ...v.groups.flatMap((g) => g.items)];
        return verdict([
          ['T11 がない', !ids(all).includes('T11'), ids(all).join(' ')],
          ['本番の件数', v.summary.byAccount.real.count === 7, v.summary.byAccount.real.count],
        ]);
      }),

    t('LV-18', 'status は決済価格と決済日時の両方があるときだけ「決済済み」', 'status=closed だが決済価格なし／決済日時なし／両方あり',
      '前2つは保有中の扱い（isClosedTrade が false）。両方ありは決済済み',
      () => {
        const base = trade('S', 'real', 'USD/JPY', 'buy', '2026-10-14 10:00', '2026-10-14 10:30', 1, 100);
        const noPrice = { ...base, exitPrice: null };
        const noTime = { ...base, exitAt: null };
        const v = buildListView([noPrice, { ...noTime, id: 'S2' }, { ...base, id: 'S3' }], NOW);
        return verdict([
          ['決済価格なし', isClosedTrade(noPrice) === false, isClosedTrade(noPrice)],
          ['決済日時なし', isClosedTrade(noTime) === false, isClosedTrade(noTime)],
          ['両方あり', isClosedTrade(base) === true, isClosedTrade(base)],
          ['保有中グループに2件', v.open.length === 2 && v.groups.length === 1, `${v.open.length}/${v.groups.length}`],
          ['status=open でも決済情報がそろっていれば…保有中', isClosedTrade({ ...base, status: 'open' }) === false, 'open'],
        ]);
      }),

    t('LV-19', '0件：空のデータ・削除済みだけ', '[]／T11 だけ',
      'total 0・保有中なし・グループなし・サマリーの行なし',
      () => {
        const a = buildListView([], NOW);
        const b = buildListView(SAMPLE.filter((x) => x.id === 'T11'), NOW);
        const empty = (v) => v.total === 0 && v.open.length === 0 && v.groups.length === 0 && summaryRows(v.summary).length === 0;
        return verdict([['空', empty(a), a.total], ['削除済みだけ', empty(b), b.total]]);
      }),

    t('LV-20', '渡した記録の配列・記録そのものは書き換えない（読み込んだ記録をそのまま保持できる）', 'SAMPLE を渡す前後で、並び・内容が同じ',
      '同じ',
      () => {
        const before = JSON.stringify(SAMPLE);
        buildListView(SAMPLE, NOW);
        return verdict([['内容', JSON.stringify(SAMPLE) === before, 'changed']]);
      }),

    t('LV-21', '行の平らな並び：保有中の見出し（件数付き）→保有中の行→日付の見出し→その日の行', 'L-01',
      '見出し2種と行の並びが 保有中 2件 → T09 T10 → 10月15日 T03 T01 …（行は計11）',
      () => {
        const entries = flattenView(buildListView(SAMPLE, NOW));
        const head = entries.slice(0, 5).map((e) => (e.type === 'row' ? e.item.trade.id : e.type === 'open-header' ? `保有中${e.count}` : e.label));
        return verdict([
          ['先頭5件', head.join(' ') === '保有中2 T09 T10 10月15日（木） T03', head.join(' ')],
          ['行は11', entries.filter((e) => e.type === 'row').length === 11, entries.filter((e) => e.type === 'row').length],
          ['日付の見出しは7', entries.filter((e) => e.type === 'date-header').length === 7, entries.filter((e) => e.type === 'date-header').length],
        ]);
      }),

    t('LV-22', '続き読み込み：130行を50行ずつ切り出すと 50・50・30。行は欠けず重ならない', '本番の決済済み130件（5日分×26件）',
      '3回で全部。順番どおり・見出しだけで終わらない',
      () => {
        const entries = flattenView(buildListView(manyTrades(5, 26), NOW));
        const sizes = [];
        const seen = [];
        let start = 0;
        let lastIsHeader = false;
        while (start < entries.length) {
          const end = nextChunkEnd(entries, start, 50);
          const chunk = entries.slice(start, end);
          sizes.push(chunk.filter((e) => e.type === 'row').length);
          seen.push(...chunk.filter((e) => e.type === 'row').map((e) => e.item.trade.id));
          if (chunk[chunk.length - 1].type !== 'row') lastIsHeader = true;
          start = end;
        }
        const all = entries.filter((e) => e.type === 'row').map((e) => e.item.trade.id);
        return verdict([
          ['行数', sizes.join(',') === '50,50,30', sizes.join(',')],
          ['順番と重複なし', seen.join(' ') === all.join(' ') && new Set(seen).size === 130, seen.length],
          ['見出しだけで終わらない', !lastIsHeader, lastIsHeader],
        ]);
      }),

    t('LV-23', '続き読み込み：途中で切れた日の日計は、その日の全件の合計のまま', '130件・1日26件（50行目は2日目の途中）',
      '各日の日計 = 26 × 100 = 2,600円（切り出した行数に関係しない）',
      () => {
        const v = buildListView(manyTrades(5, 26), NOW);
        const totals = v.groups.map((g) => g.profitJpy);
        const entries = flattenView(v);
        const firstChunk = entries.slice(0, nextChunkEnd(entries, 0, 50));
        const headers = firstChunk.filter((e) => e.type === 'date-header');
        return verdict([
          ['5日分', totals.length === 5 && totals.every((x) => x === 2600), totals.join(',')],
          ['最初の50行に含まれる見出し（1日目と、途中で切れた2日目）の日計', headers.length === 2 && headers.every((e) => e.profitJpy === 2600), headers.length],
        ]);
      }),

    t('LV-24', '続き読み込み：行数がちょうど50のときは続きなし／0行なら切り出しなし', '50件／空',
      '終わりの位置 = 見出し1つ＋50行の長さ／空は 0',
      () => {
        const one = flattenView(buildListView(manyTrades(1, 12).concat(manyTrades(1, 12).map((x) => ({ ...x, id: `${x.id}b` }))), NOW));
        const exact = flattenView(buildListView(manyTrades(2, 25), NOW));
        return verdict([
          ['50行ちょうど', nextChunkEnd(exact, 0, 50) === exact.length, `${nextChunkEnd(exact, 0, 50)}/${exact.length}`],
          ['空', nextChunkEnd([], 0, 50) === 0, nextChunkEnd([], 0, 50)],
          ['1日だけ24行を50行で', nextChunkEnd(one, 0, 50) === one.length, `${nextChunkEnd(one, 0, 50)}/${one.length}`],
        ]);
      }),

    t('LV-25', '端末のタイムゾーンに左右されない（決済 10/14 23:40 JST は 10/14 の見出し）', 'T02',
      '10月14日（水）。TZ=America/New_York で実行しても同じ',
      () => {
        const v = buildListView(SAMPLE.filter((x) => x.id === 'T02'), NOW);
        return verdict([['見出し', v.groups[0].label === '10月14日（水）', v.groups[0].label]]);
      }),

    t('LV-26', 'サマリー：決済済みが0件の口座は損益・pips が null で、画面は「損益は未確定」と文字で出す（T-33 U-03）', '保有中だけの T09（本番）',
      "profitJpy・pipsTenths は null／SUMMARY_PENDING_TEXT は '損益は未確定'",
      () => {
        const rows = summaryRows(buildListView(SAMPLE.filter((x) => x.id === 'T09'), NOW).summary);
        return verdict([
          ['1行（本番）', rows.length === 1 && rows[0].account === 'real', rows.length],
          ['損益・pips は null', rows[0].profitJpy === null && rows[0].pipsTenths === null, `${rows[0].profitJpy}/${rows[0].pipsTenths}`],
          ['画面の文', SUMMARY_PENDING_TEXT === '損益は未確定', SUMMARY_PENDING_TEXT],
        ]);
      }),

    t('LV-27', 'サマリーの下の pips の注記は、絞り込み中は出さない（T-33 U-06）', 'サンプル全件／保有中だけ × 絞り込みなし／あり',
      '全件・絞り込みなし＝出す／全件・絞り込み中＝出さない／保有中だけ（pips の合計なし）＝出さない',
      () => {
        const all = summaryRows(buildListView(SAMPLE, NOW).summary);
        const openOnly = summaryRows(buildListView(SAMPLE.filter((x) => x.id === 'T09'), NOW).summary);
        return verdict([
          ['全件・絞り込みなし', showSummaryPipsNote(all, false) === true, showSummaryPipsNote(all, false)],
          ['全件・絞り込み中', showSummaryPipsNote(all, true) === false, showSummaryPipsNote(all, true)],
          ['保有中だけ', showSummaryPipsNote(openOnly, false) === false, showSummaryPipsNote(openOnly, false)],
        ]);
      }),
    ...collectListFilterTests(),
  ];
}

/* ---------------------------------------------------------
   T-23：絞り込み（analytics 4.11.3 の L・D・N と、条件の扱いの LF）
   --------------------------------------------------------- */

/** 初期値に差分を重ねた条件（cases.js の filter は差分だけを書いてある） */
function makeFilter(over = {}) {
  const f = defaultFilter();
  return { ...f, ...over, period: { ...f.period, ...(over.period || {}) } };
}

/** 'YYYY-MM-DDTHH:mm:ss+09:00' → ミリ秒 */
const ms = (text) => Date.parse(text);

/** サマリーの1行が期待どおりか（yen・pips が null＝決済済み0件の「—」。pips は小数第1位を ×10 の整数にして比べる） */
function rowDiff(actual, want) {
  if (want === null) return actual === undefined ? null : `行が出ている（${actual.count}件）`;
  if (!actual) return '行が出ていない';
  const wantTenths = want.pips === null ? null : Math.round(want.pips * 10);
  if (actual.count !== want.count || actual.openCount !== want.openCount) return `件数 ${actual.count}（保有中${actual.openCount}）`;
  if (actual.profitJpy !== want.yen) return `損益 ${show(actual.profitJpy)}`;
  if (actual.pipsTenths !== wantTenths) return `pips（×10）${show(actual.pipsTenths)}`;
  return null;
}

const rowText = (want) => (want === null ? '（行なし）'
  : `${want.count}件${want.openCount ? `（保有中${want.openCount}）` : ''} ${want.yen === null ? '—' : `${want.yen}円`} / ${want.pips === null ? '—' : `${want.pips}pips`}`);

function listCaseTest(c) {
  return t(c.id, c.title, `条件 ${JSON.stringify(c.filter)}`,
    `保有中 ${c.open || 'なし'} ／ 決済済み ${c.closed || 'なし'} ／ ${c.total}件 ／ 本番 ${rowText(c.real)} ／ デモ ${rowText(c.demo)}`,
    () => {
      const v = buildView(SAMPLE, makeFilter(c.filter), NOW);
      const open = ids(v.open).join(' ');
      const closed = ids(v.groups.flatMap((g) => g.items)).join(' ');
      const rows = summaryRows(v.summary);
      const realDiff = rowDiff(rows.find((r) => r.account === 'real'), c.real);
      const demoDiff = rowDiff(rows.find((r) => r.account === 'demo'), c.demo);
      return verdict([
        ['保有中の順', open === c.open, open],
        ['決済済みの順', closed === c.closed, closed],
        ['件数', v.total === c.total, v.total],
        ['本番の行', realDiff === null, realDiff],
        ['デモの行', demoDiff === null, demoDiff],
      ]);
    });
}

function periodCaseTest(c) {
  return t(c.id, `期間の範囲：${c.title}`, `今 ${c.now}・${c.preset}`, `${c.from} 〜 ${c.to}（終了は含まない）`, () => {
    const r = periodRange({ preset: c.preset, from: null, to: null }, ms(c.now));
    return verdict([
      ['開始', r && r[0] === ms(c.from), r && toJstString(new Date(r[0]))],
      ['終了', r && r[1] === ms(c.to), r && toJstString(new Date(r[1]))],
    ]);
  });
}

/** 条件つきの記録を1件作る（LF テスト用） */
function tagged(id, extra = {}) {
  return trade(id, 'real', 'USD/JPY', 'buy', '2026-10-14 10:00', '2026-10-14 10:30', 1, 100, extra);
}

function collectListFilterTests() {
  const tests = [
    ...LIST_CASES.map(listCaseTest),
    ...PERIOD_CASES.map(periodCaseTest),
    t(PERIOD_HEADING_CASE.id, '今年以外の決済日の見出し（年を付ける）', `今 ${PERIOD_HEADING_CASE.now}・決済 ${PERIOD_HEADING_CASE.exitAt}`, PERIOD_HEADING_CASE.heading, () => {
      const rec = trade('Y', 'real', 'USD/JPY', 'buy', '2025-12-30 08:00', '2025-12-30 09:00', 1, 100);
      const v = buildView([rec], DEFAULT_FILTER, ms(PERIOD_HEADING_CASE.now));
      return verdict([['見出し', v.groups[0].label === PERIOD_HEADING_CASE.heading, v.groups[0].label]]);
    }),
    ...NORMALIZE_CASES.map((c) => t(c.id, c.title, show(c.input), show(c.expected), () => {
      const got = Array.isArray(c.expected) ? toTokens(c.input) : normalizeForSearch(c.input);
      const same = Array.isArray(c.expected) ? got.length === c.expected.length && got.every((x, i) => x === c.expected[i]) : got === c.expected;
      return verdict([['結果', same, got]]);
    })),
  ];

  tests.push(
    t('LF-01', '条件チップの文言（本番・今月・負け）。シートの項目順に並ぶ', '本番＋今月＋負け（今 10/15）',
      '本番／今月（10/1〜10/31）／負け の3つ。個数 3。読み上げ「本番の条件を解除」',
      () => {
        const f = makeFilter({ accountType: 'real', period: { preset: 'thisMonth' }, outcomes: ['loss'] });
        const chips = describeFilter(f, NOW);
        return verdict([
          ['文言と順', chips.map((c) => c.label).join('／') === '本番／今月（10/1〜10/31）／負け', chips.map((c) => c.label).join('／')],
          ['項目名', chips.map((c) => c.key).join(',') === 'accountType,period,outcomes', chips.map((c) => c.key).join(',')],
          ['読み上げ', chips[0].ariaLabel === '本番の条件を解除', chips[0].ariaLabel],
          ['個数', countActiveConditions(f) === 3, countActiveConditions(f)],
        ]);
      }),

    t('LF-02', '条件チップの文言（キーワード・通貨ペア1〜3つ以上・方向・状態・勝ち・引き分け）', '各条件',
      '“ルール違反”／USD/JPY／USD/JPY・EUR/USD／USD/JPY ほか2／▲ 買い／▼ 売り／保有中／決済済み／デモ／勝ち・引き分け',
      () => {
        const label = (over) => describeFilter(makeFilter(over), NOW).map((c) => c.label).join('／');
        const got = [
          label({ keyword: '  ルール違反 ' }), label({ pairs: ['USD/JPY'] }), label({ pairs: ['USD/JPY', 'EUR/USD'] }),
          label({ pairs: ['USD/JPY', 'EUR/USD', 'GBP/JPY'] }), label({ side: 'buy' }), label({ side: 'sell' }),
          label({ status: 'open' }), label({ status: 'closed' }), label({ accountType: 'demo' }),
          label({ outcomes: ['draw', 'win'] }),
        ];
        const want = ['“ルール違反”', 'USD/JPY', 'USD/JPY・EUR/USD', 'USD/JPY ほか2', '▲ 買い', '▼ 売り', '保有中', '決済済み', 'デモ', '勝ち・引き分け'];
        return verdict(want.map((w, i) => [w, got[i] === w, got[i]]));
      }),

    t('LF-03', '期間のチップの文言（今日・今週・今年・指定の4通り・年またぎ・同じ日）', 'analytics 4.2 の文言例',
      '今日（10/15）／今週（10/12〜10/18）／今年（1/1〜12/31）／10/13〜10/14／10/13以降／10/14まで／10/13（同じ日）／2025/12/30〜1/2',
      () => {
        const label = (period) => describeFilter(makeFilter({ period }), NOW).map((c) => c.label).join('');
        const got = [
          label({ preset: 'today' }), label({ preset: 'thisWeek' }), label({ preset: 'thisYear' }),
          label({ preset: 'custom', from: '2026-10-13', to: '2026-10-14' }),
          label({ preset: 'custom', from: '2026-10-13' }), label({ preset: 'custom', to: '2026-10-14' }),
          label({ preset: 'custom', from: '2026-10-13', to: '2026-10-13' }),
          label({ preset: 'custom', from: '2026-01-02', to: '2025-12-30' }),
        ];
        const want = ['今日（10/15）', '今週（10/12〜10/18）', '今年（1/1〜12/31）', '10/13〜10/14', '10/13以降', '10/14まで', '10/13', '2025/12/30〜1/2'];
        return verdict(want.map((w, i) => [w, got[i] === w, got[i]]));
      }),

    t('LF-04', '初期値・「指定」で日付が空・全期間は、条件に数えずチップも出さない', '初期値／period=custom で from・to なし／壊れた日付',
      '個数 0・チップなし',
      () => {
        const cases = [makeFilter(), makeFilter({ period: { preset: 'custom' } }), makeFilter({ period: { preset: 'custom', from: '2026-02-30', to: 'abc' } }),
          makeFilter({ keyword: '   ' }), makeFilter({ period: { preset: 'all' } })];
        return verdict(cases.map((f, i) => [`${i + 1}番目`, countActiveConditions(f) === 0 && describeFilter(f, NOW).length === 0, countActiveConditions(f)]));
      }),

    t('LF-05', 'チップのタップ＝その項目だけ初期値に戻す（他の条件・元の条件は変わらない）', '本番＋今月＋負け＋“x”＋2ペア',
      '各項目を外すと個数が1つ減り、外した項目だけが初期値。元の条件は書き換わらない',
      () => {
        const f = makeFilter({ keyword: 'x', accountType: 'real', period: { preset: 'thisMonth' }, outcomes: ['loss'], status: 'closed', side: 'buy', pairs: ['USD/JPY', 'EUR/USD'] });
        const before = JSON.stringify(f);
        const checks = [['元の条件は不変', true, '']];
        for (const key of FILTER_KEYS) {
          const next = clearCondition(f, key);
          const others = FILTER_KEYS.filter((k) => k !== key);
          checks.push([`${key} を外す`, !isFilterKeyActive(next, key) && others.every((k) => isFilterKeyActive(next, k)) && countActiveConditions(next) === 6, countActiveConditions(next)]);
        }
        checks[0][1] = JSON.stringify(f) === before;
        checks.push(['全部外す', countActiveConditions(FILTER_KEYS.reduce(clearCondition, f)) === 0, '']);
        return verdict(checks);
      }),

    t('LF-06', '初期値 DEFAULT_FILTER は書き換えられない／defaultFilter() と cloneFilter() は独立した写し', 'push・代入を試す',
      '初期値は変わらず、写しを書き換えても元に影響しない',
      () => {
        const d = defaultFilter();
        d.pairs.push('USD/JPY');
        d.period.preset = 'today';
        const c = cloneFilter(makeFilter({ pairs: ['EUR/USD'], outcomes: ['win'] }));
        c.pairs.push('GBP/JPY');
        let frozen = false;
        try { DEFAULT_FILTER.pairs.push('X'); } catch (e) { frozen = true; } // モジュールは厳格モードなので、凍結した配列への追加は例外になる
        return verdict([
          ['初期値の配列は凍結', frozen && DEFAULT_FILTER.pairs.length === 0, DEFAULT_FILTER.pairs.length],
          ['初期値の期間', DEFAULT_FILTER.period.preset === 'all', DEFAULT_FILTER.period.preset],
          ['新しい写しは空', defaultFilter().pairs.length === 0 && defaultFilter().period.preset === 'all', ''],
        ]);
      }),

    t('LF-07', '状態＝保有中のときは勝敗を外す（fixConflicts）。buildListView 自体は補正しない（L-26）', 'status=open＋outcomes=[loss]',
      'fixConflicts は outcomes を空に。元の条件は不変',
      () => {
        const f = makeFilter({ status: 'open', outcomes: ['loss'] });
        const fixed = fixConflicts(f);
        const keep = fixConflicts(makeFilter({ status: 'closed', outcomes: ['loss'] }));
        return verdict([
          ['勝敗が空', fixed.outcomes.length === 0 && fixed.status === 'open', fixed.outcomes.join(',')],
          ['元は不変', f.outcomes.length === 1, f.outcomes.length],
          ['決済済みなら残る', keep.outcomes.join(',') === 'loss', keep.outcomes.join(',')],
        ]);
      }),

    t('LF-08', '壊れた保存値は壊れた項目だけ初期値で補う', '型違い・知らない値・実在しない日付・長すぎるキーワード',
      '使える項目は残り、使えない項目だけ初期値',
      () => {
        const long = 'あ'.repeat(150);
        const f = normalizeFilter({
          accountType: 'both', status: 'closed', side: 5, pairs: ['USD/JPY', 'usd/jpy', 3, 'USD/JPY', 'EUR/USD'],
          outcomes: ['loss', 'x', 'win'], period: { preset: 'custom', from: '2026-02-30', to: '2026-10-14' }, keyword: `  ${long}  `,
        });
        const g = normalizeFilter('こわれた');
        const h2 = normalizeFilter({ period: { preset: 'nextYear', from: '2026-10-01' }, outcomes: 'win', pairs: null, keyword: 3 });
        return verdict([
          ['口座は初期値', f.accountType === 'all', f.accountType],
          ['状態は残る', f.status === 'closed', f.status],
          ['売買方向は初期値', f.side === 'all', f.side],
          ['ペアは正しい形・重複なしだけ', f.pairs.join(',') === 'USD/JPY,EUR/USD', f.pairs.join(',')],
          ['勝敗は知っているものだけ（決まった順）', f.outcomes.join(',') === 'win,loss', f.outcomes.join(',')],
          ['期間：実在しない日付だけ空', f.period.preset === 'custom' && f.period.from === null && f.period.to === '2026-10-14', JSON.stringify(f.period)],
          ['キーワードは100文字まで', [...f.keyword].length === 100, [...f.keyword].length],
          ['オブジェクトでなければ全部初期値', countActiveConditions(g) === 0, countActiveConditions(g)],
          ['知らない期間・型違いは初期値', h2.period.preset === 'all' && h2.outcomes.length === 0 && h2.pairs.length === 0 && h2.keyword === '', JSON.stringify(h2)],
        ]);
      }),

    t('LF-09', '保存値の復元：保存から30分以内なら復元、30分を超えたら初期値（analytics 4.8）', '10:00 に保存。10:29:59／10:30:00／10:30:01 に起動',
      '前2つは復元・最後は初期値。保存なし・版違い・壊れた保存値も初期値',
      () => {
        const f = makeFilter({ accountType: 'demo', period: { preset: 'thisMonth' } });
        const saved = packFilter(f, new Date('2026-10-15T10:00:00+09:00'));
        const at = (clock) => restoreFilter(saved, new Date(`2026-10-15T${clock}+09:00`));
        const restored = (x) => x.accountType === 'demo' && x.period.preset === 'thisMonth';
        return verdict([
          ['保存時刻の形', saved.version === 1 && saved.savedAt === '2026-10-15T10:00:00+09:00', saved.savedAt],
          ['29分59秒後', restored(at('10:29:59')), ''],
          ['ちょうど30分後', restored(at('10:30:00')), ''],
          ['30分1秒後は初期値', countActiveConditions(at('10:30:01')) === 0, ''],
          ['保存なし', countActiveConditions(restoreFilter(null)) === 0, ''],
          ['版が違う', countActiveConditions(restoreFilter({ ...saved, version: 2 }, new Date('2026-10-15T10:01:00+09:00'))) === 0, ''],
          ['保存時刻が壊れている', countActiveConditions(restoreFilter({ ...saved, savedAt: 'きのう' }, new Date('2026-10-15T10:01:00+09:00'))) === 0, ''],
          ['条件が壊れていても動く', countActiveConditions(restoreFilter({ ...saved, filter: 'x' }, new Date('2026-10-15T10:01:00+09:00'))) === 0, ''],
          ['保存した条件は写し（後から書き換えても影響なし）', (() => { f.accountType = 'real'; return saved.filter.accountType === 'demo'; })(), ''],
        ]);
      }),

    t('LF-10', '復元した「今月」は復元した日で計算し直す（選択肢の名前で保存している）', '11/2 09:00 に「今月」を保存し、09:10 に復元',
      '11月の範囲（11/1〜11/30）になる',
      () => {
        const saved = packFilter(makeFilter({ period: { preset: 'thisMonth' } }), new Date('2026-11-02T09:00:00+09:00'));
        const f = restoreFilter(saved, new Date('2026-11-02T09:10:00+09:00'));
        const label = describeFilter(f, ms('2026-11-02T09:10:00+09:00'))[0].label;
        return verdict([['チップ', label === '今月（11/1〜11/30）', label], ['保存しているのは名前だけ', saved.filter.period.from === null && saved.filter.period.preset === 'thisMonth', JSON.stringify(saved.filter.period)]]);
      }),

    t('LF-11', '件数 countMatches は buildListView の件数と同じ（削除済みは数えない）', 'L-01・L-09・L-24 の条件',
      '11／9／0',
      () => {
        const n = (over) => countMatches(SAMPLE, makeFilter(over), NOW);
        return verdict([
          ['すべて', n({}) === 11, n({})],
          ['今月', n({ period: { preset: 'thisMonth' } }) === 9, n({ period: { preset: 'thisMonth' } })],
          ['誤登録', n({ keyword: '誤登録' }) === 0, n({ keyword: '誤登録' })],
          ['buildListView と一致', LIST_CASES.every((c) => countMatches(SAMPLE, makeFilter(c.filter), NOW) === c.total), ''],
        ]);
      }),

    t('LF-12', '全件数 recordCount は条件に関係なく（削除済みを除いた）全件。0件の見分けに使う', '絞り込みで0件になる条件／記録なし／削除済みだけ',
      '11・total 0／0／0',
      () => {
        const a = buildView(SAMPLE, makeFilter({ keyword: '誤登録' }), NOW);
        const b = buildView([], DEFAULT_FILTER, NOW);
        const c = buildView(SAMPLE.filter((x) => x.id === 'T11'), DEFAULT_FILTER, NOW);
        return verdict([
          ['絞り込み0件', a.total === 0 && a.recordCount === 11, `${a.total}/${a.recordCount}`],
          ['記録なし', b.recordCount === 0, b.recordCount],
          ['削除済みだけ', c.recordCount === 0, c.recordCount],
        ]);
      }),

    t('LF-13', '日計を出すのは「絞り込み結果」が1口座のときだけ', '初期値／本番／デモ／保有中だけ（本番1・デモ1）／キーワード「建値」（本番T06・デモT05）',
      'false／true／true／false／false',
      () => {
        const show1 = (over) => buildView(SAMPLE, makeFilter(over), NOW).showDailyTotals;
        return verdict([
          ['初期値', show1({}) === false, show1({})],
          ['本番', show1({ accountType: 'real' }) === true, show1({ accountType: 'real' })],
          ['デモ', show1({ accountType: 'demo' }) === true, show1({ accountType: 'demo' })],
          ['保有中だけ', show1({ status: 'open' }) === false, show1({ status: 'open' })],
          ['結果が本番とデモ', show1({ keyword: '建値' }) === false, show1({ keyword: '建値' })],
          ['結果が本番だけになる条件（USD/JPY 売り）', show1({ pairs: ['USD/JPY'], side: 'sell' }) === true, show1({ pairs: ['USD/JPY'], side: 'sell' })],
          ['0件', show1({ keyword: '誤登録' }) === false, show1({ keyword: '誤登録' })],
        ]);
      }),

    t('LF-14', '日計は絞り込み後の、その日の全件の合計（本番・今月）', '本番＋今月',
      '10/15 ＋2,500／10/14 ＋3,750／10/13 −50,000／10/9 −30／10/1 ＋2,500（T07 9/30 は今月でない）',
      () => {
        const v = buildView(SAMPLE, makeFilter({ accountType: 'real', period: { preset: 'thisMonth' } }), NOW);
        const got = v.groups.map((g) => `${g.label.replace(/（.）/, '')} ${g.profitJpy}`).join('／');
        const want = '10月15日 2500／10月14日 3750／10月13日 -50000／10月9日 -30／10月1日 2500';
        return verdict([['日計', got === want, got]]);
      }),

    t('LF-15', '勝敗は judgeResult と同じ判定（手入力の損益も、保存されている損益の符号で決める）', '勝ち・負け・引き分けそれぞれの絞り込み結果と judgeResult の分類',
      '3種類とも、絞り込みの結果 ＝ judgeResult がその値になる記録',
      () => {
        const checks = [];
        for (const o of ['win', 'loss', 'draw']) {
          const got = ids(buildView(SAMPLE, makeFilter({ outcomes: [o] }), NOW).groups.flatMap((g) => g.items)).sort().join(' ');
          const want = SAMPLE.filter((x) => x.deletedAt == null && judgeResult(x) === o).map((x) => x.id).sort().join(' ');
          checks.push([o, got === want, got]);
        }
        return verdict(checks);
      }),

    t('LF-16', 'キーワードは メモ・根拠・タグ だけが対象。通貨ペアなどは対象外／項目の境目をまたいで一致しない／記号は普通の文字', '「usd」「建値指標」「.」「(」',
      '「usd」は通貨ペアだけでは一致しない。メモ末尾＋根拠先頭の「建値指標」は一致しない。「.」「(」は文字として探す',
      () => {
        const a = tagged('A', { memo: '建値', entryReasons: ['指標前'], tags: [], pair: 'USD/JPY' });
        const b = tagged('B', { memo: '価格は150.5で(仮)', entryReasons: [], tags: [] });
        const n = (list, keyword) => buildView(list, makeFilter({ keyword }), NOW).total;
        return verdict([
          ['通貨ペアは対象外', n([a], 'usd') === 0 && n([a], 'USD/JPY') === 0, n([a], 'usd')],
          ['境目をまたがない', n([a], '建値指標') === 0 && n([a], '建値 指標') === 1, n([a], '建値指標')],
          ['「.」は文字', n([b], '150.5') === 1 && n([b], '150x5') === 0 && n([b], '1.0') === 0, n([b], '150.5')],
          ['「(」は文字', n([b], '(仮)') === 1 && n([b], '(') === 1, n([b], '(')],
          ['根拠・タグ・メモの欠けた記録でも止まらない', n([tagged('C', { memo: null, entryReasons: null, tags: undefined })], 'あ') === 0, ''],
        ]);
      }),

    t('LF-17', '決済価格か決済日時が欠けた closed の記録は、一覧と同じ「保有中」の扱い（絞り込みでも）', 'status=closed だが決済価格なし（T-19 の判定）',
      '状態＝保有中で出る／決済済みで出ない／勝敗の絞り込みで出ない／期間はエントリー日時で判定',
      () => {
        const odd = tagged('ODD', { exitPrice: null, entryAt: '2026-10-15T09:00:00+09:00' });
        const n = (over) => buildView([odd], makeFilter(over), NOW).total;
        return verdict([
          ['保有中', n({ status: 'open' }) === 1, n({ status: 'open' })],
          ['決済済み', n({ status: 'closed' }) === 0, n({ status: 'closed' })],
          ['勝敗', n({ outcomes: ['win'] }) === 0, n({ outcomes: ['win'] })],
          ['今日（エントリー日時で判定）', n({ period: { preset: 'today' } }) === 1, n({ period: { preset: 'today' } })],
        ]);
      }),

    t('LF-18', '期間の境目は日本時間 0:00（端末のタイムゾーンに依存しない）。Z 表記の時刻も同じ瞬間として扱う', '今日＝10/15。決済 10/14 23:59:59／10/15 00:00:00／10/15 23:59:59／10/16 00:00:00（JST）と、UTC 表記の 10/14 15:00:00Z',
      '10/15 00:00:00 と 23:59:59 と 15:00:00Z（＝10/15 0:00 JST）が入り、前後は入らない',
      () => {
        const at2 = (id, exit) => tagged(id, { exitAt: exit, entryAt: '2026-10-10T10:00:00+09:00' });
        const list = [
          at2('A', '2026-10-14T23:59:59+09:00'), at2('B', '2026-10-15T00:00:00+09:00'), at2('C', '2026-10-15T23:59:59+09:00'),
          at2('D', '2026-10-16T00:00:00+09:00'), at2('E', '2026-10-14T15:00:00Z'),
        ];
        const got = ids(buildView(list, makeFilter({ period: { preset: 'today' } }), NOW).groups.flatMap((g) => g.items)).sort().join(' ');
        return verdict([['今日に入る記録', got === 'B C E', got]]);
      }),

    t('LF-19', '通貨ペアの選択肢：記録にあるペアだけ。よく使う順 → アルファベット順。削除済みだけのペアは出さない', 'SAMPLE ＋ よく使う [GBP/JPY, USD/JPY, AUD/USD]',
      'GBP/JPY, USD/JPY（よく使う順）→ AUD/JPY, EUR/GBP, EUR/JPY, EUR/USD, GBP/USD（記録はあるが AUD/USD は無い）',
      () => {
        const del = tagged('DEL', { pair: 'NZD/USD', deletedAt: '2026-10-15T09:00:00+09:00' });
        const got = pairOptions([...SAMPLE, del], ['GBP/JPY', 'USD/JPY', 'AUD/USD']);
        return verdict([
          ['並び', got.join(', ') === 'GBP/JPY, USD/JPY, AUD/JPY, EUR/GBP, EUR/JPY, EUR/USD, GBP/USD', got.join(', ')],
          ['記録なし', pairOptions([]).length === 0, ''],
        ]);
      }),

    t('LF-20', '期間の説明（シート）と日付欄の表示', '今 10/15（木）',
      '今月＝10/1（木）〜10/31（土）／今日＝10/15（木）／全期間・指定は空／10/13(火)／日付が読めなければ空',
      () => {
        const d = (preset) => describePeriodRange({ preset, from: null, to: null }, NOW);
        return verdict([
          ['今月', d('thisMonth') === '10/1（木）〜10/31（土）', d('thisMonth')],
          ['今日', d('today') === '10/15（木）', d('today')],
          ['今週', d('thisWeek') === '10/12（月）〜10/18（日）', d('thisWeek')],
          ['全期間・指定', d('all') === '' && d('custom') === '', ''],
          ['日付欄', formatYmdLabel('2026-10-13', NOW) === '10/13(火)', formatYmdLabel('2026-10-13', NOW)],
          ['去年の日付は年付き', formatYmdLabel('2025-12-30', NOW) === '2025/12/30(火)', formatYmdLabel('2025-12-30', NOW)],
          ['読めない', formatYmdLabel('', NOW) === '' && formatYmdLabel('2026-02-30', NOW) === '', ''],
        ]);
      }),

    t('LF-21', '渡した条件・記録は書き換えない／条件の違う2回の呼び出しが互いに影響しない', 'SAMPLE と条件を渡す前後の比較',
      '同じ',
      () => {
        const f = makeFilter({ keyword: 'ルール違反', pairs: ['USD/JPY'], outcomes: ['loss'] });
        const before = JSON.stringify([SAMPLE, f]);
        buildView(SAMPLE, f, NOW);
        countMatches(SAMPLE, f, NOW);
        describeFilter(f, NOW);
        return verdict([['内容', JSON.stringify([SAMPLE, f]) === before, 'changed']]);
      }),

    t('LF-22', '1,000件でも条件を変えて絞り込める（キーワード・期間・勝敗の併用）', '1,000件（本番とデモが交互・28日分・5件に1件だけタグ「見直し」・4件に1件が負け）',
      '「見直し」＋勝ち＋本番 で期待の件数（10の倍数番目で4の倍数でないもの）。続き読み込みの切り出しも欠けない',
      () => {
        const list = [];
        for (let i = 0; i < 1000; i += 1) {
          const day = String(1 + (i % 28)).padStart(2, '0');
          list.push(trade(`K${String(i).padStart(4, '0')}`, i % 2 ? 'demo' : 'real', 'USD/JPY', 'buy', `2026-09-${day} 09:00`, `2026-09-${day} 10:${String(i % 60).padStart(2, '0')}`,
            1, i % 4 === 0 ? -100 : 100, { tags: i % 5 === 0 ? ['見直し'] : [] }));
        }
        const v = buildView(list, makeFilter({ keyword: '見直し', outcomes: ['win'], accountType: 'real' }), NOW);
        const n = v.groups.reduce((sum, g) => sum + g.items.length, 0);
        // 本番＝偶数番目、タグ「見直し」＝5の倍数番目 → 10の倍数番目。そのうち4の倍数番目は負けなので除く
        const wantN = list.filter((x, i) => i % 10 === 0 && i % 4 !== 0).length;
        const entries = flattenView(v);
        return verdict([
          ['件数', v.total === wantN && n === wantN, `${v.total}/${n}（期待 ${wantN}）`],
          ['切り出しで欠けない', entries.filter((e) => e.type === 'row').length === wantN, ''],
        ]);
      }),
  );
  return tests;
}
