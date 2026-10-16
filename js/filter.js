/* =========================================================
   js/filter.js
   一覧の絞り込み・キーワード検索・並び順・日付グループ・件数/合計損益（analytics.md 4章、architecture.md 4.2）。

   【T-19】条件なし（初期状態）の一覧に必要な部分：
     ・論理削除の除外（analytics 3章ルール1）
     ・並び順：保有中＝エントリー日時の新しい順、決済済み＝決済日時の新しい順（4.6）
     ・決済日（日本時間）ごとのグループと日計
     ・サマリー：件数・合計損益・合計 pips を本番とデモに分けて計算（4.7）
     ・行の平らな並び（flattenView）と、描画する分だけ切り出す nextChunkEnd（最初の約50件→続き：4.9 #5）
   【T-23】絞り込み条件を足した：
     ・DEFAULT_FILTER と buildListView(trades, filter, nowMs)（4.10。T-19 の申し送り #4）
     ・口座・状態・通貨ペア・売買方向・期間（日本時間・週は月曜始まり・決済済みは決済日時）・勝敗・キーワード（4.2〜4.5）
     ・勝敗は calc.js の judgeResult と同じ判定（二重に書かない：architecture 13.1）
     ・条件チップの文言（describeFilter）、チップのタップで1項目だけ初期値に戻す（clearCondition）
     ・30分以内の復元（packFilter / restoreFilter：4.8）、壊れた保存値を初期値で補う（normalizeFilter）
     ・シートの「n件を表示」用の件数（countMatches）と通貨ペアの選択肢（pairOptions）

   ・analytics 4.10 の擬似コードと同じ結果になるように書いた（4.11 の L-01〜L-27・D-01〜D-09・N-01〜N-02 を tests/filter.test.js で確かめている）。
   ・ここは画面（document）も IndexedDB も localStorage も触らない純粋な関数だけ。Node.js でもテストできる。
   ・日付の計算は getUTC 系（datetime.js の jstParts）だけを使うので、端末のタイムゾーンに左右されない。

   依存：datetime, format, calc, config
   ========================================================= */
import { jstParts, toJstString, isWithinMinutes } from './datetime.js';
import { formatDateHeading, toTenths } from './format.js';
import { judgeResult } from './calc.js';
import { LIST_FILTER_RESTORE_MINUTES } from './config.js';

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
    // 'constructor' など Object が元から持つ名前を拾わないよう、自分のキーだけを見る（壊れた記録で Object を書き換えないため）
    const a = Object.hasOwn(s.byAccount, p.trade.accountType) ? s.byAccount[p.trade.accountType] : null;
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

/* ---------------------------------------------------------
   絞り込み条件（T-23。analytics 4.2〜4.5・4.10）
   --------------------------------------------------------- */

/** 期間の選択肢（シートの並び順どおり）と、シート・チップに出す短い名前（design 14.3.10：「全期間」「指定」） */
export const PERIOD_PRESETS = Object.freeze(['all', 'today', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'thisYear', 'custom']);
export const PERIOD_LABELS = Object.freeze({
  all: '全期間', today: '今日', thisWeek: '今週', lastWeek: '先週', thisMonth: '今月', lastMonth: '先月', thisYear: '今年', custom: '指定',
});

/** 勝敗の選択肢（表示順。チップの文言「勝ち・引き分け」の順もこれ） */
export const OUTCOMES = Object.freeze(['win', 'loss', 'draw']);
export const OUTCOME_LABELS = Object.freeze({ win: '勝ち', loss: '負け', draw: '引き分け' });

/** 条件の項目名（絞り込みシートの項目順＝チップの並び順：design 14.3.7）。period は { preset, from, to } をまとめて1項目と数える */
export const FILTER_KEYS = Object.freeze(['keyword', 'accountType', 'period', 'outcomes', 'status', 'side', 'pairs']);

/** キーワードの最大文字数（analytics 4.2 #7） */
export const KEYWORD_MAX_LENGTH = 100;

