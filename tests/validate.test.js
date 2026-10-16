/* =========================================================
   tests/validate.test.js
   js/validate.js のテスト（入力チェック：fx-rules 9.4 の V-01〜V-19）。
   追加（2026-10-16）：fx-rules 14.1 の V-20〜V-32（1つの ID に入力が複数あるので kind 'multi'）。
   V-29〜V-32 は損益（円）の手入力で先頭の「+」・全角カンマを受け付ける決定（fx-rules 14.2 #6）の確認。
   入力欄に打った「文字」から始めて、画面と同じ順番（読み取り → チェック）で関数を呼ぶ。
   ========================================================= */
import {
  parsePrice, parseLots, parseLotUnitSize, parseQuoteToJpyRate, parseManualProfitJpy,
  checkExitAfterEntry, checkCloseInputs, isLargePriceGap, isLargeQuantity, isSignMismatch,
} from '../js/validate.js';
import { VALIDATE_CASES, EXTRA_VALIDATE_CASES } from './cases.js';
import { show } from './helpers.js';

/** 期待値・実際の値を同じ形の文字にする：「エラー E-02」「警告 W-02（保存可）」「OK（150.12）」 */
function describe(r) {
  if (r.error) return `エラー ${r.error}`;
  if (r.warn) return `警告 ${r.warn}（保存可）`;
  return `OK（${show(r.value)}）`;
}

/** 期待値と実際の値が一致するか（OK の行は読み取った値も比べる） */
function same(actual, expect) {
  if (expect.error || actual.error) return actual.error === expect.error;
  if (expect.warn || actual.warn) return actual.warn === expect.warn;
  return actual.ok === true && actual.value === expect.value;
}

/** 読み取り結果 { ok, value } / { ok:false, error } を比較用の形に */
const fromParse = (p) => (p.ok ? { ok: true, value: p.value } : { error: p.error });

/** kind ごとに、画面と同じ順番で validate.js の関数を呼ぶ */
function runCase(c) {
  switch (c.kind) {
    case 'price': return fromParse(parsePrice(c.input, c.pair));
    case 'lots': return fromParse(parseLots(c.input));
    case 'rate': return fromParse(parseQuoteToJpyRate(c.input));
    case 'manualProfit': return fromParse(parseManualProfitJpy(c.input));
    case 'lotUnitSize': {
      // 複数の入力をすべて試し、1つでも期待と違えばその結果を返す
      const results = c.inputs.map((s) => fromParse(parseLotUnitSize(s)));
      return results.find((r) => !same(r, c.expect)) || results[0];
    }
    case 'priceGap': {
      // 両方の価格が正しく読めたうえで（＝保存できる状態で）、差が大きいと警告 W-02
      const e = parsePrice(c.entryInput, c.pair);
      const x = parsePrice(c.exitInput, c.pair);
      if (!e.ok) return { error: e.error };
      if (!x.ok) return { error: x.error };
      return isLargePriceGap(e.value, x.value, c.pair) ? { warn: 'W-02' } : { ok: true, value: x.value };
    }
    case 'exitAt': {
      const r = checkExitAfterEntry(c.entryAt, c.exitAt);
      return r.ok ? { ok: true, value: c.exitAt } : { error: r.error };
    }
    case 'closeInputs': {
      const rate = parseQuoteToJpyRate(c.rateInput);
      const profit = parseManualProfitJpy(c.profitInput);
      if (!rate.ok) return { error: rate.error };
      if (!profit.ok) return { error: profit.error };
      const r = checkCloseInputs({ pair: c.pair, quoteToJpyRate: rate.value, manualProfitJpy: profit.value });
      return r.ok ? { ok: true, value: null } : { error: r.error };
    }
    case 'quantity': {
      const lots = parseLots(c.input);
      if (!lots.ok) return { error: lots.error };
      return isLargeQuantity(lots.value, c.lotUnitSize) ? { warn: 'W-04' } : { ok: true, value: lots.value };
    }
    case 'signMismatch': {
      // 手入力の損益を読み取ってから、pips と符号が逆か（W-05）を見る（決済画面と同じ順番）
      const profit = parseManualProfitJpy(c.profitInput);
      if (!profit.ok) return { error: profit.error };
      return isSignMismatch(c.pips, profit.value) ? { warn: 'W-05' } : { ok: true, value: profit.value };
    }
    default:
      throw new Error(`未対応の kind：${c.kind}`);
  }
}

/** テスト一覧の「入力」欄の文字 */
function inputText(c) {
  const pair = c.pair ? `${c.pair}・` : '';
  switch (c.kind) {
    case 'priceGap': return `${pair}エントリー ${show(c.entryInput)}／決済 ${show(c.exitInput)}`;
    case 'exitAt': return `エントリー ${c.entryAt}／決済 ${c.exitAt}`;
    case 'closeInputs': return `${pair}換算レート ${show(c.rateInput)}・損益（円） ${show(c.profitInput)}`;
    case 'lotUnitSize': return c.inputs.map(show).join(' ／ ');
    case 'quantity': return `ロット ${show(c.input)} × 1lot ${c.lotUnitSize.toLocaleString('en-US')}通貨`;
    case 'signMismatch': return `pips ${c.pips.toFixed(1)}・損益（円） ${show(c.profitInput)}`;
    case 'multi': return c.checks.map(inputText).join(' ／ ');
    default: return `${pair}${show(c.input)}`;
  }
}

/** kind 'multi'：checks の1つ1つを実行し、全部が期待どおりのときだけ合格 */
function runMulti(c) {
  const rows = c.checks.map((sub) => {
    const actual = runCase(sub);
    return { text: describe(actual), pass: same(actual, sub.expect) };
  });
  return { actual: rows.map((r) => r.text).join(' ／ '), pass: rows.every((r) => r.pass) };
}

export function collectValidateTests() {
  return [...VALIDATE_CASES, ...EXTRA_VALIDATE_CASES].map((c) => ({
    category: '入力チェック', id: c.id, title: c.title,
    input: inputText(c),
    expected: c.kind === 'multi' ? c.checks.map((sub) => describe(sub.expect)).join(' ／ ') : describe(c.expect),
    run: () => {
      if (c.kind === 'multi') return runMulti(c);
      const actual = runCase(c);
      return { actual: describe(actual), pass: same(actual, c.expect) };
    },
  }));
}
