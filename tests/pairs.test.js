/* =========================================================
   tests/pairs.test.js
   通貨ペアのテスト（fx-rules 10.8 の P-01〜P-30。追加：fx-rules 14.1 の追加提案 P-31〜P-35）。
     ・js/master.js   getPairSpec / derivePairSpec / PAIR_MASTER（P-01〜P-05）
     ・js/validate.js normalizePairInput（P-06〜P-19）、isOutOfPriceRange（W-06。P-20〜P-30）
     ・js/format.js   formatPrice（P-20〜P-30）
   ========================================================= */
import { PAIR_MASTER, DEFAULT_FAVORITE_PAIRS, derivePairSpec, getPairSpec } from '../js/master.js';
import { normalizePairInput, isOutOfPriceRange } from '../js/validate.js';
import { formatPrice } from '../js/format.js';
import { PAIR_CASES, EXTRA_PAIR_CASES, PAIR_TABLE_10_3, DEFAULT_FAVORITES_FOR_TEST } from './cases.js';
import { sameArray, show } from './helpers.js';

/** pair・pipSize・priceDecimals・quoteToJpyPair を「USD/JPY・0.01・3桁・円換算 —」の形で表示 */
function specText(s) {
  return `${s.pair}・pip ${s.pipSize}・${s.priceDecimals}桁・円換算 ${s.quoteToJpyPair ?? '—'}`;
}

/** getPairSpec / normalizePairInput の結果が期待どおりか（P-01〜P-04・P-06〜P-19） */
function sameSpec(s, e) {
  // pipSize はコード内の定数（0.01 / 0.0001）をそのまま返すだけで計算していないので === で比べてよい
  return s.pair === e.pair && s.pipSize === e.pipSize && s.priceDecimals === e.priceDecimals
    && s.quoteToJpyPair === e.quoteToJpyPair;
}

/** P-05：マスタ19ペア全件を調べ、食い違いの説明を配列で返す（空なら全件一致） */
function checkMasterAll() {
  const problems = [];
  if (PAIR_MASTER.length !== PAIR_TABLE_10_3.length) {
    problems.push(`ペア数 ${PAIR_MASTER.length}（期待 ${PAIR_TABLE_10_3.length}）`);
  }
  PAIR_TABLE_10_3.forEach((row, i) => {
    const m = PAIR_MASTER[i];
    if (!m || m.pair !== row.pair) {
      problems.push(`${i + 1}番目が ${m ? m.pair : 'なし'}（期待 ${row.pair}。並び順も 10.3 のとおりであること）`);
      return;
    }
    // ① マスタ＋判定ルールの結果（getPairSpec）が 10.3 の表と一致すること
    const s = getPairSpec(row.pair);
    for (const key of Object.keys(row)) {
      if (s[key] !== row[key]) problems.push(`${row.pair} の ${key} が ${show(s[key])}（期待 ${show(row[key])}）`);
    }
    // ② 判定ルール（10.4 手順3）だけで求めた値とも一致すること（例外表に頼っていない＝ルールどおり）
    const d = derivePairSpec(row.pair);
    for (const key of ['isJpyPair', 'pipSize', 'priceDecimals', 'maxInputDecimals', 'pointScale', 'quoteToJpyPair']) {
      if (s[key] !== d[key]) problems.push(`${row.pair} の ${key}：マスタ ${show(s[key])}／判定ルール ${show(d[key])}`);
    }
    // ③ 常に成り立つ関係（10.2）：表示桁＝入力上限、pipSize＝10÷pointScale（1pip＝10ポイント）
    if (s.priceDecimals !== s.maxInputDecimals) problems.push(`${row.pair}：priceDecimals と maxInputDecimals が違う`);
    if (s.pipSize !== 10 / s.pointScale) problems.push(`${row.pair}：pipSize が 10÷pointScale と違う`);
    if (s.inMaster !== true) problems.push(`${row.pair}：inMaster が true でない`);
  });
  // ④ よく使う通貨ペアの初期値＝マスタの先頭6ペア（10.3。高金利通貨を含まない）
  if (!sameArray([...DEFAULT_FAVORITE_PAIRS], DEFAULT_FAVORITES_FOR_TEST)) {
    problems.push(`よく使う通貨ペアの初期値が ${show([...DEFAULT_FAVORITE_PAIRS])}`);
  }
  return problems;
}

function runPairCase(c) {
  const e = c.expect;
  switch (c.kind) {
    case 'spec': {
      const s = getPairSpec(c.input);
      return { actual: `OK：${specText(s)}`, pass: sameSpec(s, e) };
    }
    case 'master': {
      const problems = checkMasterAll();
      return {
        actual: problems.length ? `不一致 ${problems.length}件：${problems.join('／')}` : '全件一致（19ペア）',
        pass: problems.length === 0,
      };
    }
    case 'normalize': {
      const r = normalizePairInput(c.input, DEFAULT_FAVORITES_FOR_TEST);
      if (!r.ok) {
        return {
          actual: `エラー ${r.error}・pair ${r.pair ?? '—'}`,
          pass: !e.ok && r.error === e.error && (r.pair ?? null) === e.pair,
        };
      }
      const warnText = r.warn.length ? `・警告 ${r.warn.join('・')}` : '';
      return {
        actual: `OK：${specText(r.spec)}${warnText}`,
        pass: e.ok === true && r.pair === e.pair && sameSpec(r.spec, e) && sameArray(r.warn, e.warn),
      };
    }
    case 'normalizeMulti': {
      // 1つの ID に入力が複数ある追加提案（P-31〜P-35）。1つ1つを 'normalize' と同じく調べ、全部一致で合格
      const rows = c.items.map((it) => runPairCase({ kind: 'normalize', input: it.input, expect: it.expect }));
      return { actual: rows.map((r) => r.actual).join(' ／ '), pass: rows.every((r) => r.pass) };
    }
    case 'display': {
      const text = formatPrice(c.price, c.pair);
      const w06 = isOutOfPriceRange(c.price, c.pair);
      return { actual: `${show(text)}・W-06 ${w06 ? 'あり' : 'なし'}`, pass: text === e.text && w06 === e.w06 };
    }
    default:
      throw new Error(`未対応の kind：${c.kind}`);
  }
}

function expectedText(c) {
  const e = c.expect;
  switch (c.kind) {
    case 'spec': return `OK：${specText(e)}`;
    case 'master': return '全件一致（19ペア）';
    case 'normalize':
      if (!e.ok) return `エラー ${e.error}・pair ${e.pair ?? '—'}`;
      return `OK：${specText(e)}${e.warn.length ? `・警告 ${e.warn.join('・')}` : ''}`;
    case 'display': return `${show(e.text)}・W-06 ${e.w06 ? 'あり' : 'なし'}`;
    case 'normalizeMulti':
      return c.items.map((it) => expectedText({ kind: 'normalize', expect: it.expect })).join(' ／ ');
    default: return '';
  }
}

function inputText(c) {
  if (c.kind === 'display') return `${c.pair}・価格 ${c.price}`;
  if (c.kind === 'master') return c.input;
  if (c.kind === 'normalizeMulti') return c.items.map((it) => show(it.input)).join(' ／ ');
  return show(c.input);
}

export function collectPairTests() {
  return [...PAIR_CASES, ...EXTRA_PAIR_CASES].map((c) => ({
    category: '通貨ペア', id: c.id, title: c.title,
    input: inputText(c),
    expected: expectedText(c),
    run: () => runPairCase(c),
  }));
}
