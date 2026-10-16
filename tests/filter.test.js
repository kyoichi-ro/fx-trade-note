/* =========================================================
   tests/filter.test.js
   一覧の並び順・日付グループ・件数/合計損益（js/filter.js）のテスト（T-19。analytics.md 4.6・4.7・4.11）。
   ・analytics 4.11 のサンプルデータ（T01〜T12）で、条件なしの L-01 と同じ結果になること
     （表示順・日付の見出し・本番とデモ別の件数/合計損益/合計 pips・削除済みの除外）
   ・日計は「その日の全件」で計算すること、サマリーが1口座のときだけ日計を出すこと（design 14.3.5）
   ・「最初の約50件→続き」の切り出し（flattenView / nextChunkEnd）で行が欠けたり重なったりしないこと
   ・status は決済価格と決済日時の両方があるときだけ「決済済み」として扱うこと
   絞り込み条件つきの L-02〜L-27 と D・N 系は T-23 で足す。
   IndexedDB・localStorage を使わないので、Node.js でもブラウザでも実行する。

   ID：LV-xx（一覧の集計）
   ========================================================= */
import {
  isClosedTrade, summarize, summaryRows, canShowDailyTotals, buildListView, flattenView, nextChunkEnd,
} from '../js/filter.js';
import { show } from './helpers.js';

const CATEGORY = '一覧';

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
    ...extra,
  };
}

/** analytics 4.11.2 のサンプルデータ（12件）。T11 は論理削除 */
export const SAMPLE = [
  trade('T01', 'real', 'USD/JPY', 'buy', '2026-10-15 09:10', '2026-10-15 10:30', 25.0, 2500),
  trade('T02', 'real', 'EUR/USD', 'buy', '2026-10-14 21:00', '2026-10-14 23:40', 25.0, 3750),
  trade('T03', 'demo', 'USD/JPY', 'buy', '2026-10-15 10:45', '2026-10-15 11:20', -37.7, -1885),
  trade('T04', 'real', 'GBP/JPY', 'sell', '2026-10-13 16:00', '2026-10-13 17:30', -25.0, -50000),
  trade('T05', 'demo', 'EUR/JPY', 'buy', '2026-10-12 08:00', '2026-10-12 09:00', 0.0, 0),
  trade('T06', 'real', 'USD/JPY', 'buy', '2026-10-09 22:00', '2026-10-09 22:30', 0.5, -30, { profitSource: 'manual' }),
  trade('T07', 'real', 'GBP/USD', 'buy', '2026-09-30 22:00', '2026-09-30 23:50', -37.7, -5700, { profitSource: 'manual' }),
  trade('T08', 'real', 'USD/JPY', 'sell', '2026-09-30 21:00', '2026-10-01 00:05', 25.0, 2500),
  trade('T09', 'real', 'USD/JPY', 'buy', '2026-10-15 11:30', null, null, null),
  trade('T10', 'demo', 'AUD/JPY', 'buy', '2026-09-28 10:00', null, null, null),
  trade('T11', 'real', 'USD/JPY', 'buy', '2026-10-15 08:00', '2026-10-15 08:30', 25.0, 2500, { deletedAt: at('2026-10-15 08:40') }),
  trade('T12', 'demo', 'EUR/GBP', 'sell', '2026-10-14 17:00', '2026-10-14 18:10', 18.0, 3428),
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
  ];
}
