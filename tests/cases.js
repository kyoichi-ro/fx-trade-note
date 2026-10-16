/* =========================================================
   tests/cases.js
   テストケースのデータ（入力値と期待値の表）。docs/fx-rules.md を書き写したもの（architecture.md 13.2）。
     ・計算        9.1 C-01〜C-17（17件）／9.2 R-01〜R-09（9件）／9.3 J-01〜J-09（9件）
     ・入力チェック 9.4 V-01〜V-19（19件）
     ・通貨ペア    10.8 P-01〜P-30（30件）
     ・セッション  11.8 S-01〜S-35（35件）
   合計 119件。元の資料が更新されたら、このファイルも同じように直す（T-14 で fx-expert が照合）。

   【追加分（T-11 と同時対応・2026-10-16）】fx-rules v1.5 の 14.1「追加のテストケース」計44件を末尾に書き写した。
     （14.1 の表が正式なテストケース。9章・10.8・11.8 には移さない約束：fx-rules 14.1 の注記）
     ・fx-expert の提案 37件：X 8件・Y 6件・Z 9件・V-20〜V-28 9件・P-31〜P-35 5件
     ・オーナー決定 #5・#6（fx-rules 14.2）に伴い pm が追加した 7件：C-18〜C-20（必要な値が空なら null）、
       V-29〜V-32（損益（円）の手入力で先頭の「+」・全角カンマを受け付ける）
     → 合計 119件 ＋ 44件 ＝ 163件。

   書き方の約束：
   ・期待値は資料の表のとおりに書く（pips は小数第1位、RR は小数第2位の数値）。
     比べるときは pips ×10、RR ×100 の「整数」に直してから比べる（fx-rules 9.5・6.3 ルール5）。
   ・null は「計算しない／判定対象外／空欄」を表す。
   ========================================================= */

/** 10.8.1 の共通条件：favoritePairs は初期値（fx-rules 10.3 の1〜6） */
export const DEFAULT_FAVORITES_FOR_TEST = ['USD/JPY', 'EUR/USD', 'GBP/JPY', 'EUR/JPY', 'AUD/JPY', 'GBP/USD'];

/* ---------- 9.1 pips・損益（円） ---------- */
export const PROFIT_CASES = [
  { id: 'C-01', title: 'JPYペア 買い・利益', pair: 'USD/JPY', side: 'buy', entryPrice: 150.000, exitPrice: 150.250, lots: 1, lotUnitSize: 10000, quoteToJpyRate: null, pips: 25.0, profitJpy: 2500 },
  { id: 'C-02', title: 'JPYペア 売り・利益', pair: 'USD/JPY', side: 'sell', entryPrice: 150.250, exitPrice: 150.000, lots: 1, lotUnitSize: 10000, quoteToJpyRate: null, pips: 25.0, profitJpy: 2500 },
  { id: 'C-03', title: 'JPYペア 買い・損失・小数ロット', pair: 'USD/JPY', side: 'buy', entryPrice: 150.500, exitPrice: 150.123, lots: 0.5, lotUnitSize: 10000, quoteToJpyRate: null, pips: -37.7, profitJpy: -1885 },
  { id: 'C-04', title: 'JPYペア 売り・損失・価格2桁入力・1lot=10万', pair: 'GBP/JPY', side: 'sell', entryPrice: 190.10, exitPrice: 190.35, lots: 2, lotUnitSize: 100000, quoteToJpyRate: null, pips: -25.0, profitJpy: -50000 },
  { id: 'C-05', title: '同値決済（引き分け）', pair: 'EUR/JPY', side: 'buy', entryPrice: 160.555, exitPrice: 160.555, lots: 1, lotUnitSize: 10000, quoteToJpyRate: null, pips: 0.0, profitJpy: 0 },
  { id: 'C-06', title: '最小クラスの小数ロット', pair: 'AUD/JPY', side: 'buy', entryPrice: 98.765, exitPrice: 99.012, lots: 0.01, lotUnitSize: 100000, quoteToJpyRate: null, pips: 24.7, profitJpy: 247 },
  { id: 'C-07', title: '非JPYペア 買い・利益', pair: 'EUR/USD', side: 'buy', entryPrice: 1.08500, exitPrice: 1.08750, lots: 1, lotUnitSize: 10000, quoteToJpyRate: 150.000, pips: 25.0, profitJpy: 3750 },
  { id: 'C-08', title: '非JPYペア 売り・損失・円未満の端数', pair: 'EUR/USD', side: 'sell', entryPrice: 1.0850, exitPrice: 1.0872, lots: 0.3, lotUnitSize: 100000, quoteToJpyRate: 149.85, pips: -22.0, profitJpy: -9890 },
  { id: 'C-09', title: '非JPYクロス（決済通貨GBP）', pair: 'EUR/GBP', side: 'sell', entryPrice: 0.86500, exitPrice: 0.86320, lots: 1, lotUnitSize: 10000, quoteToJpyRate: 190.456, pips: 18.0, profitJpy: 3428 },
  { id: 'C-10', title: '非JPYペア・換算レートなし', pair: 'GBP/USD', side: 'buy', entryPrice: 1.26500, exitPrice: 1.26123, lots: 1, lotUnitSize: 10000, quoteToJpyRate: null, pips: -37.7, profitJpy: null },
  { id: 'C-11', title: '浮動小数点誤差：0.5円ちょうど（利益）', pair: 'USD/JPY', side: 'buy', entryPrice: 150.000, exitPrice: 150.003, lots: 0.05, lotUnitSize: 10000, quoteToJpyRate: null, pips: 0.3, profitJpy: 2 },
  { id: 'C-12', title: '浮動小数点誤差：0.5円ちょうど（損失）', pair: 'USD/JPY', side: 'sell', entryPrice: 150.000, exitPrice: 150.003, lots: 0.05, lotUnitSize: 10000, quoteToJpyRate: null, pips: -0.3, profitJpy: -2 },
  { id: 'C-13', title: '浮動小数点誤差：pips', pair: 'EUR/USD', side: 'buy', entryPrice: 1.10000, exitPrice: 1.10030, lots: 1, lotUnitSize: 10000, quoteToJpyRate: 150, pips: 3.0, profitJpy: 450 },
  { id: 'C-14', title: '浮動小数点誤差：ロット 0.07', pair: 'USD/JPY', side: 'sell', entryPrice: 150.005, exitPrice: 150.000, lots: 0.07, lotUnitSize: 10000, quoteToJpyRate: null, pips: 0.5, profitJpy: 4 },
  { id: 'C-15', title: '浮動小数点誤差：0.1+0.2 系', pair: 'USD/JPY', side: 'buy', entryPrice: 150.1, exitPrice: 150.3, lots: 0.3, lotUnitSize: 10000, quoteToJpyRate: null, pips: 20.0, profitJpy: 600 },
  { id: 'C-16', title: '大きな数量（BigInt が必要）', pair: 'EUR/USD', side: 'buy', entryPrice: 1.00000, exitPrice: 1.10000, lots: 100, lotUnitSize: 100000, quoteToJpyRate: 150.123, pips: 1000.0, profitJpy: 150123000 },
  { id: 'C-17', title: 'わずかな利益（J-05・J-06 の元データ）', pair: 'USD/JPY', side: 'buy', entryPrice: 150.000, exitPrice: 150.005, lots: 1, lotUnitSize: 10000, quoteToJpyRate: null, pips: 0.5, profitJpy: 50 },
];

