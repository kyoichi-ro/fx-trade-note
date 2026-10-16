/* =========================================================
   js/detail-view.js
   S-04 トレード詳細に表示する内容を、記録 1 件から組み立てる（design.md 14.4.1・14.4.4、T-20）。

   【なぜ画面ファイル（screens/detail.js）と分けたのか】
   「保有時間」「数量」「各項目の表示文字」「未入力のときの —」の決めごとは、画面を開かなくても
   Node.js のテストで確かめられる形にしておきたいため。ここは document も IndexedDB も触らない純粋な関数だけ
   （画面はこの結果を並べて描くだけ）。

   【保存済みの値と、計算し直す値の使い分け（architecture 8章・requirements 6章）】
   ・保存済みの値をそのまま出すもの：pips・損益（円）・リスクリワード・セッション・損益の算出方法。
     保存のたびに recompute / 決済処理が作った値で、一覧・CSV・分析と同じ数字を見せるため。
     損益（円）は業者の確定値を手入力している記録もあり、価格から計算し直すと食い違う（fx-rules 4.4）。
   ・表示のたびに計算するもの：保有時間（保存しない：requirements 6.1 の補足）、数量（記録時の lotUnitSize で）、
     リスクリワードの 2 行目（損切り・利確の幅）、手入力の記録の「自動計算（参考）」。
     計算は calc.js を使い、ここに式は書かない（独自の式で結果が食い違うのを防ぐため）。
   ・値が空（null）の項目は、計算せずに「—」（EMPTY）を出す。

   依存：calc, master, datetime, format, filter（isClosedTrade）。すべて画面に依存しない層。
   ========================================================= */
import { calcPips, calcProfitJpy, calcRiskReward, calcQuantity } from './calc.js';
import {
  getPairSpec, SESSION_LABELS, TIMEFRAME_LABELS, EXIT_REASON_LABELS, PROFIT_SOURCE_LABELS,
} from './master.js';
import { diffMinutes } from './datetime.js';
import {
  formatPrice, formatYen, formatPips, formatPipsDistance, formatLots, formatQuantity, formatLotUnit, formatDuration,
  formatDateTime, formatShortDateTime, toneOf, toTenths, speakYen, speakPips,
} from './format.js';
import { isClosedTrade } from './filter.js';

/** 未入力・計算できないときの表示（design 14.4.4：行は消さずに「—」を出す） */
export const EMPTY = '—';

/** 数値として使える値か（null・文字・NaN を弾く。壊れたデータでも画面が止まらないように） */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isText = (v) => typeof v === 'string' && v !== '';

/** 価格を通貨ペアの桁数で。価格か通貨ペアが空・壊れているときは「—」（formatPrice は壊れたペアで例外になるため） */
function priceText(price, pair) {
  return isNum(price) && isText(pair) ? formatPrice(price, pair) : EMPTY;
}

/** 保存値 → 日本語名。表にない値（将来足した選択肢・壊れた値）は、消さずにそのまま見せる */
function labelOf(table, value) {
  if (!isText(value)) return EMPTY;
  return Object.hasOwn(table, value) ? table[value] : value;
}

/** 文字の並び（根拠・タグ）を「、」区切りに。空なら「—」 */
function listText(values) {
  const items = Array.isArray(values) ? values.filter(isText) : [];
  return items.length ? items.join('、') : EMPTY;
}

/** 行を作る。empty は値が「—」のとき true（画面が灰色にするため）。items は「、」区切りの項目の並び（なければ null） */
function row(key, label, value, extra = {}) {
  return { key, label, value, empty: value === EMPTY, numeric: false, sub: null, items: null, ...extra };
}

/**
 * 文字の並び（根拠・タグ）の行。value は「、」でつないだ文字、items は1つずつの並び。
 * 画面は items を1つずつまとめて折り返す（「ブレイクアウ／ト」のように言葉の途中で切れず、「、」の位置で改行できるように）。
 */
