/* =========================================================
   js/format.js
   画面表示用の整形（docs/architecture.md 4.2）。

   【T-13】通貨ペアの表示桁で価格を表示する formatPrice()（fx-rules 10.7 の参照実装）。
   【T-19 で追加】円（＋2,500円 / −1,885円 / ±0円）・pips（＋25.0 pips）・ロット・日時（10/15(木) 21:30）の整形。
     記号の決まりは design.md 6.3 が正：プラスは全角の「＋」、マイナスは「−」（U+2212）、ゼロは「±0」。
     この記号は表示だけに使う。入力値・CSV・保存データには使わない（数値として読めなくなるため）。
   ・下書きなどの時刻の表示（formatDraftTime）もここにまとめた（一覧とエントリー画面で同じ書き方にするため）。

   ・ここは「基礎」の層（architecture 4.3）。画面を触らない純粋な関数だけを置く（Node.js でもテストできる）。
   ========================================================= */
import { getPairSpec } from './master.js';
import { jstParts } from './datetime.js';

/**
 * 価格を通貨ペアの表示桁数（priceDecimals）で表示する（fx-rules 10.6・10.7）。
 * 例：USD/JPY 150.1 → '150.100'、EUR/USD 1.085 → '1.08500'。
 * toFixed() は 1.005.toFixed(2) = '1.00' のように2進数の誤差で桁がずれることがあるため使わず、
 * いったんポイント（整数）にしてから、文字として小数点を差し込む。
 * 円換算レートの表示にも使う（例 formatPrice(149.85, 'USD/JPY') → '149.850'。fx-rules 6.1）。
 * @param {number} price
 * @param {string} pair 'USD/JPY' の形
 * @returns {string}
 */
export function formatPrice(price, pair) {
  const { pointScale, priceDecimals } = getPairSpec(pair);
  const pts = Math.round(price * pointScale); // 入力桁数が上限以内なら正確な整数
  const digits = String(Math.abs(pts)).padStart(priceDecimals + 1, '0'); // 0.00012 → '000012' のように整数部の0を補う
  return (pts < 0 ? '-' : '') + digits.slice(0, -priceDecimals) + '.' + digits.slice(-priceDecimals);
}

/* ---------------------------------------------------------
   損益（円）・pips・ロット（design 6.3）
   --------------------------------------------------------- */

const PLUS = '＋'; // 全角のプラス（U+FF0B）
const MINUS = '−'; // マイナス（U+2212）。ハイフン（-）より見やすい
const ZERO_SIGN = '±';

