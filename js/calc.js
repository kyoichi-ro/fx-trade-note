/* =========================================================
   js/calc.js
   FXの計算（docs/fx-rules.md 6.4・7章・11.7 の参照実装、docs/architecture.md 13.1）。
     ・pips            calcPips(t)        → { diffPoints, pips }（必要な値が空なら両方 null）
     ・損益（円）       calcProfitJpy(t)   → 整数の円 または null（非JPYペアで円換算レートなし／必要な値が空）
     ・リスクリワード   calcRiskReward(t)  → { rr, warn }
     ・セッション判定   judgeSession(entryAt) → 'tokyo' | 'london' | 'newyork' | 'other' | null
     ・勝敗判定         judgeResult(trade) → 'win' | 'loss' | 'draw' | null（判定対象外）

   【方針】
   ・fx-rules の参照実装を「そのまま写す」（architecture 13.1）。関数名・引数・戻り値の形も同じ。
     参照実装と変えたのは次の2点だけ（どちらも 9章のテストケースの結果は変わらない）：
       1. export を付けて他のファイルから使えるようにした
       2. isJpyPair(pair) / pointScale(pair) の代わりに master.js の getPairSpec(pair) を使う
   ・画面（document）も IndexedDB も触らない純粋な関数だけ（architecture 4.3）。
     Node.js でもブラウザでも同じ結果になり、tests/ で両方からテストできる。

   【必要な値が空のとき（2026-10-16 オーナー決定：fx-rules v1.5 の 4.5・6.4・14.2 #5、11.7 手順0）】
   ・「空」＝ null・undefined（未入力）。fx-rules 6.4 の参照実装の isBlank（v == null）と同じ判定にした。
   ・calcPips は必要な値（通貨ペア・売買方向・エントリー価格・決済価格）が空なら { diffPoints: null, pips: null }。
     形を変えずに中身を空にするので、画面側は calcPips(t).pips をそのまま読める（null なら「—」表示など）。
   ・calcProfitJpy は、それに加えてロット・1lotの通貨数が空なら null（非JPYペアの円換算レートが空なら null は従来どおり）。
   ・以前は「決済価格が空だと pips −15000」「ロットが空だと損益 0円」「1lotの通貨数が空だと例外で停止」だった
     （テスト C-18〜C-20）。保有中の記録や入力途中の画面で呼んでも安全にするため。
   ・judgeSession は entryAt が null・undefined なら null（以前は new Date(null) が1970年として読めて 'tokyo'。テスト Z-23）。
   ・値がそろっているときの計算結果は以前とまったく同じ（fx-rules 9章・14.1 のテストケースで確認）。
   ・画面から渡す値は validate.js で数値（または空なら null）にしてから渡す約束（空文字 '' のまま渡さない）。

   【誤差対策のまとめ（fx-rules 6.3）】
   ・価格は「ポイント（0.1pip）＝整数」に直してから差を取る（小数の引き算は 0.000299999… のようにずれるため）
   ・損益は整数どうしを掛けて、最後に1回だけ割って四捨五入する（途中で丸めると 0.5円ちょうどで1円ずれる）
   ・損益の掛け算は BigInt（大きな数量だと通常の数値で正確に扱える上限 約9×10^15 を超えるため）
   ・「四捨五入」はすべて「0から遠い方へ」（Math.round(-1.5) は -1 になるのでマイナスに使わない）
   ========================================================= */
import { getPairSpec } from './master.js';

/**
 * 価格 → ポイント（整数）。ポイント＝0.1pip（JPYペア 0.001、非JPYペア 0.00001）。
 * 入力桁数が上限以内（validate.js でチェック済み）なら、価格×倍率はほぼ整数になる。
 * Math.round は、掛け算で出たごく小さな誤差（150.123×1000 = 150122.99999999997 など）を消すため。
 * ※ 価格はプラスの値だけなので、ここでの Math.round はマイナスの四捨五入の問題に当たらない。
 */
export function toPoints(price, pair) {
  return Math.round(price * getPairSpec(pair).pointScale);
}