function listRow(key, label, values) {
  const items = Array.isArray(values) ? values.filter(isText) : [];
  return row(key, label, listText(values), { items: items.length ? items : null });
}

/* ---------------------------------------------------------
   個別の項目
   --------------------------------------------------------- */

/** 数量。例「5,000通貨（1lot＝10,000）」。lots × lotUnitSize は calcQuantity（記録時の 1lot：requirements 6.1） */
export function quantityText(t) {
  const q = calcQuantity(t.lots, t.lotUnitSize);
  if (q == null) return EMPTY;
  return `${formatQuantity(q)}（1lot＝${formatLotUnit(t.lotUnitSize)}）`;
}

/** 売買方向と価格がそろっていて、損切り・利確の幅を計算できる記録か */
function canMeasure(t) {
  return isText(t.pair) && (t.side === 'buy' || t.side === 'sell') && isNum(t.entryPrice);
}

/**
 * リスクリワードの行。値は保存済みの riskReward（小数第2位）。
 * 2 行目：計算できるときは「損切り 20.0 pips・利確 40.0 pips」。幅は calcPips にエントリー価格と SL/TP を渡して求める
 * （買いで SL が下にあれば負の値になるので、距離として絶対値で出す）。
 * SL/TP が売買方向と逆（W-01）のときは、値を「—」にして理由を 2 行目に出す（design 14.4.4）。
 * SL・TP のどちらかが空なら「—」だけ（2 行目なし）。
 */
export function riskRewardRow(t) {
  const stored = isNum(t.riskReward) ? t.riskReward.toFixed(2) : EMPTY;
  const base = row('riskReward', 'リスクリワード', stored, { numeric: true });
  if (!canMeasure(t) || !isNum(t.slPrice) || !isNum(t.tpPrice)) return base;

  const { warn } = calcRiskReward(t);
  if (warn.length > 0) {
    return { ...base, value: EMPTY, empty: true, sub: 'SL/TPが売買方向と逆のため計算していません' };
  }
  const sl = calcPips({ pair: t.pair, side: t.side, entryPrice: t.entryPrice, exitPrice: t.slPrice }).pips;
  const tp = calcPips({ pair: t.pair, side: t.side, entryPrice: t.entryPrice, exitPrice: t.tpPrice }).pips;
  return { ...base, sub: `損切り ${formatPipsDistance(sl)}・利確 ${formatPipsDistance(tp)}` };
}

/**
 * 保有時間（分）。決済済みはエントリー〜決済、保有中は「画面を開いた時点」まで（design 14.4.3）。
 * 保存はしない（requirements 6.1 の補足）。どちらかの日時が読めなければ null。
 * @param {object} t
 * @param {boolean} closed
 * @param {Date} now
 */
export function holdingMinutes(t, closed, now) {
  if (!isText(t.entryAt)) return null;
  if (closed) return isText(t.exitAt) ? diffMinutes(t.entryAt, t.exitAt) : null;
  return diffMinutes(t.entryAt, now);
}

/** 円換算レートの行（JPY ペアでは行ごと出さないので null を返す）。例「USD/JPY 149.850」 */
function quoteRateRow(t) {
  if (!isText(t.pair)) return null;
  const spec = getPairSpec(t.pair);
  if (spec.isJpyPair) return null;
  const value = isNum(t.quoteToJpyRate) ? `${spec.quoteToJpyPair} ${formatPrice(t.quoteToJpyRate, spec.quoteToJpyPair)}` : EMPTY;
  return row('quoteToJpyRate', '円換算レート', value, { numeric: true });
}