/** 整数に3桁区切りのカンマを入れる（toLocaleString は環境の言語設定に左右されるため使わない） */
function withCommas(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 符号付きの数値の「向き」：'profit'（プラス）／'loss'（マイナス）／'even'（ゼロ）。色の決定に使う（必ず記号と併用：design 5.1） */
export function toneOf(n) {
  if (n > 0) return 'profit';
  if (n < 0) return 'loss';
  return 'even';
}

/**
 * pips を 0.1pips 単位の整数にする（0から遠い方へ四捨五入。analytics 4.10 の toTenths と同じ）。
 * 小数のまま足すと誤差が積み重なるため、合計も表示もこの整数を基にする（analytics 3章ルール5）。
 * 最後の「+ 0」は -0 を 0 にするため（-0 だと「−0.0」と出てしまう）。
 */
export function toTenths(pips) {
  return Math.sign(pips) * Math.round(Math.abs(pips) * 10) + 0;
}

/**
 * 損益（円）の表示。例：2500 → '＋2,500円'、-1885 → '−1,885円'、0 → '±0円'。
 * 値がない（保有中・計算できなかった）ときは '—'。
 * @param {number|null|undefined} yen
 * @returns {string}
 */
export function formatYen(yen) {
  if (yen == null || !Number.isFinite(yen)) return '—';
  const n = Math.round(yen) + 0; // 円は整数。-0 は 0 にする
  if (n === 0) return `${ZERO_SIGN}0円`;
  return `${n > 0 ? PLUS : MINUS}${withCommas(Math.abs(n))}円`;
}

/**
 * 0.1pips 単位の整数（toTenths の結果）を pips の表示にする。例：257 → '＋25.7 pips'、0 → '±0.0 pips'。
 * 合計の表示（合計は整数のまま足して、最後にここで小数にする）で使う。
 * @param {number|null|undefined} tenths
 * @returns {string}
 */
export function formatPipsTenths(tenths) {
  if (tenths == null || !Number.isFinite(tenths)) return '—';
  if (tenths === 0) return `${ZERO_SIGN}0.0 pips`;
  const abs = Math.abs(tenths);
  return `${tenths > 0 ? PLUS : MINUS}${withCommas(Math.floor(abs / 10))}.${abs % 10} pips`;
}

/**
 * pips の表示。例：25 → '＋25.0 pips'、-37.7 → '−37.7 pips'、0.04 → '±0.0 pips'。値がなければ '—'。
 * @param {number|null|undefined} pips
 * @returns {string}
 */
export function formatPips(pips) {
  if (pips == null || !Number.isFinite(pips)) return '—';
  return formatPipsTenths(toTenths(pips));
}

/**
 * ロットの表示（余計な0を付けない）。例：0.5 → '0.5lot'、1 → '1lot'、0.07 → '0.07lot'。値がなければ '—'。
 * 0.1+0.2 のような誤差（0.30000000000000004）が見えないよう、小数第6位で丸めてから末尾の0を取る。
 * @param {number|null|undefined} lots
 * @returns {string}
 */
export function formatLots(lots) {
  if (lots == null || !Number.isFinite(lots)) return '—';
  const text = lots.toFixed(6).replace(/\.?0+$/, '');
  return `${text}lot`;
}

/* ---------------------------------------------------------
   日時（日本時間。design 6.3）
   ---------------------------------------------------------- */

const WEEKDAYS = '日月火水木金土';
const pad2 = (n) => String(n).padStart(2, '0');

/** 日本時間の「今日」と同じ日か */
function isSameDay(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/**
 * 時刻だけ。例：'10:30'、'09:05'。日付見出しの下の行（決済時刻）に使う。読めない日時は '—'。
 * @param {Date|string} value Date または保存形式の日時の文字
 */
export function formatTime(value) {
  const p = jstParts(value);
  return p ? `${pad2(p.hour)}:${pad2(p.minute)}` : '—';
}

/**
 * 月日(曜) 時:分。例：'10/15(木) 11:30'。今年以外は年も付ける：'2025/12/30(火) 09:00'。保有中のエントリー日時に使う。
 * @param {Date|string} value
 * @param {Date} [now] 「今年」の判定に使う今（テストで固定できる）
 */
export function formatDateTime(value, now = new Date()) {
  const p = jstParts(value);
  if (!p) return '—';
  const today = jstParts(now);
  const date = today && today.year === p.year ? `${p.month}/${p.day}` : `${p.year}/${p.month}/${p.day}`;
  return `${date}(${WEEKDAYS[p.weekday]}) ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/**
 * 日付の見出し。例：'10月15日（木）'。今年以外は年も付ける：'2025年12月30日（火）'（analytics 4.6）。
 * @param {Date|string} value
 * @param {Date} [now]
 */
export function formatDateHeading(value, now = new Date()) {
  const p = jstParts(value);
  if (!p) return '—';
  const today = jstParts(now);
  const year = today && today.year === p.year ? '' : `${p.year}年`;
  return `${year}${p.month}月${p.day}日（${WEEKDAYS[p.weekday]}）`;
}

/**
 * 下書きの最終更新の表示。今日なら時刻だけ（'21:32'）、今日でなければ '10/14 21:32'（design 14.1.10・14.3.8）。
 * @param {Date|string} value
 * @param {Date} [now]
 */
export function formatDraftTime(value, now = new Date()) {
  const p = jstParts(value);
  if (!p) return '';
  const today = jstParts(now);
  const time = `${pad2(p.hour)}:${pad2(p.minute)}`;
  return today && isSameDay(today, p) ? time : `${p.month}/${p.day} ${time}`;
}

/* ---------------------------------------------------------
   読み上げ用の言い方（design 14.3.4：記号「▲」「＋」をそのまま読ませない）
   --------------------------------------------------------- */

/** 読み上げ用の損益（円）。例：'プラス2,500円'、'マイナス1,885円'、'0円'、値がなければ '未確定' */
export function speakYen(yen) {
  if (yen == null || !Number.isFinite(yen)) return '未確定';
  const n = Math.round(yen) + 0;
  if (n === 0) return '0円';
  return `${n > 0 ? 'プラス' : 'マイナス'}${withCommas(Math.abs(n))}円`;
}

/** 読み上げ用の pips。例：'プラス25.0 pips'、'マイナス37.7 pips'、'0.0 pips' */
export function speakPips(pips) {
  if (pips == null || !Number.isFinite(pips)) return '未確定';
  const tenths = toTenths(pips);
  const abs = Math.abs(tenths);
  const body = `${Math.floor(abs / 10)}.${abs % 10} pips`;
  if (tenths === 0) return body;
  return `${tenths > 0 ? 'プラス' : 'マイナス'}${body}`;
}

/** 読み上げ用の日時。例：'10月15日 10時30分'（今年以外は '2025年12月30日 9時0分'） */
export function speakDateTime(value, now = new Date()) {
  const p = jstParts(value);
  if (!p) return '';
  const today = jstParts(now);
  const year = today && today.year === p.year ? '' : `${p.year}年`;
  return `${year}${p.month}月${p.day}日 ${p.hour}時${p.minute}分`;
}
