/* =========================================================
   js/validate.js
   入力値の正規化とチェック（docs/fx-rules.md 8章・10.4・10.5、docs/architecture.md 4.2・13.1）。

   ・ここは「基礎」の層（architecture 4.3）。画面も IndexedDB も触らない純粋な関数だけを置く。
   ・返すのはエラー／警告の「コード」（'E-02'、'W-06' など）だけ。画面に出す文言は design.md 14.1.8・14.2.9・
     14.6.2〜14.6.4 が正なので、各画面（T-16〜T-21）がコードから文言を選ぶ。
   ・エラー（E-xx）＝保存させない入力ミス。警告（W-xx）＝注意を出すが保存はできる（fx-rules 1章）。
   ・必須項目の未入力チェックは requirements 5.2 の担当なので、ここでは「空欄」を
     { ok: true, value: null, empty: true } として返し、必須かどうかは呼び出し側（画面）が判断する。
   ・W-01（SL/TP が売買方向と矛盾）は calc.js の calcRiskReward() が warn として返す（二重に書かない）。

   【戻り値の約束】
     読み取り系 parseXxx(input)  … { ok: true, value } または { ok: false, error: 'E-xx' }
     警告系     isXxx(...)        … true（警告を出す）／ false
   ========================================================= */
import { PAIR_MASTER, KNOWN_CURRENCIES, NON_FX_CODES, getPairSpec } from './master.js';
import { toPoints, toLotsX100 } from './calc.js';

/* ---------------------------------------------------------
   入力文字の正規化（fx-rules 8.1）
   --------------------------------------------------------- */