/* ---------- 9.2 リスクリワード（RR） ----------
   riskPips / rewardPips は資料の「損切り幅」「利確幅」（表示用。null は「—」）。
   warn は calcRiskReward が返す警告対象（'SL' / 'TP'。W-01）。 */
export const RR_CASES = [
  { id: 'R-01', title: '買い・基本', pair: 'USD/JPY', side: 'buy', entryPrice: 150.000, slPrice: 149.800, tpPrice: 150.400, riskPips: 20.0, rewardPips: 40.0, rr: 2.00, warn: [] },
  { id: 'R-02', title: '売り・非JPY・割り切れない', pair: 'EUR/USD', side: 'sell', entryPrice: 1.08500, slPrice: 1.08650, tpPrice: 1.08100, riskPips: 15.0, rewardPips: 40.0, rr: 2.67, warn: [] },
  { id: 'R-03', title: 'RRが1未満', pair: 'GBP/JPY', side: 'buy', entryPrice: 190.000, slPrice: 189.700, tpPrice: 190.100, riskPips: 30.0, rewardPips: 10.0, rr: 0.33, warn: [] },
  { id: 'R-04', title: '浮動小数点誤差（買い）', pair: 'USD/JPY', side: 'buy', entryPrice: 150.000, slPrice: 149.888, tpPrice: 150.070, riskPips: 11.2, rewardPips: 7.0, rr: 0.63, warn: [] },
  { id: 'R-05', title: '浮動小数点誤差（売り）', pair: 'EUR/USD', side: 'sell', entryPrice: 1.08500, slPrice: 1.08564, tpPrice: 1.08396, riskPips: 6.4, rewardPips: 10.4, rr: 1.63, warn: [] },
  { id: 'R-06', title: '買いで SL が利益側', pair: 'USD/JPY', side: 'buy', entryPrice: 150.000, slPrice: 150.200, tpPrice: 150.400, riskPips: null, rewardPips: null, rr: null, warn: ['SL'] },
  { id: 'R-07', title: '売りで TP が損失側', pair: 'USD/JPY', side: 'sell', entryPrice: 150.000, slPrice: 150.300, tpPrice: 150.100, riskPips: null, rewardPips: null, rr: null, warn: ['TP'] },
  { id: 'R-08', title: 'SL がエントリーと同値', pair: 'USD/JPY', side: 'buy', entryPrice: 150.000, slPrice: 150.000, tpPrice: 150.300, riskPips: null, rewardPips: null, rr: null, warn: ['SL'] },
  { id: 'R-09', title: 'TP 未入力', pair: 'USD/JPY', side: 'buy', entryPrice: 150.000, slPrice: 149.800, tpPrice: null, riskPips: null, rewardPips: null, rr: null, warn: [] },
];

/* ---------- 9.3 勝ち／負け／引き分けの判定 ----------
   expect：'win'（勝ち）/'loss'（負け）/'draw'（引き分け）/null（判定対象外） */
export const RESULT_CASES = [
  { id: 'J-01', title: 'C-01', trade: { status: 'closed', profitSource: 'auto', profitJpy: 2500, deletedAt: null }, expect: 'win' },
  { id: 'J-02', title: 'C-03', trade: { status: 'closed', profitSource: 'auto', profitJpy: -1885, deletedAt: null }, expect: 'loss' },
  { id: 'J-03', title: 'C-05（損益0円は引き分け）', trade: { status: 'closed', profitSource: 'auto', profitJpy: 0, deletedAt: null }, expect: 'draw' },
  { id: 'J-04', title: 'C-01 を業者確定値で上書き', trade: { status: 'closed', profitSource: 'manual', profitJpy: 2480, deletedAt: null }, expect: 'win' },
  { id: 'J-05', title: 'C-17 を業者確定値で上書き（pips は +0.5）', trade: { status: 'closed', profitSource: 'manual', profitJpy: -30, deletedAt: null }, expect: 'loss' },
  { id: 'J-06', title: 'C-17（決済理由＝建値決済）', trade: { status: 'closed', profitSource: 'auto', profitJpy: 50, deletedAt: null, exitReason: 'breakeven' }, expect: 'win' },
  { id: 'J-07', title: 'C-10 に −5,700円を手入力', trade: { status: 'closed', profitSource: 'manual', profitJpy: -5700, deletedAt: null }, expect: 'loss' },
  { id: 'J-08', title: '保有中の記録', trade: { status: 'open', profitSource: null, profitJpy: null, deletedAt: null }, expect: null },
  { id: 'J-09', title: 'C-01 を論理削除', trade: { status: 'closed', profitSource: 'auto', profitJpy: 2500, deletedAt: '2026-10-15T22:00:00+09:00' }, expect: null },
];

/* ---------- 9.4 入力値チェック ----------
   kind で「どのチェックを通すか」を表す（validate.test.js が kind ごとに関数を呼ぶ）。
   expect：{ error: 'E-xx' }（エラー）／{ warn: 'W-xx' }（警告・保存可）／{ ok: true, value }（OK・読み取った値） */
