/* =========================================================
   tests/calc.test.js
   js/calc.js のテスト。
     ・計算      fx-rules 9.1（C-01〜C-17）・9.2（R-01〜R-09）・9.3（J-01〜J-09）
     ・セッション fx-rules 11.8（S-01〜S-35）
     ・追加（2026-10-16）fx-rules 14.1 の追加のテストケース（X-xx・C-18〜C-20・Y-xx・Z-xx）
   ========================================================= */
import { calcPips, calcProfitJpy, calcRiskReward, calcSlTpPips, judgeResult, judgeSession } from '../js/calc.js';
import {
  PROFIT_CASES, RR_CASES, RESULT_CASES, SESSION_CASES,
  EXTRA_PROFIT_CASES, EXTRA_RR_CASES, EXTRA_SESSION_CASES,
} from './cases.js';
import { toInt, signed, yen, sameArray, show } from './helpers.js';

const SIDE_JA = { buy: '買い', sell: '売り' };
/** 入力の説明用：null は「（空）」、undefined は「（undefined）」と書く（Y-08〜Y-13 で空の値の種類を見分けるため） */
const blankText = (v) => (v === undefined ? '（undefined）' : v === null ? '（空）' : v);
const RESULT_JA = { win: '勝ち', loss: '負け', draw: '引き分け' };
const resultJa = (r) => (r == null ? '判定対象外' : RESULT_JA[r] || show(r));

/** 損切り幅・利確幅の表示用（null は「—」） */
const signedWidth = (x) => (x == null ? '—' : `${x.toFixed(1)}pips`);

/** 計算（C・R・J）のテスト定義 */
export function collectCalcTests() {
  const tests = [];

  // ---- 9.1 pips・損益（円） ----
  for (const c of [...PROFIT_CASES, ...EXTRA_PROFIT_CASES]) {
    tests.push({
      category: '計算', id: c.id, title: c.title,
      input: `${c.pair} ${SIDE_JA[c.side]} ${c.entryPrice}→${c.exitPrice ?? '（空）'}・${c.lots ?? '（空）'}lot×${c.lotUnitSize == null ? '（空）' : c.lotUnitSize.toLocaleString('en-US')}通貨・換算レート ${c.quoteToJpyRate ?? '—'}`,
      expected: `${signed(c.pips, 1)} pips／${yen(c.profitJpy)} 円`,
      run: () => {
        const { diffPoints, pips } = calcPips(c);
        const profit = calcProfitJpy(c);
        // pips は ×10 の整数で比べる（fx-rules 9.5）。損益は整数（または null）なのでそのまま比べる
        const pipsOk = toInt(pips, 10) === toInt(c.pips, 10)
          // 必要な値が空の行（C-18）は、形を保ったまま diffPoints も null であること（fx-rules 4.5）
          && (c.pips !== null || diffPoints === null);
        const profitOk = profit === c.profitJpy;
        // マイナスゼロ（-0）を作らないこと（fx-rules 6.1）。-0 === 0 は true になるので Object.is で確かめる
        const noMinusZero = !Object.is(pips, -0) && !Object.is(profit, -0);
        return {
          actual: `${signed(pips, 1)} pips／${yen(profit)} 円${noMinusZero ? '' : '（-0 が含まれる）'}`,
          pass: pipsOk && profitOk && noMinusZero,
        };
      },
    });
  }

  // ---- 9.2 リスクリワード（RR） ----
  for (const c of [...RR_CASES, ...EXTRA_RR_CASES]) {
    tests.push({
      category: '計算', id: c.id, title: c.title,
      input: `${blankText(c.pair)} ${SIDE_JA[c.side] ?? blankText(c.side)} エントリー ${blankText(c.entryPrice)}・SL ${blankText(c.slPrice)}・TP ${blankText(c.tpPrice)}`,
      expected: `RR ${c.rr == null ? 'null' : c.rr.toFixed(2)}／警告 ${c.warn.length ? c.warn.join('・') : 'なし'}`
        + ('riskPips' in c ? `／損切り幅 ${signedWidth(c.riskPips)}・利確幅 ${signedWidth(c.rewardPips)}` : ''),
      run: () => {
        const { rr, warn } = calcRiskReward(c);
        // RR は ×100 の整数で比べる（fx-rules 9.5）
        const rrOk = toInt(rr, 100) === toInt(c.rr, 100);
        let actual = `RR ${rr == null ? 'null' : rr.toFixed(2)}／警告 ${warn.length ? warn.join('・') : 'なし'}`;
        let pass = rrOk && sameArray(warn, c.warn) && (rr === null || Number.isFinite(rr)); // NaN を RR として返さない（Y-12）
        // 9.2 の「損切り幅・利確幅」の列（T-18：architecture 13.3 #5）。資料に列があるケース（R-01〜R-09）だけ確かめる。pips は ×10 の整数で比べる
        if ('riskPips' in c) {
          const w = calcSlTpPips(c);
          actual += `／損切り幅 ${signedWidth(w.riskPips)}・利確幅 ${signedWidth(w.rewardPips)}`;
          pass = pass && toInt(w.riskPips, 10) === toInt(c.riskPips, 10) && toInt(w.rewardPips, 10) === toInt(c.rewardPips, 10);
        }
        return { actual, pass };
      },
    });
  }

  // ---- 9.3 勝ち／負け／引き分けの判定 ----
  for (const c of RESULT_CASES) {
    const t = c.trade;
    tests.push({
      category: '計算', id: c.id, title: c.title,
      input: `status ${t.status}・profitSource ${show(t.profitSource)}・profitJpy ${t.profitJpy == null ? 'null' : yen(t.profitJpy)}・deletedAt ${t.deletedAt ? 'あり' : 'なし'}`,
      expected: resultJa(c.expect),
      run: () => {
        const r = judgeResult(t);
        return { actual: resultJa(r), pass: r === c.expect };
      },
    });
  }

  return tests;
}

/** セッション（S・Z）のテスト定義 */
export function collectSessionTests() {
  return [...SESSION_CASES, ...EXTRA_SESSION_CASES].map((c) => ({
    category: 'セッション', id: c.id, title: c.title || `${c.period}`,
    input: `${typeof c.entryAt === 'string' && c.entryAt !== '' ? c.entryAt : show(c.entryAt)}（${c.week}・${c.period}）`,
    expected: show(c.expect),
    run: () => {
      const s = judgeSession(c.entryAt);
      return { actual: show(s), pass: s === c.expect };
    },
  }));
}