/**
 * 初期値（analytics 4.10）。アプリを開いたとき・「すべて解除」のときの状態で、「その条件では絞り込まない」の意味。
 * 配列やオブジェクトを書き換えられてしまわないよう凍結してある。書き換えたいときは defaultFilter() で写しを作る。
 */
export const DEFAULT_FILTER = Object.freeze({
  accountType: 'all', // 'all' | 'real' | 'demo'
  status: 'all', // 'all' | 'open' | 'closed'
  pairs: Object.freeze([]), // 例 ['USD/JPY', 'EUR/USD']。空＝すべて（中は OR）
  side: 'all', // 'all' | 'buy' | 'sell'
  period: Object.freeze({ preset: 'all', from: null, to: null }), // from / to は 'YYYY-MM-DD'（custom のときだけ。片方だけでも可）
  outcomes: Object.freeze([]), // 'win' | 'loss' | 'draw'。空＝すべて（中は OR）
  keyword: '',
});

/** 初期値の写し（書き換えてよい） */
export function defaultFilter() {
  return { ...DEFAULT_FILTER, pairs: [], outcomes: [], period: { ...DEFAULT_FILTER.period } };
}

/** 条件の写し（シートの中で下書きとして触るため。元の条件は書き換えない） */
export function cloneFilter(f) {
  return { ...f, pairs: [...f.pairs], outcomes: [...f.outcomes], period: { ...f.period } };
}

/* ---------- 日本時間の計算 ---------- */

/** 日本時間と UTC の差（日本は夏時間がないので常に＋9時間）と、1日 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 日本時間の y年 m月（1〜12）d日 0:00 の時刻（ミリ秒）。
 * d や m がはみ出しても（d = 0、m = 0 など）Date.UTC が前後の月・年に繰り越してくれる。
 * 端末のタイムゾーンを見ない（UTC で作ってから日本時間の差を引く）。
 */
function jstMidnight(y, m, d) {
  return Date.UTC(y, m - 1, d) - JST_OFFSET_MS;
}

/** 'YYYY-MM-DD' → 日本時間のその日 0:00。実在しない日付・形が違う文字は null（片方が壊れていても条件全体を捨てないため） */
function parseYmd(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = jstMidnight(y, mo, d);
  const back = jstParts(new Date(ms));
  return back && back.year === y && back.month === mo && back.day === d ? ms : null;
}

/**
 * 期間 → [開始, 終了)（開始を含み、終了を含まない半開区間）。null＝制限なし。
 * 半開区間にするのは、境目の時刻（例：10/16 0:00 ちょうど）が「今日」と「明日」の両方に数えられるのを防ぐため。
 * 週は月曜始まり（FX の市場は月曜の朝に始まるので、1週間の取引がひとつの週に収まる：analytics 4.4.2）。
 * @param {{ preset: string, from: (string|null), to: (string|null) }} period
 * @param {number} nowMs 今（ミリ秒）。テストでは固定値を渡す
 * @returns {[number, number]|null}
 */
export function periodRange(period, nowMs) {
  const now = jstParts(new Date(nowMs));
  if (!now) return null;
  const { year: y, month: m, day: d, weekday } = now;
  const fromMonday = (weekday + 6) % 7; // 月曜＝0 … 日曜＝6
  switch (period.preset) {
    case 'today': return [jstMidnight(y, m, d), jstMidnight(y, m, d + 1)];
    case 'thisWeek': return [jstMidnight(y, m, d - fromMonday), jstMidnight(y, m, d - fromMonday + 7)];
    case 'lastWeek': return [jstMidnight(y, m, d - fromMonday - 7), jstMidnight(y, m, d - fromMonday)];
    case 'thisMonth': return [jstMidnight(y, m, 1), jstMidnight(y, m + 1, 1)];
    case 'lastMonth': return [jstMidnight(y, m - 1, 1), jstMidnight(y, m, 1)];
    case 'thisYear': return [jstMidnight(y, 1, 1), jstMidnight(y + 1, 1, 1)];
    case 'custom': {
      let from = parseYmd(period.from);
      let to = parseYmd(period.to);
      if (from !== null && to !== null && from > to) [from, to] = [to, from]; // 逆順なら自動で入れ替える（片手でやり直させない）
      if (from === null && to === null) return null; // 日付が1つも入っていない＝絞り込まない
      return [from ?? -Infinity, to === null ? Infinity : to + DAY_MS]; // 終了日はその日の終わりまで含める
    }
    default: return null; // 'all'、知らない値
  }
}