export const VALIDATE_CASES = [
  { id: 'V-01', title: 'エントリー価格', kind: 'price', pair: 'USD/JPY', input: '0', expect: { error: 'E-02' } },
  { id: 'V-02', title: 'エントリー価格', kind: 'price', pair: 'USD/JPY', input: '-150.000', expect: { error: 'E-02' } },
  { id: 'V-03', title: 'エントリー価格', kind: 'price', pair: 'USD/JPY', input: '150.1234', expect: { error: 'E-03' } },
  { id: 'V-04', title: 'エントリー価格', kind: 'price', pair: 'EUR/USD', input: '1.085001', expect: { error: 'E-04' } },
  { id: 'V-05', title: 'エントリー価格（末尾の0は桁数に数えない）', kind: 'price', pair: 'USD/JPY', input: '150.1200', expect: { ok: true, value: 150.12 } },
  { id: 'V-06', title: 'エントリー価格（全角の正規化）', kind: 'price', pair: 'USD/JPY', input: '１５０．２５', expect: { ok: true, value: 150.25 } },
  { id: 'V-07', title: 'エントリー価格', kind: 'price', pair: 'USD/JPY', input: '1e2', expect: { error: 'E-01' } },
  { id: 'V-08', title: 'エントリー価格', kind: 'price', pair: 'USD/JPY', input: '150,25', expect: { error: 'E-01' } },
  { id: 'V-09', title: 'ロット', kind: 'lots', input: '0', expect: { error: 'E-05' } },
  { id: 'V-10', title: 'ロット', kind: 'lots', input: '0.001', expect: { error: 'E-06' } },
  { id: 'V-11', title: 'ロット', kind: 'lots', input: '0.15', expect: { ok: true, value: 0.15 } },
  { id: 'V-12', title: 'エントリー価格／決済価格', kind: 'priceGap', pair: 'USD/JPY', entryInput: '150.12', exitInput: '15.012', expect: { warn: 'W-02' } },
  { id: 'V-13', title: 'エントリー日時／決済日時', kind: 'exitAt', entryAt: '2026-10-15T21:00:00+09:00', exitAt: '2026-10-15T20:59:00+09:00', expect: { error: 'E-10' } },
  { id: 'V-14', title: '決済の保存（換算レート空欄・損益（円）空欄）', kind: 'closeInputs', pair: 'EUR/USD', rateInput: '', profitInput: '', expect: { error: 'E-11' } },
  { id: 'V-15', title: '損益（円）の手入力（カンマの正規化）', kind: 'manualProfit', pair: 'EUR/USD', input: '-5,700', expect: { ok: true, value: -5700 } },
  { id: 'V-16', title: '損益（円）の手入力', kind: 'manualProfit', pair: 'USD/JPY', input: '1234.5', expect: { error: 'E-09' } },
  { id: 'V-17', title: '1lotの通貨数（設定）', kind: 'lotUnitSize', inputs: ['0', '1.5'], expect: { error: 'E-07' } },
  { id: 'V-18', title: '円換算レート', kind: 'rate', pair: 'EUR/USD', input: '150.1234', expect: { error: 'E-08' } },
  { id: 'V-19', title: 'ロット × 1lotの通貨数（2,000万通貨）', kind: 'quantity', input: '200', lotUnitSize: 100000, expect: { warn: 'W-04' } },
];

/* ---------- 10.3 通貨ペア一覧（P-05 の期待値として使う：マスタの表を独立に書き写したもの） ---------- */
export const PAIR_TABLE_10_3 = [
  { pair: 'USD/JPY', nameJa: '米ドル/円', base: 'USD', quote: 'JPY', isJpyPair: true, pipSize: 0.01, priceDecimals: 3, maxInputDecimals: 3, quoteToJpyPair: null, warnMin: 50, warnMax: 300 },
  { pair: 'EUR/USD', nameJa: 'ユーロ/米ドル', base: 'EUR', quote: 'USD', isJpyPair: false, pipSize: 0.0001, priceDecimals: 5, maxInputDecimals: 5, quoteToJpyPair: 'USD/JPY', warnMin: 0.5, warnMax: 2.5 },
  { pair: 'GBP/JPY', nameJa: 'ポンド/円', base: 'GBP', quote: 'JPY', isJpyPair: true, pipSize: 0.01, priceDecimals: 3, maxInputDecimals: 3, quoteToJpyPair: null, warnMin: 60, warnMax: 450 },
  { pair: 'EUR/JPY', nameJa: 'ユーロ/円', base: 'EUR', quote: 'JPY', isJpyPair: true, pipSize: 0.01, priceDecimals: 3, maxInputDecimals: 3, quoteToJpyPair: null, warnMin: 50, warnMax: 350 },
  { pair: 'AUD/JPY', nameJa: '豪ドル/円', base: 'AUD', quote: 'JPY', isJpyPair: true, pipSize: 0.01, priceDecimals: 3, maxInputDecimals: 3, quoteToJpyPair: null, warnMin: 30, warnMax: 200 },
  { pair: 'GBP/USD', nameJa: 'ポンド/米ドル', base: 'GBP', quote: 'USD', isJpyPair: false, pipSize: 0.0001, priceDecimals: 5, maxInputDecimals: 5, quoteToJpyPair: 'USD/JPY', warnMin: 0.6, warnMax: 3 },
  { pair: 'AUD/USD', nameJa: '豪ドル/米ドル', base: 'AUD', quote: 'USD', isJpyPair: false, pipSize: 0.0001, priceDecimals: 5, maxInputDecimals: 5, quoteToJpyPair: 'USD/JPY', warnMin: 0.3, warnMax: 2 },
  { pair: 'NZD/USD', nameJa: 'NZドル/米ドル', base: 'NZD', quote: 'USD', isJpyPair: false, pipSize: 0.0001, priceDecimals: 5, maxInputDecimals: 5, quoteToJpyPair: 'USD/JPY', warnMin: 0.25, warnMax: 1.5 },
  { pair: 'USD/CHF', nameJa: '米ドル/スイスフラン', base: 'USD', quote: 'CHF', isJpyPair: false, pipSize: 0.0001, priceDecimals: 5, maxInputDecimals: 5, quoteToJpyPair: 'CHF/JPY', warnMin: 0.4, warnMax: 2 },
  { pair: 'USD/CAD', nameJa: '米ドル/カナダドル', base: 'USD', quote: 'CAD', isJpyPair: false, pipSize: 0.0001, priceDecimals: 5, maxInputDecimals: 5, quoteToJpyPair: 'CAD/JPY', warnMin: 0.6, warnMax: 2.2 },
  { pair: 'EUR/GBP', nameJa: 'ユーロ/ポンド', base: 'EUR', quote: 'GBP', isJpyPair: false, pipSize: 0.0001, priceDecimals: 5, maxInputDecimals: 5, quoteToJpyPair: 'GBP/JPY', warnMin: 0.4, warnMax: 1.6 },
  { pair: 'EUR/AUD', nameJa: 'ユーロ/豪ドル', base: 'EUR', quote: 'AUD', isJpyPair: false, pipSize: 0.0001, priceDecimals: 5, maxInputDecimals: 5, quoteToJpyPair: 'AUD/JPY', warnMin: 0.7, warnMax: 3.5 },
  { pair: 'GBP/AUD', nameJa: 'ポンド/豪ドル', base: 'GBP', quote: 'AUD', isJpyPair: false, pipSize: 0.0001, priceDecimals: 5, maxInputDecimals: 5, quoteToJpyPair: 'AUD/JPY', warnMin: 0.9, warnMax: 4 },
  { pair: 'NZD/JPY', nameJa: 'NZドル/円', base: 'NZD', quote: 'JPY', isJpyPair: true, pipSize: 0.01, priceDecimals: 3, maxInputDecimals: 3, quoteToJpyPair: null, warnMin: 25, warnMax: 180 },
  { pair: 'CAD/JPY', nameJa: 'カナダドル/円', base: 'CAD', quote: 'JPY', isJpyPair: true, pipSize: 0.01, priceDecimals: 3, maxInputDecimals: 3, quoteToJpyPair: null, warnMin: 35, warnMax: 220 },
  { pair: 'CHF/JPY', nameJa: 'スイスフラン/円', base: 'CHF', quote: 'JPY', isJpyPair: true, pipSize: 0.01, priceDecimals: 3, maxInputDecimals: 3, quoteToJpyPair: null, warnMin: 40, warnMax: 400 },
  { pair: 'ZAR/JPY', nameJa: '南アフリカランド/円', base: 'ZAR', quote: 'JPY', isJpyPair: true, pipSize: 0.01, priceDecimals: 3, maxInputDecimals: 3, quoteToJpyPair: null, warnMin: 2, warnMax: 30 },
  { pair: 'MXN/JPY', nameJa: 'メキシコペソ/円', base: 'MXN', quote: 'JPY', isJpyPair: true, pipSize: 0.01, priceDecimals: 3, maxInputDecimals: 3, quoteToJpyPair: null, warnMin: 2, warnMax: 25 },
  { pair: 'TRY/JPY', nameJa: 'トルコリラ/円', base: 'TRY', quote: 'JPY', isJpyPair: true, pipSize: 0.01, priceDecimals: 3, maxInputDecimals: 3, quoteToJpyPair: null, warnMin: null, warnMax: null },
];