/**
 * ロット → 100倍した整数（例 0.07lot → 7）。ロットは小数第2位まで（E-06）なので正確な整数になる。
 * 0.07 × 100 は JavaScript では 7.000000000000001 になるため、四捨五入して 7 にする（fx-rules 4.1）。
 */
export function toLotsX100(lots) {
  return Math.round(lots * 100);
}

/**
 * 未入力（null・undefined）かどうか（fx-rules 6.4 の参照実装の isBlank と同じ。v1.5 で追加）。
 * Number(null) は 0 になってしまい、「決済価格 0」として計算が進んで −15000 pips のような値が出るのを防ぐ。
 */
const isBlank = (v) => v == null;

/**
 * pips（小数第1位）。fx-rules 3.3・6.4。
 * 必要な値（pair・side・entryPrice・exitPrice）のどれかが空なら { diffPoints: null, pips: null }（fx-rules 4.5）。
 * @param {{pair:string, side:'buy'|'sell', entryPrice:number, exitPrice:number}} t
 * @returns {{diffPoints:(number|null), pips:(number|null)}} diffPoints は値幅のポイント（整数・プラス＝利益）
 */
export function calcPips(t) {
  // 保有中（決済価格なし）や入力途中でも安全に呼べるよう、形を保ったまま中身を空にする
  if ([t.pair, t.side, t.entryPrice, t.exitPrice].some(isBlank)) return { diffPoints: null, pips: null };
  const e = toPoints(t.entryPrice, t.pair);
  const x = toPoints(t.exitPrice, t.pair);
  // 買いは「後で売る」ので上がれば利益、売りは「後で買い戻す」ので下がれば利益（fx-rules 3.2）
  const diffPoints = t.side === 'buy' ? x - e : e - x;
  // 整数 ÷ 10 なので、結果は必ず小数第1位までのきれいな値になる（丸め不要）。
  // diffPoints が 0 のとき 0 / 10 は +0（-0 にはならない）
  return { diffPoints, pips: diffPoints / 10 };
}

/**
 * 取引数量（通貨数）= lots × lotUnitSize（fx-rules 4.1）。詳細画面の「数量」に使う。
 * 0.07 × 10000 を直接掛けると 700.0000000000001 になるため、ロットを100倍した整数（toLotsX100）で掛けてから100で割る。
 * lotUnitSize は「記録時の1lot」（requirements 6.1）。どちらかが空・数値でないときは null。
 * @param {number|null|undefined} lots
 * @param {number|null|undefined} lotUnitSize
 * @returns {number|null}
 */
export function calcQuantity(lots, lotUnitSize) {
  if (isBlank(lots) || isBlank(lotUnitSize) || !Number.isFinite(lots) || !Number.isFinite(lotUnitSize)) return null;
  return (toLotsX100(lots) * lotUnitSize) / 100;
}

/**
 * BigInt の割り算を「0から遠い方へ四捨五入」する（fx-rules 6.2・6.4）。
 * 例：15 / 10 → 2、-15 / 10 → -2、14 / 10 → 1。
 * @param {bigint} num 割られる数
 * @param {bigint} den 割る数（プラスであること）
 * @returns {number}
 */
export function divRoundHalfAwayFromZero(num, den) {
  const neg = num < 0n;
  const a = neg ? -num : num;
  // 絶対値で (a + den/2) / den を切り捨て → 四捨五入。2倍して整数のまま計算する（BigInt の割り算は切り捨て）
  const q = (2n * a + den) / (2n * den);
  return Number(neg ? -q : q); // BigInt に -0 はないので、0 は必ず 0 になる（「-0円」表示を防ぐ）
}

/**
 * 損益（円・整数）。fx-rules 4.2・4.3・6.4。
 *   JPYペア ：四捨五入( diffPoints × lotsX100 × lotUnitSize ÷ (pointScale × 100) )
 *   非JPYペア：四捨五入( diffPoints × lotsX100 × lotUnitSize × rateX1000 ÷ (pointScale × 100 × 1000) )
 * 非JPYペアで円換算レート（quoteToJpyRate）が無いときは null（自動計算できない＝手入力が必要。E-11）。
 * 必要な値（pips の4つ・lots・lotUnitSize）のどれかが空のときも null（fx-rules 4.5）。
 * スワップ・手数料は含めない（fx-rules 2章）。
 * @param {{pair:string, side:'buy'|'sell', entryPrice:number, exitPrice:number, lots:number,
 *   lotUnitSize:number, quoteToJpyRate?:(number|null)}} t
 * @returns {number|null}
 */
