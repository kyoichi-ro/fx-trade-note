/* =========================================================
   js/filter.js
   一覧の並び順・日付グループ・件数/合計損益（analytics.md 4.6・4.7・4.10、architecture.md 4.2）。

   【T-19 の段階】条件なし（初期状態）の一覧に必要な部分だけ：
     ・論理削除の除外（analytics 3章ルール1）
     ・並び順：保有中＝エントリー日時の新しい順、決済済み＝決済日時の新しい順（4.6）
     ・決済日（日本時間）ごとのグループと日計
     ・サマリー：件数・合計損益・合計 pips を本番とデモに分けて計算（4.7）
     ・行の平らな並び（flattenView）と、描画する分だけ切り出す nextChunkEnd（最初の約50件→続き：4.9 #5）
   絞り込み条件（口座・期間・勝敗・キーワードなど）と DEFAULT_FILTER は T-23 でこのファイルに足す。

   ・analytics 4.10 の擬似コードと同じ結果になるように書いた（4.11 の L-01 を tests/filter.test.js で確かめている）。
   ・ここは画面（document）も IndexedDB も触らない純粋な関数だけ。Node.js でもテストできる。
   ・日付の計算は getUTC 系（datetime.js の jstParts）だけを使うので、端末のタイムゾーンに左右されない。

   依存：datetime, format
   ========================================================= */
import { jstParts } from './datetime.js';
import { formatDateHeading, toTenths } from './format.js';

/**
 * 「決済済み」として扱う記録か。
 * 決済価格と決済日時の両方があるときだけ決済済み（trades.js の judgeStatus と同じ判定。2026-10-16 オーナー決定）。
 * status が closed でも片方が欠けている記録は、pips を計算できないので「保有中」の扱いにする
 * （一覧に［決済］が出るので、利用者が決済をやり直して直せる）。
 */
export function isClosedTrade(t) {
  return t.status === 'closed' && t.exitPrice != null && t.exitAt != null;
}

/** 日時の文字をミリ秒にする。読めなければ 0（並べ替えで NaN が混ざって順番が壊れないようにするため。保存形式なら読める） */
function toMs(text) {
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 並べ替えに使う値を足した記録を作る（読み込みのたびに1回だけ。IndexedDB には保存しない：analytics 4.9 #3）。
 * 日時の文字をそのまま大小比較すると、形式が混ざったときに順番が狂うため、数値（ミリ秒）で比べる（#4）。
 */
function prepare(t) {
  const closed = isClosedTrade(t);
  return { trade: t, closed, entryMs: toMs(t.entryAt), exitMs: closed ? toMs(t.exitAt) : null };
}

const byId = (a, b) => (a.trade.id < b.trade.id ? -1 : a.trade.id > b.trade.id ? 1 : 0);

/**
 * 保有中と決済済みに分けて並べる（analytics 4.6）。同じ日時のときは毎回同じ順になるよう id で決める。
 * @param {object[]} prepared prepare() の結果の配列
 * @returns {{ open: object[], closed: object[] }}
 */
export function sortForList(prepared) {
  const open = prepared.filter((p) => !p.closed)
    .sort((a, b) => b.entryMs - a.entryMs || byId(a, b));
  const closed = prepared.filter((p) => p.closed)
    .sort((a, b) => b.exitMs - a.exitMs || b.entryMs - a.entryMs || byId(a, b));
  return { open, closed };
}

/**
 * 決済済みを決済日（日本時間）ごとにまとめる。closed は決済日時の新しい順に並んでいる前提。
 * 日計（profitJpy）はその日の全件の損益（円）を整数のまま足した値（表示する行が最初の約50件だけでも、その日の全件で計算：design 14.3.5）。
 * 損益（円）が空の記録は足さない。その日に足せる記録が1件もなければ null（「±0円」と区別するため）。
 * @param {object[]} closed
 * @param {number} nowMs 「今年」の判定に使う今（見出しに年を付けるか）
 * @returns {{ key: string, label: string, items: object[], profitJpy: number|null }[]}
 */
export function groupClosedByDate(closed, nowMs) {
  const groups = [];
  for (const p of closed) {
    const d = jstParts(new Date(p.exitMs));
    const key = `${d.year}-${d.month}-${d.day}`;
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, label: formatDateHeading(new Date(p.exitMs), new Date(nowMs)), items: [], profitJpy: null };
      groups.push(g);
    }
    g.items.push(p);
    if (p.trade.profitJpy != null) g.profitJpy = (g.profitJpy ?? 0) + p.trade.profitJpy;
  }
  return groups;
}

/** 口座ごとの集計の入れ物 */
function emptyAccount() {
  return { count: 0, openCount: 0, closedCount: 0, profitJpy: 0, pipsTenths: 0 };
}