/* ---------- 10.8.1 マスタ参照と通貨ペアの追加 ----------
   kind 'spec'      … getPairSpec(input) の結果（P-01〜P-04）
   kind 'master'    … マスタ19ペア全件と 10.3 の表・判定ルールの一致（P-05）
   kind 'normalize' … normalizePairInput(input, 初期の favoritePairs) の結果（P-06〜P-19）
   expect.error がある行はエラー、expect.warn は警告の配列。pair が null の行は「正規化後の pair なし（—）」 */
export const PAIR_CASES = [
  { id: 'P-01', title: 'マスタ（プリセット）', kind: 'spec', input: 'USD/JPY', expect: { pair: 'USD/JPY', pipSize: 0.01, priceDecimals: 3, quoteToJpyPair: null } },
  { id: 'P-02', title: 'マスタ（プリセット）', kind: 'spec', input: 'EUR/USD', expect: { pair: 'EUR/USD', pipSize: 0.0001, priceDecimals: 5, quoteToJpyPair: 'USD/JPY' } },
  { id: 'P-03', title: '高金利通貨も JPYペアのルールどおり', kind: 'spec', input: 'TRY/JPY', expect: { pair: 'TRY/JPY', pipSize: 0.01, priceDecimals: 3, quoteToJpyPair: null } },
  { id: 'P-04', title: '決済通貨が GBP（C-09 と同じ）', kind: 'spec', input: 'EUR/GBP', expect: { pair: 'EUR/GBP', pipSize: 0.0001, priceDecimals: 5, quoteToJpyPair: 'GBP/JPY' } },
  { id: 'P-05', title: 'マスタ19ペア全件が 10.3 の表・判定ルールと一致', kind: 'master', input: 'マスタ19ペア全件', expect: { allMatch: true } },
  { id: 'P-06', title: '小文字・区切りなし（確認済み通貨なので警告なし）', kind: 'normalize', input: 'usdsek', expect: { ok: true, pair: 'USD/SEK', pipSize: 0.0001, priceDecimals: 5, quoteToJpyPair: 'SEK/JPY', warn: [] } },
  { id: 'P-07', title: '前後・途中の空白を除去', kind: 'normalize', input: ' sgd / jpy ', expect: { ok: true, pair: 'SGD/JPY', pipSize: 0.01, priceDecimals: 3, quoteToJpyPair: null, warn: [] } },
  { id: 'P-08', title: '全角を半角に', kind: 'normalize', input: 'ＥＵＲ／ＮＺＤ', expect: { ok: true, pair: 'EUR/NZD', pipSize: 0.0001, priceDecimals: 5, quoteToJpyPair: 'NZD/JPY', warn: [] } },
  { id: 'P-09', title: 'ハイフン区切り', kind: 'normalize', input: 'EUR-CHF', expect: { ok: true, pair: 'EUR/CHF', pipSize: 0.0001, priceDecimals: 5, quoteToJpyPair: 'CHF/JPY', warn: [] } },
  { id: 'P-10', title: 'マスタにあり favoritePairs にないので追加できる', kind: 'normalize', input: 'CHF/JPY', expect: { ok: true, pair: 'CHF/JPY', pipSize: 0.01, priceDecimals: 3, quoteToJpyPair: null, warn: [] } },
  { id: 'P-11', title: 'すでに登録済み', kind: 'normalize', input: 'USD/JPY', expect: { ok: false, error: 'E-16', pair: 'USD/JPY' } },
  { id: 'P-12', title: 'ゴールドは対象外（Q-05）', kind: 'normalize', input: 'XAU/USD', expect: { ok: false, error: 'E-13', pair: 'XAU/USD' } },
  { id: 'P-13', title: '同じ通貨', kind: 'normalize', input: 'USD/USD', expect: { ok: false, error: 'E-14', pair: 'USD/USD' } },
  { id: 'P-14', title: '円が左側', kind: 'normalize', input: 'JPY/USD', expect: { ok: false, error: 'E-15', pair: 'JPY/USD' } },
  { id: 'P-15', title: '5文字', kind: 'normalize', input: 'USDJP', expect: { ok: false, error: 'E-12', pair: null } },
  { id: 'P-16', title: '数字を含む', kind: 'normalize', input: 'US1/JPY', expect: { ok: false, error: 'E-12', pair: null } },
  { id: 'P-17', title: '業者によっては pip＝0.01（警告 W-07）', kind: 'normalize', input: 'USD/HUF', expect: { ok: true, pair: 'USD/HUF', pipSize: 0.0001, priceDecimals: 5, quoteToJpyPair: 'HUF/JPY', warn: ['W-07'] } },
  { id: 'P-18', title: '未確認の通貨コード（警告 W-07）', kind: 'normalize', input: 'ABC/JPY', expect: { ok: true, pair: 'ABC/JPY', pipSize: 0.01, priceDecimals: 3, quoteToJpyPair: null, warn: ['W-07'] } },
  { id: 'P-19', title: '小文字・スラッシュ区切り', kind: 'normalize', input: 'gbp/nzd', expect: { ok: true, pair: 'GBP/NZD', pipSize: 0.0001, priceDecimals: 5, quoteToJpyPair: 'NZD/JPY', warn: [] } },

  /* ---------- 10.8.2 価格の表示と価格帯の警告（W-06） ----------
     kind 'display' … formatPrice(price, pair) の文字と isOutOfPriceRange(price, pair) の結果 */
  { id: 'P-20', title: '0埋めして第3位まで', kind: 'display', pair: 'USD/JPY', price: 150.1, expect: { text: '150.100', w06: false } },
  { id: 'P-21', title: '0埋めして第5位まで', kind: 'display', pair: 'EUR/USD', price: 1.085, expect: { text: '1.08500', w06: false } },
  { id: 'P-22', title: '価格帯チェックなし（null）', kind: 'display', pair: 'TRY/JPY', price: 3.5, expect: { text: '3.500', w06: false } },
  { id: 'P-23', title: '整数部が0、0.5 未満', kind: 'display', pair: 'EUR/USD', price: 0.00012, expect: { text: '0.00012', w06: true } },
  { id: 'P-24', title: 'EUR/USD の価格を入れたペアの選び間違い', kind: 'display', pair: 'USD/JPY', price: 1.085, expect: { text: '1.085', w06: true } },
  { id: 'P-25', title: '桁の打ち間違い', kind: 'display', pair: 'USD/JPY', price: 1501.2, expect: { text: '1501.200', w06: true } },
  { id: 'P-26', title: 'USD/JPY の価格を入れたペアの選び間違い', kind: 'display', pair: 'EUR/USD', price: 150.12, expect: { text: '150.12000', w06: true } },
  { id: 'P-27', title: '2 未満', kind: 'display', pair: 'ZAR/JPY', price: 1.085, expect: { text: '1.085', w06: true } },
  { id: 'P-28', title: '範囲内', kind: 'display', pair: 'AUD/JPY', price: 98.765, expect: { text: '98.765', w06: false } },
  { id: 'P-29', title: '境界値（warnMax ちょうどは範囲内）', kind: 'display', pair: 'USD/JPY', price: 300, expect: { text: '300.000', w06: false } },
  { id: 'P-30', title: 'ユーザー追加ペアは価格帯チェックなし', kind: 'display', pair: 'USD/SEK', price: 10.5, expect: { text: '10.50000', w06: false } },
];

