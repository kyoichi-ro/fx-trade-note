/* =========================================================
   tests/calc.test.js
   js/calc.js のテスト。
     ・計算      fx-rules 9.1（C-01〜C-17）・9.2（R-01〜R-09）・9.3（J-01〜J-09）
     ・セッション fx-rules 11.8（S-01〜S-35）
     ・追加（2026-10-16）fx-rules 14.1 の追加のテストケース（X-xx・C-18〜C-20・Y-xx・Z-xx）
     ・追加（T-33：T-30 の R-01）極端な値で例外にならず null を返す（CB-01〜CB-03）
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

  // ---- T-33（R-01）：極端な値でも例外にならない（計算できないときは null） ----
  const tryCalc = (fn) => {
    try { return { value: fn() }; } catch (e) { return { error: e }; }
  };
  const base = { pair: 'USD/JPY', side: 'buy', entryPrice: 150, exitPrice: 150.25, lots: 1, lotUnitSize: 10000, quoteToJpyRate: null };
  tests.push({
    category: '計算', id: 'CB-01', title: '極端な価格（1e306・1e17）：pips・損益は null（例外・Infinity・無意味な値にしない）',
    input: 'エントリー 1e306／決済 1e17（USD/JPY 買い 1lot）', expected: 'pips null・損益 null（どちらも例外なし）',
    run: () => {
      const a = tryCalc(() => [calcPips({ ...base, entryPrice: 1e306 }).pips, calcProfitJpy({ ...base, entryPrice: 1e306 })]);
      const b = tryCalc(() => [calcPips({ ...base, exitPrice: 1e17 }).pips, calcProfitJpy({ ...base, exitPrice: 1e17 })]);
      const text = (r) => (r.error ? `例外：${r.error.message}` : r.value.map(show).join('・'));
      const ok = (r) => !r.error && r.value[0] === null && r.value[1] === null;
      return { actual: `${text(a)}／${text(b)}`, pass: ok(a) && ok(b) };
    },
  });
  tests.push({
    category: '計算', id: 'CB-02', title: '極端なロット・1lot・円換算レート：損益は null（BigInt の例外で止めない）',
    input: 'ロット 1e306／Infinity、1lot 0.5（整数でない）、EUR/USD で円換算レート 1e300', expected: 'すべて null（例外なし）。普通の値は従来どおり +2,500',
    run: () => {
      const r = tryCalc(() => [
        calcProfitJpy({ ...base, lots: 1e306 }),
        calcProfitJpy({ ...base, lots: Infinity }),
        calcProfitJpy({ ...base, lotUnitSize: 0.5 }),
        calcProfitJpy({ ...base, pair: 'EUR/USD', entryPrice: 1.1, exitPrice: 1.1025, quoteToJpyRate: 1e300 }),
        calcProfitJpy(base),
      ]);
      if (r.error) return { actual: `例外：${r.error.message}`, pass: false };
      return { actual: r.value.map(show).join('・'), pass: r.value.slice(0, 4).every((v) => v === null) && r.value[4] === 2500 };
    },
  });
  tests.push({
    category: '計算', id: 'CB-03', title: '極端な SL・TP：リスクリワード・損切り幅は null（NaN・例外にしない）',
    input: 'USD/JPY 買い エントリー 150・SL 1e306・TP 151', expected: 'RR null・警告なし・損切り幅 null',
    run: () => {
      const t = { pair: 'USD/JPY', side: 'buy', entryPrice: 150, slPrice: 1e306, tpPrice: 151 };
      const r = tryCalc(() => [calcRiskReward(t), calcSlTpPips(t)]);
      if (r.error) return { actual: `例外：${r.error.message}`, pass: false };
      const [rr, w] = r.value;
      return { actual: `RR ${show(rr.rr)}・警告 ${rr.warn.join('・') || 'なし'}・損切り幅 ${show(w.riskPips)}`, pass: rr.rr === null && rr.warn.length === 0 && w.riskPips === null };
    },
  });

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