/**
 * サマリー（件数・合計損益・合計 pips）を、本番とデモに分けて計算する（analytics 4.7.1。混ぜた合計は作らない：3章ルール6）。
 * ・件数は保有中も数える。損益・pips の合計は決済済みだけ（保有中は未確定のため）
 * ・損益（円）は整数のまま足す。pips は 0.1pips 単位の整数にして足し、表示するときに10で割る（誤差を積まないため）
 * ・決済済みなのに損益（円）が空の記録は、件数にだけ数えて合計には入れない（本来ありえないデータ：4.7.1）
 * @param {object[]} prepared prepare() の結果の配列
 * @returns {{ total: number, byAccount: { real: object, demo: object } }}
 */
export function summarize(prepared) {
  const s = { total: 0, byAccount: { real: emptyAccount(), demo: emptyAccount() } };
  for (const p of prepared) {
    const a = s.byAccount[p.trade.accountType];
    if (!a) continue; // 口座区分が壊れている記録は数えない（デモにも本番にも入れられないため）
    s.total += 1;
    a.count += 1;
    if (!p.closed) {
      a.openCount += 1;
      continue;
    }
    if (p.trade.profitJpy == null) continue;
    a.closedCount += 1;
    a.profitJpy += p.trade.profitJpy;
    a.pipsTenths += p.trade.pips == null ? 0 : toTenths(p.trade.pips);
  }
  return s;
}

/**
 * 表示するサマリーの行（本番が上、デモが下。件数0の口座は出さない：analytics 4.7.2）。
 * 決済済みが1件もない口座の損益・pips は null（画面は「—」。「±0円」とは区別する）。
 * @param {ReturnType<typeof summarize>} summary
 * @returns {{ account: 'real'|'demo', count: number, openCount: number, profitJpy: number|null, pipsTenths: number|null }[]}
 */
export function summaryRows(summary) {
  return ['real', 'demo']
    .filter((account) => summary.byAccount[account].count > 0)
    .map((account) => {
      const a = summary.byAccount[account];
      const settled = a.closedCount > 0;
      return {
        account,
        count: a.count,
        openCount: a.openCount,
        profitJpy: settled ? a.profitJpy : null,
        pipsTenths: settled ? a.pipsTenths : null,
      };
    });
}

/**
 * 日付見出しの日計を出してよいか。サマリーが1口座のときだけ（デモと本番が混在のときは出さない：design 14.3.5）。
 * 判定はサマリーの行数と同じ（行が1つなら1口座）。
 */
export function canShowDailyTotals(summary) {
  return summaryRows(summary).length === 1;
}

/**
 * 一覧に渡すデータを作る（analytics 4.10 の buildListView の T-19 版。条件なし＝論理削除だけを除く）。
 * 絞り込み条件を渡せる形にするのは T-23。
 * @param {object[]} trades getAllTrades() の結果（削除済みを含んでよい）
 * @param {number} nowMs 今（ミリ秒）。テストでは固定値を渡す
 * @returns {{ total: number, open: object[], groups: object[], summary: object, showDailyTotals: boolean }}
 *   open と groups の中身は { trade, closed, entryMs, exitMs }
 */
export function buildListView(trades, nowMs) {
  const prepared = trades.filter((t) => t.deletedAt == null).map(prepare);
  const { open, closed } = sortForList(prepared);
  const summary = summarize(prepared);
  return {
    total: prepared.length,
    open,
    groups: groupClosedByDate(closed, nowMs),
    summary,
    showDailyTotals: canShowDailyTotals(summary),
  };
}

/**
 * 画面に上から順に描く要素の並び（見出しと行）にする。
 * 「保有中 n件」の見出し → 保有中の行 → 決済日の見出し → その日の行 …
 * 平らな並びにしておくと、「最初の50行」「続きの50行」を同じ処理で切り出せる（nextChunkEnd）。
 * @param {ReturnType<typeof buildListView>} view
 * @returns {({ type: 'open-header', count: number } | { type: 'date-header', label: string, profitJpy: number|null } | { type: 'row', item: object })[]}
 */
export function flattenView(view) {
  const entries = [];
  if (view.open.length > 0) {
    entries.push({ type: 'open-header', count: view.open.length });
    for (const item of view.open) entries.push({ type: 'row', item });
  }
  for (const g of view.groups) {
    entries.push({ type: 'date-header', label: g.label, profitJpy: g.profitJpy });
    for (const item of g.items) entries.push({ type: 'row', item });
  }
  return entries;
}

/**
 * entries の start 番目から、行が rowLimit 行になるところまでの終わりの位置（含まない）を返す。
 * 行の数だけを数え、見出しは数えない。行の直前の見出しは行と一緒に切り出される（見出しだけで終わらない）。
 * @param {object[]} entries flattenView() の結果
 * @param {number} start 切り出しを始める位置
 * @param {number} rowLimit 足す行数
 * @returns {number}
 */
export function nextChunkEnd(entries, start, rowLimit) {
  let rows = 0;
  let i = start;
  while (i < entries.length && rows < rowLimit) {
    if (entries[i].type === 'row') rows += 1;
    i += 1;
  }
  return i;
}