/** 「自動計算（参考）」の行。手入力の記録にだけ出す。計算できなければ「—」（design 14.4.4） */
function referenceProfitRow(t) {
  let value = EMPTY;
  // 必要な値が壊れていても画面が止まらないよう、数値がそろっているときだけ calc.js に渡す
  if (canMeasure(t) && isNum(t.exitPrice)) {
    value = formatYen(calcProfitJpy({
      pair: t.pair, side: t.side, entryPrice: t.entryPrice, exitPrice: t.exitPrice,
      lots: isNum(t.lots) ? t.lots : null, lotUnitSize: isNum(t.lotUnitSize) ? t.lotUnitSize : null,
      quoteToJpyRate: isNum(t.quoteToJpyRate) ? t.quoteToJpyRate : null,
    }));
  }
  return row('referenceProfit', '自動計算（参考）', value, { numeric: true });
}

/* ---------------------------------------------------------
   見出し（design 14.4.1「見出し」）
   --------------------------------------------------------- */

/** 読み上げ用の見出し。記号（▲・＋）をそのまま読ませない（design 14.3.4 と同じ考え方） */
function headSpeech(t, closed, holdText) {
  const parts = [];
  if (t.accountType === 'real') parts.push('本番');
  if (t.accountType === 'demo') parts.push('デモ');
  if (isText(t.pair)) parts.push(t.pair);
  if (t.side === 'buy') parts.push('買い');
  if (t.side === 'sell') parts.push('売り');
  if (closed) {
    parts.push('決済済み', speakYen(t.profitJpy), speakPips(t.pips));
  } else {
    parts.push('保有中', `エントリー価格 ${priceText(t.entryPrice, t.pair)}`);
    if (holdText !== EMPTY) parts.push(`保有時間 ${holdText}`);
  }
  return parts.join('、');
}

function buildHead(t, closed, hold) {
  const holdText = formatDuration(hold);
  const head = {
    account: t.accountType === 'demo' || t.accountType === 'real' ? t.accountType : null,
    status: closed ? 'closed' : 'open',
    pair: isText(t.pair) ? t.pair : EMPTY,
    side: t.side === 'buy' || t.side === 'sell' ? t.side : null,
    profit: null,
    pips: null,
    manual: false,
    openLine: null,
    speech: headSpeech(t, closed, holdText),
  };
  if (closed) {
    head.profit = { text: formatYen(t.profitJpy), tone: t.profitJpy == null ? 'none' : toneOf(t.profitJpy) };
    // pips は円とは別に自分の符号で色を付ける（design 14.3.4 と同じ）
    head.pips = { text: formatPips(t.pips), tone: t.pips == null ? 'none' : toneOf(toTenths(t.pips)) };
    head.manual = t.profitSource === 'manual';
  } else {
    // 例「151.234 で保有中・2時間15分」。保有時間が求められないときは「・…」ごと省く
    head.openLine = `${priceText(t.entryPrice, t.pair)} で保有中${holdText === EMPTY ? '' : `・${holdText}`}`;
  }
  return head;
}

/* ---------------------------------------------------------
   全体
   --------------------------------------------------------- */

function entrySection(t, now) {
  return {
    key: 'entry',
    header: 'エントリー',
    footer: null,
    rows: [
      row('entryAt', '日時', formatDateTime(t.entryAt, now), { numeric: true }),
      row('entryPrice', '価格', priceText(t.entryPrice, t.pair), { numeric: true }),
      row('lots', 'ロット', formatLots(t.lots), { numeric: true }),
      row('quantity', '数量', quantityText(t), { numeric: true }),
      row('slPrice', 'SL（損切り）', priceText(t.slPrice, t.pair), { numeric: true }),
      row('tpPrice', 'TP（利確）', priceText(t.tpPrice, t.pair), { numeric: true }),
      riskRewardRow(t),
      row('session', 'セッション', labelOf(SESSION_LABELS, t.session)),
      row('timeframe', '時間足', labelOf(TIMEFRAME_LABELS, t.timeframe), { numeric: true }),
      listRow('entryReasons', '根拠', t.entryReasons),
      row('emotion', '感情', isText(t.emotion) ? t.emotion : EMPTY),
    ],
  };
}