/* ---------- キーワード（analytics 4.5） ---------- */

/**
 * 表記ゆれをそろえる（検索語と記録の両方に同じ処理をしてから比べる）。
 * NFKC（全角英数→半角、半角カナ→全角カナ、濁点を1文字に）→ 小文字 → カタカナをひらがなに。
 * 漢字とかな、長音「ー」は区別したまま（読みの変換はしない）。
 */
export function normalizeForSearch(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** 検索語 → 語の配列。全角・半角の空白で区切る（空なら []）。複数語は「すべて含む」（AND） */
export function toTokens(keyword) {
  return normalizeForSearch(keyword).split(/\s+/).filter(Boolean);
}

/**
 * キーワード検索の対象（メモ・エントリー根拠・タグ。通貨ペアなどの選択項目は対象外：analytics 4.5.1）を、
 * 項目ごとに正規化して改行でつなぐ。改行でつなぐのは、メモの末尾と根拠の先頭がつながって偶然一致するのを防ぐため
 * （検索語には改行が入らない）。
 */
function searchText(t) {
  const list = (v) => (Array.isArray(v) ? v : []);
  return [t.memo, ...list(t.entryReasons), ...list(t.tags)].map(normalizeForSearch).join('\n');
}

/* ---------- 1件が条件に合うか（analytics 4.10 の matchesFilter） ---------- */

/**
 * 勝ち/負け/引き分け。判定は calc.js の judgeResult（fx-rules 7章。損益（円）の符号だけで決める）と同じ。
 * 一覧で「決済済み」として扱わない記録（決済価格か決済日時が欠けたもの）は、勝敗も付けない。
 */
function outcomeOf(p) {
  return p.closed ? judgeResult(p.trade) : null;
}

/** 期間の判定に使う日時：保有中＝エントリー日時、決済済み＝決済日時（analytics 4.4.1） */
const baseTimeMs = (p) => (p.closed ? p.exitMs : p.entryMs);

/**
 * 異なる項目どうしは AND、同じ項目の中の複数選択は OR、キーワードの複数語は AND（analytics 4.3）。
 * 「保有中」「決済済み」は一覧の分け方（isClosedTrade）に合わせる。画面に出ているグループと、絞り込みの結果がずれないようにするため。
 */
function matchesFilter(p, f, range, tokens) {
  const t = p.trade;
  if (f.accountType !== 'all' && t.accountType !== f.accountType) return false;
  if (f.status === 'open' && p.closed) return false;
  if (f.status === 'closed' && !p.closed) return false;
  if (f.pairs.length > 0 && !f.pairs.includes(t.pair)) return false;
  if (f.side !== 'all' && t.side !== f.side) return false;
  if (range) {
    const b = baseTimeMs(p);
    if (!(b >= range[0] && b < range[1])) return false;
  }
  if (f.outcomes.length > 0) {
    const o = outcomeOf(p);
    if (o === null || !f.outcomes.includes(o)) return false; // 保有中は勝敗がないのでここで外れる
  }
  if (tokens.length > 0) {
    const text = searchText(t);
    if (!tokens.every((w) => text.includes(w))) return false;
  }
  return true;
}

/** 論理削除を除いた全件に、並べ替えなどに使う値を足す */
function prepareAll(trades) {
  return trades.filter((t) => t.deletedAt == null).map(prepare);
}

/** 条件に合う記録だけを選ぶ（prepare 済みの配列から） */
function selectHits(prepared, filter, nowMs) {
  const range = periodRange(filter.period, nowMs);
  const tokens = toTokens(filter.keyword);
  return prepared.filter((p) => matchesFilter(p, filter, range, tokens));
}

/**
 * 条件に合う件数（論理削除は除く）。絞り込みシートの「12件を表示」を、条件を変えるたびに作り直すために使う。
 * 並べ替え・日付のまとめ・合計は行わないので軽い（1,000件でも数ミリ秒：analytics 4.9）。
 * @param {object[]} trades getAllTrades() の結果
 * @param {object} filter
 * @param {number} nowMs
 */
export function countMatches(trades, filter, nowMs) {
  return selectHits(prepareAll(trades), filter, nowMs).length;
}

/* ---------- 条件の状態（チップ・個数・解除） ---------- */

/** 期間が絞り込みとして働いているか。「指定」なのに日付が1つも入っていないときは働かない */
function isPeriodActive(period) {
  if (period.preset === 'all') return false;
  if (period.preset === 'custom') return periodRange(period, 0) !== null;
  return PERIOD_PRESETS.includes(period.preset);
}

/** その項目が初期値から変わっているか */
export function isFilterKeyActive(filter, key) {
  switch (key) {
    case 'keyword': return filter.keyword.trim() !== '';
    case 'accountType': return filter.accountType !== 'all';
    case 'period': return isPeriodActive(filter.period);
    case 'outcomes': return filter.outcomes.length > 0;
    case 'status': return filter.status !== 'all';
    case 'side': return filter.side !== 'all';
    case 'pairs': return filter.pairs.length > 0;
    default: return false;
  }
}

/** 初期値から変えている項目の数（絞り込みボタンに出す数字：analytics 4.2） */
export function countActiveConditions(filter) {
  return FILTER_KEYS.filter((key) => isFilterKeyActive(filter, key)).length;
}

/** 条件を1項目だけ初期値に戻した、新しい条件（チップのタップ。元の条件は書き換えない） */
export function clearCondition(filter, key) {
  const next = cloneFilter(filter);
  const d = defaultFilter();
  if (key in d) next[key] = d[key];
  return next;
}

/**
 * 「状態＝保有中」のときは勝敗を選べない（必ず0件になる組み合わせを作らせない：analytics 4.2）。
 * シートで状態を保有中にしたときと、保存値の復元で使う。buildListView 自体はこの補正をしない（L-26：ロジックとしては0件になる）。
 */
export function fixConflicts(filter) {
  const next = cloneFilter(filter);
  if (next.status === 'open') next.outcomes = [];
  return next;
}

/* ---------- 期間の文言（チップ・シートの説明） ---------- */

const WEEKDAYS = '日月火水木金土';

/** 月/日。今年以外は年も付ける（'10/13'、'2025/12/30'） */
function monthDay(ms, nowMs) {
  const p = jstParts(new Date(ms));
  const now = jstParts(new Date(nowMs));
  return now && now.year === p.year ? `${p.month}/${p.day}` : `${p.year}/${p.month}/${p.day}`;
}

/** 月/日(曜)（'10/13(火)'）。今年以外は年も付ける。'YYYY-MM-DD' を受け取る（日付欄の表示用。読めなければ ''） */
export function formatYmdLabel(ymd, nowMs) {
  const ms = parseYmd(ymd);
  if (ms === null) return '';
  const p = jstParts(new Date(ms));
  return `${monthDay(ms, nowMs)}(${WEEKDAYS[p.weekday]})`;
}

/** 範囲の最後の日（半開区間の終了の前日）の 0:00 */
const lastDayMs = (range) => range[1] - DAY_MS;

/** 範囲の文言。1日だけなら「10/15」、複数日なら「10/1〜10/31」（チップ用。曜日なし） */
function rangeText(range, nowMs) {
  const from = monthDay(range[0], nowMs);
  const last = lastDayMs(range);
  return range[0] === last ? from : `${from}〜${monthDay(last, nowMs)}`;
}

/**
 * シートの期間の説明に出す範囲（曜日付き）。例：'10/1（木）〜10/31（土）'、今日なら '10/15（木）'。
 * 「全期間」「指定」など範囲を決められないときは ''。
 */
export function describePeriodRange(period, nowMs) {
  if (period.preset === 'all' || period.preset === 'custom') return '';
  const range = periodRange(period, nowMs);
  if (!range) return '';
  const label = (ms) => {
    const p = jstParts(new Date(ms));
    return `${monthDay(ms, nowMs)}（${WEEKDAYS[p.weekday]}）`;
  };
  const last = lastDayMs(range);
  return range[0] === last ? label(range[0]) : `${label(range[0])}〜${label(last)}`;
}

/** 期間のチップの文言：「今月（10/1〜10/31）」「10/13〜10/14」「10/13以降」「10/14まで」（analytics 4.2） */
function periodChipLabel(period, nowMs) {
  const range = periodRange(period, nowMs);
  if (!range) return '';
  if (period.preset === 'custom') {
    const hasFrom = Number.isFinite(range[0]);
    const hasTo = Number.isFinite(range[1]);
    if (hasFrom && hasTo) return rangeText(range, nowMs);
    return hasFrom ? `${monthDay(range[0], nowMs)}以降` : `${monthDay(lastDayMs(range), nowMs)}まで`;
  }
  return `${PERIOD_LABELS[period.preset]}（${rangeText(range, nowMs)}）`;
}

/** 通貨ペアのチップの文言：1つ「USD/JPY」、2つ「USD/JPY・EUR/USD」、3つ以上「USD/JPY ほか2」 */
function pairsChipLabel(pairs) {
  if (pairs.length <= 2) return pairs.join('・');
  return `${pairs[0]} ほか${pairs.length - 1}`;
}

/**
 * 適用中の条件を、チップに出す形にする（シートの項目順：キーワード → 口座 → 期間 → 勝敗 → 状態 → 売買方向 → 通貨ペア。design 14.3.7）。
 * 初期値のままの項目は含めない。
 * @param {object} filter
 * @param {number} nowMs
 * @returns {{ key: string, label: string, ariaLabel: string }[]}
 *   key … clearCondition に渡す項目名／label … チップの文字／ariaLabel … 読み上げ用「本番の条件を解除」
 */
export function describeFilter(filter, nowMs) {
  const labels = {
    keyword: () => `“${filter.keyword.trim()}”`,
    accountType: () => (filter.accountType === 'real' ? '本番' : 'デモ'),
    period: () => periodChipLabel(filter.period, nowMs),
    outcomes: () => OUTCOMES.filter((o) => filter.outcomes.includes(o)).map((o) => OUTCOME_LABELS[o]).join('・'),
    status: () => (filter.status === 'open' ? '保有中' : '決済済み'),
    side: () => (filter.side === 'buy' ? '▲ 買い' : '▼ 売り'),
    pairs: () => pairsChipLabel(filter.pairs),
  };
  return FILTER_KEYS.filter((key) => isFilterKeyActive(filter, key)).map((key) => {
    const label = labels[key]();
    return { key, label, ariaLabel: `${label}の条件を解除` };
  });
}

/**
 * シートの通貨ペアの選択肢：記録（論理削除を除く）に1件以上あるペアだけ。
 * 並びは「よく使う通貨ペア」の順 → それ以外はアルファベット順（analytics 4.2 #3）。記録がないペアは選んでも0件になるので出さない。
 * @param {object[]} trades
 * @param {string[]} favorites 設定 favoritePairs
 */
export function pairOptions(trades, favorites = []) {
  const present = new Set();
  for (const t of trades) {
    if (t.deletedAt == null && typeof t.pair === 'string' && t.pair !== '') present.add(t.pair);
  }
  const fav = favorites.filter((p, i) => present.has(p) && favorites.indexOf(p) === i);
  const rest = [...present].filter((p) => !favorites.includes(p)).sort();
  return [...fav, ...rest];
}

/* ---------- 保存と復元（analytics 4.8・architecture 7.2） ---------- */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const PAIR_FORMAT = /^[A-Z]{3}\/[A-Z]{3}$/;

/**
 * 保存されていた条件（または何かの手違いで形が崩れた条件）を、使える形に直す。壊れた項目だけ初期値にする
 * （1つ壊れたために全部を捨てない：settings-store の方針と同じ）。
 * 期間は選択肢の名前で保存してあり、「今月」などは復元のたびに今の日付から計算し直される（periodRange）。
 */
export function normalizeFilter(raw) {
  const out = defaultFilter();
  if (!isPlainObject(raw)) return out;
  if (raw.accountType === 'real' || raw.accountType === 'demo') out.accountType = raw.accountType;
  if (raw.status === 'open' || raw.status === 'closed') out.status = raw.status;
  if (raw.side === 'buy' || raw.side === 'sell') out.side = raw.side;
  if (Array.isArray(raw.pairs)) {
    out.pairs = [...new Set(raw.pairs.filter((p) => typeof p === 'string' && PAIR_FORMAT.test(p)))];
  }
  if (Array.isArray(raw.outcomes)) out.outcomes = OUTCOMES.filter((o) => raw.outcomes.includes(o));
  if (isPlainObject(raw.period) && PERIOD_PRESETS.includes(raw.period.preset)) {
    out.period.preset = raw.period.preset;
    if (raw.period.preset === 'custom') {
      out.period.from = parseYmd(raw.period.from) === null ? null : raw.period.from;
      out.period.to = parseYmd(raw.period.to) === null ? null : raw.period.to;
    }
  }
  if (typeof raw.keyword === 'string') out.keyword = [...raw.keyword.trim()].slice(0, KEYWORD_MAX_LENGTH).join('');
  return fixConflicts(out);
}

/**
 * 保存する形（localStorage の listFilter：{ version, savedAt, filter }）にする。
 * savedAt は 30分以内かどうかを調べるための保存時刻（日本時間の固定形式：architecture 6.6）。
 * @param {object} filter
 * @param {Date} [now]
 */
export function packFilter(filter, now = new Date()) {
  return { version: 1, savedAt: toJstString(now), filter: cloneFilter(filter) };
}

/**
 * 保存されていた条件を、起動時に復元する。保存から30分以内ならその条件（壊れた項目は初期値で補う）、
 * 30分を超えていたり保存がなかったりすれば初期値（analytics 4.8）。
 * 初期値に戻す理由：一覧は「今の保有中」を確認するホームでもあり、前回の「デモだけ」などが残ったままだと
 * 保有中の記録が隠れて決済を忘れる、または「記録が消えた」と勘違いするおそれがあるため。
 * @param {{ version: number, savedAt: string, filter: object }|null} saved settings-store の listFilter
 * @param {Date} [now] 起動した時刻
 */
export function restoreFilter(saved, now = new Date()) {
  if (!saved || !isPlainObject(saved) || saved.version !== 1) return defaultFilter();
  if (!isWithinMinutes(saved.savedAt, LIST_FILTER_RESTORE_MINUTES, now)) return defaultFilter();
  return normalizeFilter(saved.filter);
}

/**
 * 一覧に渡すデータを作る（analytics 4.10 の buildListView）。論理削除は常に除き、filter の条件に合う記録だけを並べて合計する。
 * @param {object[]} trades getAllTrades() の結果（削除済みを含んでよい）
 * @param {object} filter 絞り込み条件（DEFAULT_FILTER と同じ形。初期値なら条件なし）
 * @param {number} nowMs 今（ミリ秒）。「今日」「今月」の範囲と、見出しに年を付けるかの判定に使う。テストでは固定値を渡す
 * @returns {{ recordCount: number, total: number, open: object[], groups: object[], summary: object, showDailyTotals: boolean }}
 *   recordCount … 条件に関係なく、論理削除を除いた全件の数（「記録が1件もない」と「条件に合う記録がない」を見分けるため：design 14.3.9）
 *   total       … 条件に合う件数
 *   open と groups の中身は { trade, closed, entryMs, exitMs }
 */
export function buildListView(trades, filter, nowMs) {
  const prepared = prepareAll(trades);
  const hits = selectHits(prepared, filter, nowMs);
  const { open, closed } = sortForList(hits);
  const summary = summarize(hits);
  return {
    recordCount: prepared.length,
    total: hits.length,
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