export function calcProfitJpy(t) {
  const { diffPoints } = calcPips(t);
  // ロットが空のとき「0円」（引き分けに見える）、1lotの通貨数が空のとき BigInt(null) の例外で止まるのを防ぐ
  if (diffPoints == null || isBlank(t.lots) || isBlank(t.lotUnitSize)) return null;
  const spec = getPairSpec(t.pair);
  const lotsX100 = toLotsX100(t.lots);
  // 掛け算は BigInt で行う（C-16 のように途中の値が約1.5×10^18 になり、通常の数値では端数が狂うため）
  let num = BigInt(diffPoints) * BigInt(lotsX100) * BigInt(t.lotUnitSize);
  // 参照実装では JPYペア 1000n × 100n、非JPYペア 100000n × 100n × 1000n と書かれている。
  // getPairSpec の pointScale（JPY 1,000 / 非JPY 100,000）を使えば同じ値になり、
  // 将来 PIP_EXCEPTIONS で倍率の違うペアを足しても「ポイント→価格」の換算がずれない。
  let den = BigInt(spec.pointScale) * 100n;
  if (!spec.isJpyPair) {
    // 空欄は「損益を手入力する」意味なので自動計算しない（E-11）
    if (t.quoteToJpyRate == null) return null;
    // 円換算レートは小数第3位まで（E-08）なので ×1000 で正確な整数になる
    num *= BigInt(Math.round(t.quoteToJpyRate * 1000));
    den *= 1000n;
  }
  return divRoundHalfAwayFromZero(num, den);
}

/**
 * リスクリワード（小数第2位）。fx-rules 5章・6.4。
 * SL・TP の両方があるときだけ計算する（どちらかが空なら rr = null、警告なし）。
 * SL/TP が売買方向と矛盾する（損切り幅または利確幅が0以下）ときは rr = null と警告対象（'SL' / 'TP'）を返す。
 * 警告（W-01）は保存を止めない。建値ストップなど意図的なこともあるため（fx-rules 5.2）。
 * @param {{pair:string, side:'buy'|'sell', entryPrice:number, slPrice?:(number|null), tpPrice?:(number|null)}} t
 * @returns {{rr:(number|null), warn:string[]}}
 */
export function calcRiskReward(t) {
  if (t.slPrice == null || t.tpPrice == null) return { rr: null, warn: [] };
  const e = toPoints(t.entryPrice, t.pair);
  const sl = toPoints(t.slPrice, t.pair);
  const tp = toPoints(t.tpPrice, t.pair);
  const risk = t.side === 'buy' ? e - sl : sl - e;
  const reward = t.side === 'buy' ? tp - e : e - tp;
  const warn = [];
  if (risk <= 0) warn.push('SL');
  if (reward <= 0) warn.push('TP');
  // 損切り幅が0以下だと「リスクに対するリワード」の比率が成り立たない（0で割る事故も防ぐ）
  if (warn.length) return { rr: null, warn };
  // 整数演算で四捨五入：floor((200×reward + risk) / (2×risk)) / 100
  // Math.round(x * 100) / 100 だと 0.625 が 0.62 になることがあるため使わない（R-04・R-05）
  return { rr: Math.floor((200 * reward + risk) / (2 * risk)) / 100, warn };
}

/* ---------------------------------------------------------
   セッション判定（fx-rules 11章）
   各市場の始まりを「その市場の現地時刻」で決める。ブラウザ内蔵のタイムゾーンデータ（Intl）で
   NY・ロンドンの現地時刻を求めるので、夏時間の切り替え（米欧で日がずれる期間を含む）が自動で反映される。
   端末のタイムゾーン設定に関係なく同じ結果になる（海外で記録しても日本時間基準）。
   --------------------------------------------------------- */