function exitSection(t, now, hold) {
  const rate = quoteRateRow(t);
  return {
    key: 'exit',
    header: '決済',
    // 自動計算の注記は自動計算のときだけ（手入力は業者の確定値なのでスワップ等を含みうる：design 14.4.2）
    footer: t.profitSource === 'auto' ? '自動計算はスワップ・手数料を含みません。' : null,
    rows: [
      row('exitAt', '日時', formatDateTime(t.exitAt, now), { numeric: true }),
      row('exitPrice', '価格', priceText(t.exitPrice, t.pair), { numeric: true }),
      rate,
      row('holding', '保有時間', formatDuration(hold), { numeric: true }),
      row('profitSource', '損益の算出', labelOf(PROFIT_SOURCE_LABELS, t.profitSource)),
      t.profitSource === 'manual' ? referenceProfitRow(t) : null,
      row('exitReason', '決済理由', labelOf(EXIT_REASON_LABELS, t.exitReason)),
      row('exitEmotion', '決済時の感情', isText(t.exitEmotion) ? t.exitEmotion : EMPTY),
    ].filter(Boolean),
  };
}

/** タグとメモ。メモは全文・改行を保つ。空（空白だけも含む）なら「メモなし」 */
function memoSection(t) {
  const memoEmpty = typeof t.memo !== 'string' || t.memo.trim() === '';
  return {
    key: 'memo',
    header: 'タグ・メモ',
    footer: null,
    rows: [
      listRow('tags', 'タグ', t.tags),
      { key: 'memo', kind: 'memo', label: 'メモ', value: memoEmpty ? 'メモなし' : t.memo, empty: memoEmpty, numeric: false, sub: null, items: null },
    ],
  };
}

/**
 * 詳細画面の内容を組み立てる。
 * @param {object} t 記録 1 件（IndexedDB の trades の形）
 * @param {Date} [now] 「保有中の保有時間」「今年かどうか」の基準（テストで固定できる）
 * @returns {{
 *   closed: boolean,
 *   head: object,
 *   sections: {key:string, header:string, rows:object[], footer:(string|null)}[],
 *   timestamps: string,
 *   canCancelClose: boolean
 * }}
 *   closed は一覧と同じ判定（決済価格と決済日時の両方がある）。status だけ closed で片方が欠けた記録は保有中として扱い、
 *   下部は「決済する」を出す（一覧の［決済］と同じ。そこから決済をやり直せる：roadmap 7.8 #2）
 */
export function buildDetailView(t, now = new Date()) {
  const closed = isClosedTrade(t);
  const hold = holdingMinutes(t, closed, now);
  const sections = [entrySection(t, now)];
  if (closed) sections.push(exitSection(t, now, hold));
  sections.push(memoSection(t));
  return {
    closed,
    head: buildHead(t, closed, hold),
    sections,
    timestamps: `作成 ${formatDateTime(t.createdAt, now)}・更新 ${formatDateTime(t.updatedAt, now)}`,
    // 「決済を取り消す」は決済済みだけ。「この記録を削除」は常に出す（design 14.4.5）
    canCancelClose: closed,
  };
}

/**
 * 確認シートに出す対象の要約。例「本番 USD/JPY ▲買い 10/15 21:30 の記録」（決済済みは決済日時、保有中はエントリー日時：design 14.7.4）。
 * 通貨ペアなど一部が壊れていても、分かる部分だけで文を作る。
 * @param {object} t
 * @param {Date} [now]
 */
export function describeTrade(t, now = new Date()) {
  const closed = isClosedTrade(t);
  const parts = [];
  if (t.accountType === 'real') parts.push('本番');
  if (t.accountType === 'demo') parts.push('デモ');
  if (isText(t.pair)) parts.push(t.pair);
  if (t.side === 'buy') parts.push('▲買い');
  if (t.side === 'sell') parts.push('▼売り');
  const at = closed ? t.exitAt : t.entryAt;
  if (isText(at)) parts.push(formatShortDateTime(at, now));
  return `${parts.join(' ')} の記録`;
}