/* ---------- 11.8 セッション判定 ----------
   ※ ここでの S-xx はセッション判定のテスト番号で、画面ID（S-01 一覧など）とは無関係。
   week・period は資料の「曜日」「期間」（日本時間。①冬 ②ずれ ③夏）で、表示用。expect が null は「読めない」 */
export const SESSION_CASES = [
  { id: 'S-01', entryAt: '2026-01-14T08:59:00+09:00', week: '水', period: '①冬', expect: 'other', title: '東京の始まりの1分前（早朝）' },
  { id: 'S-02', entryAt: '2026-01-14T09:00:00+09:00', week: '水', period: '①冬', expect: 'tokyo', title: '東京の始まり（境界は始まりを含む）' },
  { id: 'S-03', entryAt: '2026-01-14T16:59:00+09:00', week: '水', period: '①冬', expect: 'tokyo', title: '冬はロンドンが 17:00 開始' },
  { id: 'S-04', entryAt: '2026-01-14T17:00:00+09:00', week: '水', period: '①冬', expect: 'london', title: '東京とロンドンの重なりはロンドン優先' },
  { id: 'S-05', entryAt: '2026-01-14T21:59:00+09:00', week: '水', period: '①冬', expect: 'london', title: '冬は NY が 22:00 開始' },
  { id: 'S-06', entryAt: '2026-01-14T22:00:00+09:00', week: '水', period: '①冬', expect: 'newyork', title: 'ロンドンと NY の重なりは NY 優先' },
  { id: 'S-07', entryAt: '2026-01-15T06:59:00+09:00', week: '木', period: '①冬', expect: 'newyork', title: '日付をまたいでも前日の NY セッション' },
  { id: 'S-08', entryAt: '2026-01-15T07:00:00+09:00', week: '木', period: '①冬', expect: 'other', title: '冬の NYクローズは 7:00' },
  { id: 'S-09', entryAt: '2026-07-15T15:59:59+09:00', week: '水', period: '③夏', expect: 'tokyo', title: '秒は切り捨て' },
  { id: 'S-10', entryAt: '2026-07-15T16:00:00+09:00', week: '水', period: '③夏', expect: 'london', title: '夏はロンドンが 16:00 開始' },
  { id: 'S-11', entryAt: '2026-07-15T20:59:00+09:00', week: '水', period: '③夏', expect: 'london', title: '' },
  { id: 'S-12', entryAt: '2026-07-15T21:00:00+09:00', week: '水', period: '③夏', expect: 'newyork', title: '夏は NY が 21:00 開始' },
  { id: 'S-13', entryAt: '2026-07-16T05:59:00+09:00', week: '木', period: '③夏', expect: 'newyork', title: '' },
  { id: 'S-14', entryAt: '2026-07-16T06:00:00+09:00', week: '木', period: '③夏', expect: 'other', title: '夏の NYクローズは 6:00' },
  { id: 'S-15', entryAt: '2026-03-06T21:30:00+09:00', week: '金', period: '①冬', expect: 'london', title: '米国の切り替え（3/8）前の週。NY はまだ 22:00 開始' },
  { id: 'S-16', entryAt: '2026-03-09T16:30:00+09:00', week: '月', period: '②ずれ', expect: 'tokyo', title: '米国だけ夏時間。ロンドンはまだ 17:00 開始' },
  { id: 'S-17', entryAt: '2026-03-09T21:00:00+09:00', week: '月', period: '②ずれ', expect: 'newyork', title: 'NY は夏時間で 21:00 開始' },
  { id: 'S-18', entryAt: '2026-03-10T06:00:00+09:00', week: '火', period: '②ずれ', expect: 'other', title: 'NYクローズが 6:00 になっている' },
  { id: 'S-19', entryAt: '2026-03-27T16:30:00+09:00', week: '金', period: '②ずれ', expect: 'tokyo', title: '欧州の切り替え（3/29）前の最後の平日' },
  { id: 'S-20', entryAt: '2026-03-30T16:30:00+09:00', week: '月', period: '③夏', expect: 'london', title: '欧州も夏時間になりロンドンが 16:00 開始' },
  { id: 'S-21', entryAt: '2026-10-23T16:30:00+09:00', week: '金', period: '③夏', expect: 'london', title: '欧州の終了（10/25）前の最後の平日' },
  { id: 'S-22', entryAt: '2026-10-26T16:30:00+09:00', week: '月', period: '②ずれ', expect: 'tokyo', title: '欧州は冬時間に戻り、ロンドンが 17:00 開始' },
  { id: 'S-23', entryAt: '2026-10-26T21:30:00+09:00', week: '月', period: '②ずれ', expect: 'newyork', title: '米国はまだ夏時間（21:00 開始）' },
  { id: 'S-24', entryAt: '2026-11-02T21:30:00+09:00', week: '月', period: '①冬', expect: 'london', title: '米国も冬時間（11/1〜）になり NY は 22:00 開始' },
  { id: 'S-25', entryAt: '2026-11-03T06:30:00+09:00', week: '火', period: '①冬', expect: 'newyork', title: '冬の NYクローズは 7:00' },
  { id: 'S-26', entryAt: '2026-10-17T05:59:00+09:00', week: '土', period: '③夏', expect: 'newyork', title: '土曜の早朝は金曜 NY セッションの続き' },
  { id: 'S-27', entryAt: '2026-10-17T06:00:00+09:00', week: '土', period: '③夏', expect: 'other', title: '週末の始まり（夏の NYクローズ）' },
  { id: 'S-28', entryAt: '2026-10-17T21:30:00+09:00', week: '土', period: '③夏', expect: 'other', title: '平日なら NY の時刻だが週末' },
  { id: 'S-29', entryAt: '2026-10-18T12:00:00+09:00', week: '日', period: '③夏', expect: 'other', title: '日曜は終日 other' },
  { id: 'S-30', entryAt: '2026-10-19T05:00:00+09:00', week: '月', period: '③夏', expect: 'other', title: '月曜早朝（NY時刻ではまだ日曜）' },
  { id: 'S-31', entryAt: '2026-10-19T09:00:00+09:00', week: '月', period: '③夏', expect: 'tokyo', title: '週明けの東京' },
  { id: 'S-32', entryAt: '2026-01-17T06:30:00+09:00', week: '土', period: '①冬', expect: 'newyork', title: '冬は土曜 7:00 まで金曜 NY セッション' },
  { id: 'S-33', entryAt: '2026-03-08T16:30:00+09:00', week: '日', period: '—', expect: 'other', title: '米国の切り替え当日（日曜）' },
  { id: 'S-34', entryAt: '2026-07-15T07:00:00Z', week: '水', period: '③夏', expect: 'london', title: 'UTC表記（日本時間 16:00 と同じ瞬間）' },
  { id: 'S-35', entryAt: 'abc', week: '—', period: '—', expect: null, title: '日時として読めない' },
];