// Intl.DateTimeFormat は作るのが重いので、タイムゾーンごとに1つ作って使い回す
const tzFormatters = {};

/** 指定したタイムゾーンでの曜日（0=日〜6=土）と、0時からの経過分を返す（秒は切り捨て） */
function localParts(date, timeZone) {
  const f = tzFormatters[timeZone] || (tzFormatters[timeZone] = new Intl.DateTimeFormat('en-US', {
    // hourCycle 'h23'：hour12:false だと一部の環境で0時が「24」になるため（fx-rules 11.7）
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }));
  const p = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = value;
  return {
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
    min: Number(p.hour) * 60 + Number(p.minute), // 秒は切り捨て
  };
}

/**
 * セッション判定（fx-rules 11.7 の判定手順 0〜5）。
 * 重なる時間帯は「あとから始まる市場」を優先（ロンドン×NY → newyork、東京×ロンドン → london。11.5）。
 * 東京は日本時間 9:00〜ロンドンの始まり、早朝と週末は other。祝日は考慮しない。
 * @param {string|Date} entryAt 例 '2026-10-15T21:30:00+09:00'（Z など別の表記でも同じ瞬間なら同じ結果）
 * @returns {'tokyo'|'london'|'newyork'|'other'|null} 日時として読めないときは null（保存は止めない）
 */
export function judgeSession(entryAt) {
  // 0. 空なら null（fx-rules 11.7 手順0・14.1 修正依頼 #1）。
  //    new Date(null) は「1970-01-01 09:00（日本時間）」として読めてしまい、以前は 'tokyo' を返していた。
  //    空文字 '' は new Date('') が「読めない日時」になるので、下の判定でも null になる（同じ結果）
  if (entryAt == null) return null;
  const d = entryAt instanceof Date ? entryAt : new Date(entryAt);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const H = (h) => h * 60;
    const ny = localParts(d, 'America/New_York');
    const ldn = localParts(d, 'Europe/London');
    const jp = localParts(d, 'Asia/Tokyo');
    // 1. 週末：NY時刻の金曜17:00〜日曜17:00は市場休止
    if ((ny.wd === 5 && ny.min >= H(17)) || ny.wd === 6 || (ny.wd === 0 && ny.min < H(17))) return 'other';
    // 2. NY：NY時刻 8:00〜17:00
    if (ny.min >= H(8) && ny.min < H(17)) return 'newyork';
    // 3. ロンドン：ロンドン時刻 8:00〜（NYの始まりまで）
    if (ldn.min >= H(8) && ny.min < H(8)) return 'london';
    // 4. 東京：日本時刻 9:00〜（ロンドンの始まりまで）
    if (jp.min >= H(9) && ldn.min < H(8)) return 'tokyo';
    // 5. それ以外（平日の早朝）
    return 'other';
  } catch (e) {
    // 万一タイムゾーン機能で例外が出ても、保存を止めないよう「未設定」にする（fx-rules 11.7）
    return null;
  }
}

/* ---------------------------------------------------------
   勝ち／負け／引き分けの判定（fx-rules 7章）
   --------------------------------------------------------- */

/**
 * 勝敗判定。判定の基準は保存されている損益（円）profitJpy（手入力の値も含む）で、pips ではない。
 * 決済理由が「建値決済」でも損益で判定する。判定結果は保存せず、表示・集計のたびにこの関数で求める。
 * analytics.md 4.10 の outcomeOf と同じ結果（一覧の filter.js もこの関数を使い、二重に書かない）。
 * @param {{status:string, profitJpy:(number|null), deletedAt:(string|null)}} trade
 * @returns {'win'|'loss'|'draw'|null} null は判定対象外（保有中・論理削除済み・損益なし）
 */
export function judgeResult(trade) {
  if (trade.status !== 'closed' || trade.deletedAt || trade.profitJpy == null) return null;
  if (trade.profitJpy > 0) return 'win';
  if (trade.profitJpy < 0) return 'loss';
  return 'draw'; // 損益0円は引き分け
}
