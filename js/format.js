/* =========================================================
   js/format.js
   画面表示用の整形（docs/architecture.md 4.2）。

   【T-13 の段階】通貨ペアの表示桁で価格を表示する formatPrice()（fx-rules 10.7 の参照実装）だけ。
   円（＋2,500円 / −1,885円 / ±0円）・pips（＋25.0 pips）・日時（10/15(木) 21:30）の整形は
   T-19 でこのファイルに追加する（記号の決まりは design.md 6.3 が正：マイナスは「−」U+2212、ゼロは「±0」）。

   ・ここは「基礎」の層（architecture 4.3）。画面を触らない純粋な関数だけを置く。
   ========================================================= */
import { getPairSpec } from './master.js';

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