/* =========================================================
   追加（T-11 と同時対応・2026-10-16）
   ========================================================= */

/* ---------- fx-rules 14.1：pips・損益（円）X-xx・C-18〜C-20（形は PROFIT_CASES と同じ） ----------
   C-18〜C-20 は「必要な値が空」のケース（fx-rules 4.5。空は null で書く）。pips が null の行は diffPoints も null であること。 */
export const EXTRA_PROFIT_CASES = [
  { id: 'X-01', title: '非JPY 0.5円ちょうど（利益）', pair: 'EUR/USD', side: 'buy', entryPrice: 1.00000, exitPrice: 1.00001, lots: 0.01, lotUnitSize: 100000, quoteToJpyRate: 150.000, pips: 0.1, profitJpy: 2 },
  { id: 'X-02', title: '非JPY 0.5円ちょうど（損失）', pair: 'EUR/USD', side: 'sell', entryPrice: 1.00000, exitPrice: 1.00001, lots: 0.01, lotUnitSize: 100000, quoteToJpyRate: 150.000, pips: -0.1, profitJpy: -2 },
  { id: 'X-03', title: '小さな損失が0円に丸まる（マイナスゼロにしない）', pair: 'USD/JPY', side: 'sell', entryPrice: 150.000, exitPrice: 150.001, lots: 0.04, lotUnitSize: 10000, quoteToJpyRate: null, pips: -0.1, profitJpy: 0 },
  { id: 'X-05', title: 'JPY 最小値幅の −0.5円ちょうど', pair: 'USD/JPY', side: 'sell', entryPrice: 150.000, exitPrice: 150.001, lots: 0.05, lotUnitSize: 10000, quoteToJpyRate: null, pips: -0.1, profitJpy: -1 },
  { id: 'X-10', title: '非JPY 売り・大きな数量', pair: 'EUR/USD', side: 'sell', entryPrice: 1.10000, exitPrice: 1.00000, lots: 1000, lotUnitSize: 100000, quoteToJpyRate: 999.999, pips: 1000.0, profitJpy: 9999990000 },
  { id: 'X-12', title: '売り利益・小数ロットの四捨五入', pair: 'GBP/JPY', side: 'sell', entryPrice: 190.355, exitPrice: 190.123, lots: 0.33, lotUnitSize: 10000, quoteToJpyRate: null, pips: 23.2, profitJpy: 766 },
  { id: 'X-14', title: '追加ペア（決済通貨 SEK）', pair: 'USD/SEK', side: 'buy', entryPrice: 10.50000, exitPrice: 10.51234, lots: 1, lotUnitSize: 10000, quoteToJpyRate: 14.123, pips: 123.4, profitJpy: 1743 },
  { id: 'X-15', title: '追加ペア（決済通貨 HUF）', pair: 'USD/HUF', side: 'sell', entryPrice: 360.12345, exitPrice: 360.00000, lots: 0.1, lotUnitSize: 10000, quoteToJpyRate: 0.412, pips: 1234.5, profitJpy: 51 },
  { id: 'C-18', title: '決済価格が空（保有中・入力途中）：決定 #5', pair: 'USD/JPY', side: 'buy', entryPrice: 150.000, exitPrice: null, lots: 1, lotUnitSize: 10000, quoteToJpyRate: null, pips: null, profitJpy: null },
  { id: 'C-19', title: 'ロットが空：決定 #5', pair: 'USD/JPY', side: 'buy', entryPrice: 150.000, exitPrice: 150.250, lots: null, lotUnitSize: 10000, quoteToJpyRate: null, pips: 25.0, profitJpy: null },
  { id: 'C-20', title: '1lotの通貨数が空（例外にしない）：決定 #5', pair: 'USD/JPY', side: 'buy', entryPrice: 150.000, exitPrice: 150.250, lots: 1, lotUnitSize: null, quoteToJpyRate: null, pips: 25.0, profitJpy: null },
];