/** 全角数字・全角ピリオドを半角にする対応表を使わず、文字コードの差（0xFEE0）で変換する */
function toHalfWidthDigits(s) {
  return s.replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

/**
 * 数値入力の文字を正規化する（fx-rules 8.1）。
 * ・前後の空白を取り除く（全角スペースも String.prototype.trim で取れる）
 * ・全角数字・全角ピリオド（１５０．２５）を半角に
 * ・profit: true（損益（円）の手入力）のときだけ、さらに次を行う（2026-10-16 オーナー決定：fx-rules v1.5 の 8.1・14.2 #6）
 *     - カンマ（半角「,」・全角「，」）を取り除く   例「－５，７００」「+2,480」
 *     - 全角のマイナス（− U+2212・－ U+FF0D）を「-」に
 *     - 先頭の「+」「＋」を1つだけ取り除く（業者アプリの表示「+2,480」をそのまま写せるように）。
 *       直後が数字のときだけ取り除くので、「+-5」「++5」「+」（符号だけ）は E-09 のまま（8.1）
 * 価格・ロットなど損益以外の欄では「+」もカンマも受け付けない（8.1：「+150.25」は E-01、「10,000」は E-07）。
 * それ以外の文字（価格のカンマ「150,25」、指数表記「1e2」など）は残すので、後の書式チェックでエラーになる。
 * @param {string} input
 * @param {{profit?:boolean}} [opts]
 */
export function normalizeNumberText(input, { profit = false } = {}) {
  let s = toHalfWidthDigits(String(input ?? '').trim());
  if (profit) {
    s = s.replace(/[,，]/g, '').replace(/[−－]/g, '-').replace(/^[+＋](?=\d)/, '');
  }
  return s;
}

/**
 * 「数値として読める」文字の形。半角の数字・小数点1つ・先頭のマイナスだけを認める。
 * Number('1e2') や Number('0x10') は数値になってしまうため、Number() に頼らず文字の形で判定する。
 * 「.5」「150.」も数字だけでできているので受け付ける（iPhone の小数点キーで打ちやすい形のため）。
 */
const NUMBER_PATTERN = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * 小数部の桁数を「入力文字列のまま」数える（fx-rules 6.3 ルール7・8.1）。
 * 数値にすると 1.10 → 1.1 になり元の桁数が分からなくなるため、文字列で数える。末尾の0は数えない（150.1200 → 2）。
 */
export function countDecimals(text) {
  const dot = text.indexOf('.');
  if (dot < 0) return 0;
  return text.slice(dot + 1).replace(/0+$/, '').length;
}

/** 正規化済みの文字を数値に。読めなければ null。-0 は 0 にする（「-0」表示を防ぐ） */
function toNumberOrNull(text) {
  if (!NUMBER_PATTERN.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return n === 0 ? 0 : n;
}

/* ---------------------------------------------------------
   エラーのチェック（fx-rules 8.2）
   --------------------------------------------------------- */

/**
 * 価格の上限（これ以上はエラー E-17。T-33：T-30 の R-01）。FX の通貨ペアの価格は大きくても数万程度なので、
 * 1,000,000 未満なら現実の価格を止めることはない。上限がないと、桁を貼り間違えた巨大な値（1e306 など）が
 * 保存されて、決済・編集の画面の計算が例外で止まったり、無意味な pips になったりしたため。
 */
export const PRICE_MAX_EXCLUSIVE = 1_000_000;

/**
 * ロットの上限（これを超えるとエラー E-18。T-33：R-01）。
 * 1lot＝1通貨の業者では、1万通貨の取引でロットが 10,000 になるので、上限は 10,000,000（1000万）にして実際の取引を弾かない
 * （T-33 再確認・fx-expert）。この上限でもロット×100 は 10億で安全な整数の範囲に収まる
 */
export const LOTS_MAX = 10_000_000;

/**
 * 価格（エントリー・決済・SL・TP）を読み取る。E-01〜E-04・E-17。
 * チェックの順：数値として読めない（E-01）→ 0以下（E-02）→ 1,000,000 以上（E-17）→ 小数桁が上限を超える（JPY E-03／非JPY E-04）。
 * 桁の上限は通貨ペアマスタの maxInputDecimals（JPYペア 3、非JPYペア 5）。
 * @param {string} input 入力欄の文字
 * @param {string} pair 'USD/JPY' の形
 */
export function parsePrice(input, pair) {
  const text = normalizeNumberText(input);
  if (text === '') return { ok: true, value: null, empty: true };
  const value = toNumberOrNull(text);
  if (value === null) return { ok: false, error: 'E-01' };
  if (value <= 0) return { ok: false, error: 'E-02' };
  if (value >= PRICE_MAX_EXCLUSIVE) return { ok: false, error: 'E-17' };
  const spec = getPairSpec(pair);
  if (countDecimals(text) > spec.maxInputDecimals) return { ok: false, error: spec.isJpyPair ? 'E-03' : 'E-04' };
  return { ok: true, value };
}

/**
 * ロットを読み取る。E-05（数値でない／0以下）、E-18（10,000,000 を超える：T-33 R-01）、E-06（小数第3位以下まである）。
 * ロットの最小単位は業者により異なるため「小数第2位まで」とだけ制限する（fx-rules 8.2）。
 */
export function parseLots(input) {
  const text = normalizeNumberText(input);
  if (text === '') return { ok: true, value: null, empty: true };
  const value = toNumberOrNull(text);
  if (value === null || value <= 0) return { ok: false, error: 'E-05' };
  if (value > LOTS_MAX) return { ok: false, error: 'E-18' };
  if (countDecimals(text) > 2) return { ok: false, error: 'E-06' };
  return { ok: true, value };
}

/**
 * 1lotの通貨数（設定画面）を読み取る。E-07（1以上の整数でない）。
 * 末尾の0だけの小数（10000.0）は整数として受け付ける（桁は末尾の0を数えない約束：fx-rules 8.1）。
 * カンマは損益（円）の手入力以外では受け付けない約束（fx-rules 8.1）なので「10,000」は E-07。
 */
export function parseLotUnitSize(input) {
  const text = normalizeNumberText(input);
  if (text === '') return { ok: true, value: null, empty: true };
  const value = toNumberOrNull(text);
  if (value === null || countDecimals(text) > 0 || value < 1 || !Number.isSafeInteger(value)) {
    return { ok: false, error: 'E-07' };
  }
  return { ok: true, value };
}

/**
 * 円換算レートの上限（これ以上は E-08。T-44 レビュー CI-R04・fx-expert）。価格の上限 E-17 と同じ 1,000,000 未満。
 * 円換算レート（決済通貨/JPY）は現実には数百程度。上限がないと 1e21 以上の値が保存でき、CSV に「1e+21」と書き出されて読み戻せなかった
 */
export const QUOTE_RATE_MAX_EXCLUSIVE = 1_000_000;

/**
 * 円換算レート（非JPYペアの決済時）を読み取る。E-08（数値でない／0以下／1,000,000以上／小数第4位以下まである）。
 * 空欄は「自動計算しない（損益を手入力する）」という意味なので value: null で通す（空欄どうしの E-11 は別関数）。
 */
export function parseQuoteToJpyRate(input) {
  const text = normalizeNumberText(input);
  if (text === '') return { ok: true, value: null, empty: true };
  const value = toNumberOrNull(text);
  if (value === null || value <= 0 || value >= QUOTE_RATE_MAX_EXCLUSIVE || countDecimals(text) > 3) return { ok: false, error: 'E-08' };
  return { ok: true, value };
}

/**
 * 損益（円）の手入力を読み取る。E-09（整数でない）。
 * カンマ（-5,700・全角の「，」）と全角マイナス・全角数字・先頭の「+」「＋」は直して受け付ける
 * （fx-rules 4.4・8.1、2026-10-16 決定 14.2 #6。例「+2,480」→ 2480、「－５，７００」→ −5700）。マイナス・0 も可。
 * 小数は（末尾が0だけでも「1234.0」）エラー：円未満を入れる欄ではないことをはっきりさせるため。
 */
export function parseManualProfitJpy(input) {
  const text = normalizeNumberText(input, { profit: true });
  if (text === '') return { ok: true, value: null, empty: true };
  if (!/^-?\d+$/.test(text)) return { ok: false, error: 'E-09' };
  const n = Number(text);
  if (!Number.isSafeInteger(n)) return { ok: false, error: 'E-09' };
  return { ok: true, value: n === 0 ? 0 : n }; // 「-0」は 0 にする
}

/**
 * 決済日時がエントリー日時より前でないか。E-10。同じ時刻は OK。
 * 日時はタイムゾーン付きの文字列（architecture 6.6 の形式）で受け取り、瞬間（ミリ秒）に直して比べる。
 * @returns {{ok:true}|{ok:false, error:'E-10'}}
 */
export function checkExitAfterEntry(entryAt, exitAt) {
  const e = Date.parse(entryAt);
  const x = Date.parse(exitAt);
  if (!Number.isNaN(e) && !Number.isNaN(x) && x < e) return { ok: false, error: 'E-10' };
  return { ok: true };
}

/**
 * 決済を保存できるか（非JPYペア）。E-11：円換算レートも損益（円）の手入力も空。
 * 非JPYペアは円換算レートが無いと損益を自動計算できないため、どちらかが必要（fx-rules 4.3）。
 * @param {{pair:string, quoteToJpyRate:(number|null), manualProfitJpy:(number|null)}} p
 */
export function checkCloseInputs({ pair, quoteToJpyRate, manualProfitJpy }) {
  if (!getPairSpec(pair).isJpyPair && quoteToJpyRate == null && manualProfitJpy == null) {
    return { ok: false, error: 'E-11' };
  }
  return { ok: true };
}

/* ---------------------------------------------------------
   警告のチェック（fx-rules 8.3。保存は止めない）
   比較はすべてポイント（整数）や整数どうしで行い、小数の誤差で判定がぶれないようにする（fx-rules 6.3 ルール5）。
   --------------------------------------------------------- */

/**
 * 2つの価格の差が、基準価格の10%以上か（|差のポイント| × 10 ≧ 基準のポイント）。
 * W-02（エントリーと決済）・W-03（エントリーと SL/TP）の共通部分。
 */
function isGapTenPercentOrMore(basePrice, otherPrice, pair) {
  const b = toPoints(basePrice, pair);
  const o = toPoints(otherPrice, pair);
  return Math.abs(o - b) * 10 >= b;
}

/** W-02：エントリー価格と決済価格の差がエントリー価格の10%以上（150.12 を 15.012 と打った、など） */
export function isLargePriceGap(entryPrice, exitPrice, pair) {
  return isGapTenPercentOrMore(entryPrice, exitPrice, pair);
}

/** W-03：エントリー価格と SL または TP の差がエントリー価格の10%以上（SL・TP それぞれについて呼ぶ） */
export function isFarFromEntry(entryPrice, slOrTpPrice, pair) {
  return isGapTenPercentOrMore(entryPrice, slOrTpPrice, pair);
}

/**
 * W-04：取引数量（lots × lotUnitSize）が1,000万通貨超。
 * lots を100倍の整数にして「lotsX100 × lotUnitSize > 1,000万 × 100」で比べる（小数の掛け算の誤差を避ける）。
 * 大きな値でも桁あふれしないよう BigInt で掛ける。
 */
export function isLargeQuantity(lots, lotUnitSize) {
  const lotsX100 = toLotsX100(lots);
  // 安全な整数でない（巨大・Infinity）ときは BigInt が例外を出すので、計算せずに「大きすぎる」とする（T-33 R-01：画面を止めない）
  if (!Number.isSafeInteger(lotsX100) || !Number.isSafeInteger(lotUnitSize)) return true;
  return BigInt(lotsX100) * BigInt(lotUnitSize) > 10_000_000n * 100n;
}

/**
 * W-05：手入力した損益（円）と pips の符号が逆（+0.5pips なのに −30円、など）。
 * どちらかが0のときは「逆」ではないので警告しない。スワップ・手数料の影響ならそのまま保存してよい。
 */
export function isSignMismatch(pips, profitJpy) {
  if (pips == null || profitJpy == null) return false;
  return (pips > 0 && profitJpy < 0) || (pips < 0 && profitJpy > 0);
}

/**
 * W-06：価格が通貨ペアごとの価格帯の目安から外れているか（fx-rules 10.5・10.7 の参照実装。2026-10-15 採用）。
 * 境界ちょうど（warnMin・warnMax）は範囲内。マスタにないペアと TRY/JPY はチェックしない。
 */
export function isOutOfPriceRange(price, pair) {
  const { warnMin, warnMax } = getPairSpec(pair);
  if (warnMin == null || warnMax == null) return false;
  return price < warnMin || price > warnMax;
}

/* ---------------------------------------------------------
   通貨ペアの追加（fx-rules 10.4。E-12〜E-16・W-07）
   --------------------------------------------------------- */

/**
 * 通貨ペアの追加入力を正規化してチェックする（fx-rules 10.7 の参照実装と同じ結果）。
 * 手順1：全角→半角（NFKC）、小文字→大文字、空白除去、区切りは「/」「-」「_」「なし」を「/」にそろえる。
 * 手順2：上から順に判定し、最初に当てはまったもので止める（E-12 → E-13 → E-14 → E-15 → E-16 → W-07）。
 * @param {string} input 入力された文字
 * @param {string[]} favoritePairs 現在の「よく使う通貨ペア」（E-16 の判定用）
 * @returns {{ok:false, error:string, pair?:string} | {ok:true, pair:string, warn:string[], spec:object}}
 */
export function normalizePairInput(input, favoritePairs) {
  const s = String(input).normalize('NFKC').toUpperCase().replace(/\s+/g, '');
  const m = s.match(/^([A-Z]{3})[\/\-_]?([A-Z]{3})$/);
  if (!m) return { ok: false, error: 'E-12' };
  const [, base, quote] = m;
  const pair = `${base}/${quote}`;
  if (NON_FX_CODES.includes(base) || NON_FX_CODES.includes(quote)) return { ok: false, pair, error: 'E-13' };
  if (base === quote) return { ok: false, pair, error: 'E-14' };
  if (base === 'JPY') return { ok: false, pair, error: 'E-15' };
  if (favoritePairs.includes(pair)) return { ok: false, pair, error: 'E-16' };
  const inMaster = PAIR_MASTER.some((p) => p.pair === pair);
  // マスタにないペアで、確認済みでない通貨を含むときは「pips が業者の表示と違うかもしれない」と知らせる
  const warn = !inMaster && !(KNOWN_CURRENCIES.includes(base) && KNOWN_CURRENCIES.includes(quote)) ? ['W-07'] : [];
  return { ok: true, pair, warn, spec: getPairSpec(pair) };
}