/* ---------- fx-rules 14.1：リスクリワード Y-xx（形は RR_CASES と同じ。損切り幅・利確幅は資料に記載なし） ---------- */
export const EXTRA_RR_CASES = [
  { id: 'Y-01', title: '非JPY 買いの RR', pair: 'EUR/USD', side: 'buy', entryPrice: 1.08500, slPrice: 1.08300, tpPrice: 1.08900, rr: 2.00, warn: [] },
  { id: 'Y-02', title: 'SL・TP とも逆', pair: 'USD/JPY', side: 'buy', entryPrice: 150.000, slPrice: 150.100, tpPrice: 149.900, rr: null, warn: ['SL', 'TP'] },
  { id: 'Y-03', title: '売りで SL が利益側', pair: 'USD/JPY', side: 'sell', entryPrice: 150.000, slPrice: 149.900, tpPrice: 149.500, rr: null, warn: ['SL'] },
  { id: 'Y-05', title: '損切り幅が最小（0.1pip）', pair: 'USD/JPY', side: 'buy', entryPrice: 150.000, slPrice: 149.999, tpPrice: 151.000, rr: 1000.00, warn: [] },
  { id: 'Y-06', title: 'RR が 0.00 に丸まる（null ではない）', pair: 'USD/JPY', side: 'buy', entryPrice: 150.000, slPrice: 149.000, tpPrice: 150.001, rr: 0.00, warn: [] },
  { id: 'Y-07', title: 'RR 0.005 の切り上げ', pair: 'USD/JPY', side: 'buy', entryPrice: 150.000, slPrice: 149.800, tpPrice: 150.001, rr: 0.01, warn: [] },
];

/* ---------- fx-rules 14.1：セッション判定 Z-xx（形は SESSION_CASES と同じ。曜日・期間は日本時間） ---------- */
export const EXTRA_SESSION_CASES = [
  { id: 'Z-02', entryAt: '2026-03-14T05:59:00+09:00', week: '土', period: '②ずれ', expect: 'newyork', title: 'ずれ期間の土曜早朝（金曜 NY の最後）' },
  { id: 'Z-03', entryAt: '2026-03-14T06:00:00+09:00', week: '土', period: '②ずれ', expect: 'other', title: 'ずれ期間の週末入り（NYクローズ 6:00）' },
  { id: 'Z-04', entryAt: '2026-10-31T06:30:00+09:00', week: '土', period: '②ずれ', expect: 'other', title: '秋のずれ期間の土曜（米国まだ夏時間）' },
  { id: 'Z-05', entryAt: '2026-11-07T06:30:00+09:00', week: '土', period: '①冬', expect: 'newyork', title: '米国が冬時間に戻った最初の土曜' },
  { id: 'Z-08', entryAt: '2026-03-09T17:00:00+09:00', week: '月', period: '②ずれ', expect: 'london', title: 'ずれ期間のロンドン開始ちょうど' },
  { id: 'Z-14', entryAt: '2026-10-27T06:00:00+09:00', week: '火', period: '②ずれ', expect: 'other', title: '秋のずれ期間の NYクローズ' },
  { id: 'Z-15', entryAt: '2026-11-02T06:30:00+09:00', week: '月', period: '①冬', expect: 'other', title: '米国冬時間に戻った直後の月曜早朝（NY はまだ日曜）' },
  { id: 'Z-21', entryAt: '2026-10-15T21:30:00-04:00', week: '金', period: '③夏', expect: 'tokyo', title: 'NY時刻での表記（日本時間 10/16(金) 10:30）' },
  { id: 'Z-23', entryAt: null, week: '—', period: '—', expect: null, title: 'null（修正依頼 #1 で合格するようになる）' },
];

/* ---------- fx-rules 14.1：入力チェック V-20〜V-28 ----------
   1つの ID に複数の入力があるため kind 'multi' にまとめ、checks の1つ1つを VALIDATE_CASES と同じ形で書く。
   checks がすべて期待どおりのときだけ合格。
   kind 'signMismatch' は W-05（手入力の損益と pips の符号が逆）：pips と損益の入力文字から判定する。 */
export const EXTRA_VALIDATE_CASES = [
  { id: 'V-20', title: '「.5」「150.」の受け付け', kind: 'multi', checks: [
    { kind: 'price', pair: 'USD/JPY', input: '150.', expect: { ok: true, value: 150 } },
    { kind: 'lots', input: '.5', expect: { ok: true, value: 0.5 } },
  ] },
  { id: 'V-21', title: '1lotの通貨数のカンマ・末尾0', kind: 'multi', checks: [
    { kind: 'lotUnitSize', inputs: ['10,000'], expect: { error: 'E-07' } },
    { kind: 'lotUnitSize', inputs: ['10000.0'], expect: { ok: true, value: 10000 } },
  ] },
  { id: 'V-22', title: '損益（円）の小数点付き整数・全角マイナス', kind: 'multi', checks: [
    { kind: 'manualProfit', input: '1234.0', expect: { error: 'E-09' } },
    { kind: 'manualProfit', input: '−5,700', expect: { ok: true, value: -5700 } },
  ] },
  { id: 'V-23', title: 'ロットの末尾0・0', kind: 'multi', checks: [
    { kind: 'lots', input: '0.010', expect: { ok: true, value: 0.01 } },
    { kind: 'lots', input: '0.00', expect: { error: 'E-05' } },
  ] },
  { id: 'V-24', title: 'W-02 のちょうど10%', kind: 'multi', checks: [
    { kind: 'priceGap', pair: 'USD/JPY', entryInput: '150.000', exitInput: '165.000', expect: { warn: 'W-02' } },
    { kind: 'priceGap', pair: 'USD/JPY', entryInput: '150.000', exitInput: '164.999', expect: { ok: true, value: 164.999 } },
  ] },
  { id: 'V-25', title: 'W-04 のちょうど1,000万通貨', kind: 'multi', checks: [
    { kind: 'quantity', input: '100', lotUnitSize: 100000, expect: { ok: true, value: 100 } },
    { kind: 'quantity', input: '100.01', lotUnitSize: 100000, expect: { warn: 'W-04' } },
  ] },
  { id: 'V-26', title: 'W-05 で pips が0', kind: 'multi', checks: [
    { kind: 'signMismatch', pips: 0.0, profitInput: '-30', expect: { ok: true, value: -30 } },
  ] },
  { id: 'V-27', title: 'E-10 で表記の違う同じ瞬間', kind: 'multi', checks: [
    { kind: 'exitAt', entryAt: '2026-10-15T21:00:00+09:00', exitAt: '2026-10-15T12:00:00Z', expect: { ok: true, value: '2026-10-15T12:00:00Z' } },
    { kind: 'exitAt', entryAt: '2026-10-15T21:00:00+09:00', exitAt: '2026-10-15T11:59:00Z', expect: { error: 'E-10' } },
  ] },
  { id: 'V-28', title: 'E-11 で追加した非JPYペア', kind: 'multi', checks: [
    { kind: 'closeInputs', pair: 'USD/SEK', rateInput: '', profitInput: '', expect: { error: 'E-11' } },
  ] },
  { id: 'V-29', title: '損益（円）の手入力・先頭の「+」：決定 #6', kind: 'multi', checks: [
    { kind: 'manualProfit', input: '+2,480', expect: { ok: true, value: 2480 } },
    { kind: 'manualProfit', input: '＋2,480', expect: { ok: true, value: 2480 } },
  ] },
  { id: 'V-30', title: '損益（円）の手入力・全角の数字・カンマ・マイナス：決定 #6', kind: 'multi', checks: [
    { kind: 'manualProfit', input: '－５，７００', expect: { ok: true, value: -5700 } },
  ] },
  { id: 'V-31', title: '損益（円）の手入力・符号の重複・符号だけ：決定 #6', kind: 'multi', checks: [
    { kind: 'manualProfit', input: '+-5', expect: { error: 'E-09' } },
    { kind: 'manualProfit', input: '++5', expect: { error: 'E-09' } },
    { kind: 'manualProfit', input: '+', expect: { error: 'E-09' } },
  ] },
  { id: 'V-32', title: '価格の先頭の「+」は引き続き不可：決定 #6', kind: 'multi', checks: [
    { kind: 'price', pair: 'USD/JPY', input: '+150.25', expect: { error: 'E-01' } },
  ] },
];

/* ---------- fx-rules 14.1：通貨ペアの追加 P-31〜P-35 ----------
   kind 'normalizeMulti'：items の1つ1つを PAIR_CASES の 'normalize' と同じ形で書く（全部一致で合格）。
   P-35 の pip単位・桁数・円換算ペアは資料に記載がないため、判定ルール（fx-rules 10.4 手順3）から書いた。 */
export const EXTRA_PAIR_CASES = [
  { id: 'P-31', title: '区切りが空白・下線', kind: 'normalizeMulti', items: [
    { input: 'USD JPY', expect: { ok: false, error: 'E-16', pair: 'USD/JPY' } },
    { input: 'usd_jpy', expect: { ok: false, error: 'E-16', pair: 'USD/JPY' } },
  ] },
  { id: 'P-32', title: '対応しない区切り', kind: 'normalizeMulti', items: [
    { input: 'USD.SEK', expect: { ok: false, error: 'E-12', pair: null } },
    { input: 'USD−SEK', expect: { ok: false, error: 'E-12', pair: null } }, // U+2212（マイナス記号）
  ] },
  { id: 'P-33', title: '区切りなしの貴金属', kind: 'normalizeMulti', items: [
    { input: 'XAUUSD', expect: { ok: false, error: 'E-13', pair: 'XAU/USD' } },
  ] },
  { id: 'P-34', title: '判定の順（E-14 が E-15 より先）', kind: 'normalizeMulti', items: [
    { input: 'JPY/JPY', expect: { ok: false, error: 'E-14', pair: 'JPY/JPY' } },
  ] },
  { id: 'P-35', title: 'CNY（未確認）と CNH（確認済み）の区別', kind: 'normalizeMulti', items: [
    { input: 'USD/CNY', expect: { ok: true, pair: 'USD/CNY', pipSize: 0.0001, priceDecimals: 5, quoteToJpyPair: 'CNY/JPY', warn: ['W-07'] } },
    { input: 'eur/cnh', expect: { ok: true, pair: 'EUR/CNH', pipSize: 0.0001, priceDecimals: 5, quoteToJpyPair: 'CNH/JPY', warn: [] } },
  ] },
];
