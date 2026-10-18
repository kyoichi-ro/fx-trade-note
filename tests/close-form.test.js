/* =========================================================
   tests/close-form.test.js
   決済記録画面の「画面に依存しない部分」のテスト（T-21。design.md 14.2、fx-rules 4.4・4.5・8章）。
     ・js/close-form.js … 入力欄の初期値・下書きの読み込み・損益の表示・入力チェック（E-xx・W-xx）・符号付きの貼り付け
     ・js/trades.js の computeClose / buildClosedTrade / buildReopenedTrade … 決済した記録・決済を取り消した記録の組み立て
     ・js/row-flash.js … 一覧に戻った直後のハイライトの受け渡し
   画面（document）も IndexedDB も使わないので、Node.js でもブラウザでも実行する。
   保存・取り消しの DB 処理（closeTrade・reopenTrade）は tests/db.test.js の SV-12〜SV-14（ブラウザのみ）。

   ID：CL-xx（決済画面）、FL-xx（ハイライトの受け渡し）
   ========================================================= */
import {
  defaultCloseFields, fieldsFromCloseDraft, isCloseFormChanged, detailsSummary, closeSaveLabel, closeToastText,
  initialManualSign, splitSignedAmount, resolveManualProfit, formatAmountText, tidyAmount, evaluateClose, describeProfit,
  speakProfit, closeInputFromEvaluation, closeLotUnitNote,
} from '../js/close-form.js';
import { computeClose, buildClosedTrade, buildReopenedTrade, recompute } from '../js/trades.js';
import { TRADE_KEYS } from '../js/db.js';
import { requestRowFlash, takeRowFlash, FLASH_WAIT_MS } from '../js/row-flash.js';
import { show } from './helpers.js';

const CATEGORY = '決済画面';

/** 「今」＝ 2026-10-15（木）23:30（日本時間）。E-10 の文の日付の「今年」判定に使う */
const NOW = new Date('2026-10-15T23:30:00+09:00');

function verdict(checks) {
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) return { actual: `確認${checks.length}項目すべて一致`, pass: true };
  return { actual: failed.map(([label, , detail]) => `×${label}（実際：${show(detail)}）`).join('／'), pass: false };
}

const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run });

/** 保有中の記録：USD/JPY 買い 1lot（1lot＝10,000通貨）150.000、エントリー 10/15 21:30 */
function openTrade(extra = {}) {
  const base = {};
  for (const k of TRADE_KEYS) base[k] = null;
  return {
    ...base,
    id: 'trade-1', accountType: 'real', pair: 'USD/JPY', side: 'buy', entryPrice: 150, entryAt: '2026-10-15T21:30:00+09:00',
    lots: 1, lotUnitSize: 10000, slPrice: 149.8, tpPrice: 150.4, riskReward: 2, status: 'open', session: 'newyork',
    entryReasons: ['トレンドフォロー'], tags: ['指標前'], memo: 'NY開始直後の上抜け', imageIds: ['img-1'],
    syncStatus: 'pending', createdAt: '2026-10-15T21:31:00+09:00', updatedAt: '2026-10-15T21:31:00+09:00',
    ...extra,
  };
}

/** 非JPYペア：EUR/USD 買い 1lot 1.08500 */
const eurUsd = (extra = {}) => openTrade({ pair: 'EUR/USD', entryPrice: 1.085, slPrice: null, tpPrice: null, riskReward: null, ...extra });

/** 入力欄の値（初期値に上書き） */
function fieldsOf(trade, over = {}) {
  return { ...defaultCloseFields(trade, '2026-10-15T23:05'), ...over };
}

const evalOf = (trade, over = {}) => evaluateClose(trade, fieldsOf(trade, over), { now: NOW });
const issueTexts = (ev, field) => ev.issues.filter((i) => !field || i.field === field).map((i) => `${i.field}/${i.type}/${i.text}`);

export function collectCloseFormTests() {
  return [
    t('CL-01', '初期値：決済価格・円換算レートは空、日時は開いた時刻、タグ・メモはエントリー時の内容', 'DV と同じ USD/JPY 保有中（tags=指標前・memo あり）／決済理由が残っている記録',
      "exitPrice=''・quoteToJpyRate=''・exitAt=渡した値・auto・tags=['指標前']・memo そのまま・理由なし。残っている決済理由・感情は入る",
      () => {
        const f = defaultCloseFields(openTrade(), '2026-10-15T23:05');
        const g = defaultCloseFields(openTrade({ exitReason: 'sl', exitEmotion: '焦り', tags: ['a'], memo: null }), 'x');
        return verdict([
          ['決済価格・レートは空', f.exitPrice === '' && f.quoteToJpyRate === '', `${f.exitPrice}/${f.quoteToJpyRate}`],
          ['日時', f.exitAt === '2026-10-15T23:05', f.exitAt],
          ['自動計算・符号＋・金額なし', f.profitMode === 'auto' && f.manualSign === '+' && f.manualAmount === '', `${f.profitMode}/${f.manualSign}/${f.manualAmount}`],
          ['タグ・メモを引き継ぐ', f.tags.join() === '指標前' && f.memo === 'NY開始直後の上抜け', `${f.tags}/${f.memo}`],
          ['理由・感情は空', f.exitReason === '' && f.exitEmotion === '', `${f.exitReason}/${f.exitEmotion}`],
          ['残っている理由・感情を入れる', g.exitReason === 'sl' && g.exitEmotion === '焦り', `${g.exitReason}/${g.exitEmotion}`],
          ['メモが null なら空文字', g.memo === '', g.memo],
          ['タグは別の配列（書き換えても記録に響かない）', (() => { const tr = openTrade(); const d = defaultCloseFields(tr, 'x'); d.tags.push('z'); return tr.tags.length === 1; })()],
        ]);
      }),

    t('CL-02', '下書きの読み込み：知っている項目だけ取り出す（壊れた項目は初期値のまま）', 'exitPrice=数値・profitMode="x"・exitReason="zzz"・tags 混在・正しい exitAt/manualAmount',
      '正しい項目だけ反映し、壊れた項目は初期値。tags は文字だけ・重複なし',
      () => {
        const d = fieldsOf(openTrade());
        const draft = {
          fields: {
            exitPrice: 150.25, exitAt: '2026-10-15T22:00', profitMode: 'x', manualSign: '-', manualAmount: '5700',
            exitReason: 'zzz', exitEmotion: '冷静', tags: ['a', 1, 'a', null, 'b'], memo: 'メモ',
          },
        };
        const f = fieldsFromCloseDraft(draft, d);
        const g = fieldsFromCloseDraft(null, d);
        const h = fieldsFromCloseDraft({ fields: { profitMode: 'manual', exitReason: 'tp' } }, d);
        return verdict([
          ['数値の exitPrice は無視', f.exitPrice === '', f.exitPrice],
          ['正しい日時・金額・符号', f.exitAt === '2026-10-15T22:00' && f.manualAmount === '5700' && f.manualSign === '-', `${f.exitAt}/${f.manualAmount}/${f.manualSign}`],
          ['壊れた profitMode は初期値', f.profitMode === 'auto', f.profitMode],
          ['知らない決済理由は初期値', f.exitReason === '', f.exitReason],
          ['タグは文字だけ・重複なし', f.tags.join() === 'a,b', f.tags],
          ['感情・メモ', f.exitEmotion === '冷静' && f.memo === 'メモ', `${f.exitEmotion}/${f.memo}`],
          ['下書きなしは初期値のコピー', g.exitAt === d.exitAt && g.tags !== d.tags, g.exitAt],
          ['手入力モード・決済理由 tp', h.profitMode === 'manual' && h.exitReason === 'tp', `${h.profitMode}/${h.exitReason}`],
        ]);
      }),

    t('CL-03', '「変更あり」の判定：開いただけ・手入力を開いただけでは変更なし', '初期値／確定損益の入力を開いただけ／価格・メモ・タグを変更',
      '前の2つは false、変更したら true',
      () => {
        const tr = openTrade();
        const init = defaultCloseFields(tr, '2026-10-15T23:05');
        const same = fieldsOf(tr);
        const openedManual = fieldsOf(tr, { profitMode: 'manual', manualSign: '-' });
        const changedIf = (over) => isCloseFormChanged(init, fieldsOf(tr, over));
        return verdict([
          ['初期値のまま', isCloseFormChanged(init, same) === false],
          ['確定損益を開いただけ（金額が空）', isCloseFormChanged(init, openedManual) === false],
          ['決済価格', changedIf({ exitPrice: '150.2' }) === true],
          ['日時', changedIf({ exitAt: '2026-10-15T23:06' }) === true],
          ['手入力の金額', changedIf({ profitMode: 'manual', manualAmount: '100' }) === true],
          ['メモ', changedIf({ memo: 'x' }) === true],
          ['タグ', changedIf({ tags: [] }) === true],
          ['タグを外して付け直した（順番だけ違う）は変更なし', isCloseFormChanged(defaultCloseFields(openTrade({ tags: ['a', 'b'] }), 'x'), fieldsOf(openTrade({ tags: ['a', 'b'] }), { exitAt: 'x', tags: ['b', 'a'] })) === false],
          ['決済理由', changedIf({ exitReason: 'tp' }) === true],
        ]);
      }),

    t('CL-04', '損益の即時計算：JPYペア・買い・利益／売り・損失', 'USD/JPY 買い 150.000→150.250 1lot／売り 150.000→150.285 0.5lot',
      '＋25.0 pips・＋2,500円（auto）／−28.5 pips・−1,425円（auto）。calc.js と同じ結果',
      () => {
        const win = evalOf(openTrade(), { exitPrice: '150.250' });
        const loss = evalOf(openTrade({ side: 'sell', lots: 0.5 }), { exitPrice: '150.285' });
        return verdict([
          ['買い・利益の pips', win.pips === 25, win.pips],
          ['買い・利益の円', win.profitJpy === 2500 && win.profitSource === 'auto', `${win.profitJpy}/${win.profitSource}`],
          ['売り・損失の pips', loss.pips === -28.5, loss.pips],
          ['売り・損失の円', loss.profitJpy === -1425 && loss.profitSource === 'auto', `${loss.profitJpy}/${loss.profitSource}`],
          ['エラーなし', win.hasError === false && loss.hasError === false, `${win.hasError}/${loss.hasError}`],
        ]);
      }),

    t('CL-05', '損益の即時計算：非JPYペア（円換算レート）。レートが空なら円は計算せず pips だけ', 'EUR/USD 買い 1.08500→1.08750・レート 149.850／空',
      '＋25.0 pips・＋3,746円（design 14.2.4 の例）／円は null・pips は ＋25.0・保存時に E-11',
      () => {
        const withRate = evalOf(eurUsd(), { exitPrice: '1.08750', quoteToJpyRate: '149.850' });
        const noRate = evalOf(eurUsd(), { exitPrice: '1.08750' });
        return verdict([
          ['レートあり：pips', withRate.pips === 25, withRate.pips],
          ['レートあり：円', withRate.profitJpy === 3746 && withRate.profitSource === 'auto', `${withRate.profitJpy}/${withRate.profitSource}`],
          ['レートなし：円は空', noRate.profitJpy === null && noRate.profitSource === null, `${noRate.profitJpy}/${noRate.profitSource}`],
          ['レートなし：pips は出る', noRate.pips === 25, noRate.pips],
          ['レートなし：E-11（保存を押したときだけ出す欄 profitNeed）', issueTexts(noRate).join() === 'profitNeed/error/円換算レートか確定損益のどちらかを入力してください', issueTexts(noRate)],
          ['レートなし：自動計算に戻せない', noRate.canReturnToAuto === false, noRate.canReturnToAuto],
          ['レートあり：戻せる', withRate.canReturnToAuto === true, withRate.canReturnToAuto],
        ]);
      }),

    t('CL-06', '記録時の 1lot の通貨数（lotUnitSize）で計算する（設定画面で変えた値は使わない）', 'lotUnitSize=50000 の記録 150.000→150.250 1lot',
      '＋12,500円（10,000通貨なら2,500円）',
      () => {
        const ev = evalOf(openTrade({ lotUnitSize: 50000 }), { exitPrice: '150.250' });
        return verdict([['円', ev.profitJpy === 12500, ev.profitJpy]]);
      }),

    t('CL-07', '決済価格のチェック：必須・E-01〜E-04（文言は design 14.2.9）', "''／'abc'／'0'／JPY '150.2345'／非JPY '1.234567'／途中の '150.'",
      '必須・E-01・E-02・E-03・E-04 の文言。「150.」は数値として読めて計算する。エラーのときは pips・円を出さない',
      () => {
        const first = (trade, price) => evalOf(trade, { exitPrice: price }).issues.find((i) => i.field === 'exitPrice');
        const mid = evalOf(openTrade(), { exitPrice: '150.' });
        const bad = evalOf(openTrade(), { exitPrice: 'abc' });
        return verdict([
          ['必須', first(openTrade(), '').text === '決済価格を入力してください', first(openTrade(), '').text],
          ['E-01', first(openTrade(), 'abc').text === '決済価格：数値で入力してください', first(openTrade(), 'abc').text],
          ['E-02', first(openTrade(), '0').text === '決済価格：0より大きい値を入力してください', first(openTrade(), '0').text],
          ['E-03', first(openTrade(), '150.2345').text === '決済価格：価格は小数第3位までで入力してください', first(openTrade(), '150.2345').text],
          ['E-04', first(eurUsd(), '1.234567').text === '決済価格：価格は小数第5位までで入力してください', first(eurUsd(), '1.234567').text],
          ['途中の「150.」は計算する', mid.exitReady === true && mid.pips === 0, `${mid.exitReady}/${mid.pips}`],
          ['エラーのとき計算しない', bad.pips === null && bad.profitJpy === null && bad.exitReady === false, `${bad.pips}/${bad.profitJpy}`],
        ]);
      }),

    t('CL-08', '警告 W-02（価格の差が10%以上）・W-06（価格帯の目安から外れている）：保存は止めない', 'USD/JPY エントリー 150.000・決済 15.025',
      '警告2件（エラーなし）。文言は design 14.2.9。正常な価格なら警告なし',
      () => {
        const ev = evalOf(openTrade(), { exitPrice: '15.025' });
        const ok = evalOf(openTrade(), { exitPrice: '150.250' });
        return verdict([
          ['エラーなし', ev.hasError === false, ev.hasError],
          ['W-02', ev.issues.some((i) => i.type === 'warning' && i.text === '価格の差が大きすぎます。桁や通貨ペアの間違いがないか確認してください。'), issueTexts(ev)],
          ['W-06', ev.issues.some((i) => i.type === 'warning' && i.text === '決済価格：USD/JPY の価格としては大きく外れています。通貨ペアと桁を確認してください。'), issueTexts(ev)],
          ['正常なら警告なし', ok.issues.length === 0, issueTexts(ok)],
        ]);
      }),

    t('CL-09', 'E-10：決済日時がエントリー日時より前／同時刻は可／日時が空', 'エントリー 10/15 21:30 に対して 21:29／21:30／空',
      "「決済日時がエントリー日時（10/15 21:30）より前になっています」／エラーなし／「日時を入力してください」",
      () => {
        const before = evalOf(openTrade(), { exitPrice: '150.1', exitAt: '2026-10-15T21:29' });
        const same = evalOf(openTrade(), { exitPrice: '150.1', exitAt: '2026-10-15T21:30' });
        const empty = evalOf(openTrade(), { exitPrice: '150.1', exitAt: '' });
        const e10 = before.issues.find((i) => i.field === 'exitAt');
        const e0 = empty.issues.find((i) => i.field === 'exitAt');
        return verdict([
          ['21:29', e10 && e10.type === 'error' && e10.text === '決済日時がエントリー日時（10/15 21:30）より前になっています', e10 && e10.text],
          ['21:30 は可', same.hasError === false, issueTexts(same)],
          ['空', e0 && e0.text === '日時を入力してください', e0 && e0.text],
        ]);
      }),

    t('CL-10', 'E-08：円換算レートが数値でない／0以下／小数第4位以下。JPYペアには円換算レートの欄がなく無視する', "EUR/USD レート 'abc'／'0'／'149.8505'／'149.85'。USD/JPY にレートが残っていても",
      "E-08 の文言（E-11 は重ねて出さない）／正しいレートはエラーなし／JPYペアは無視",
      () => {
        const msg = '円換算レートは0より大きい値（小数第3位まで）で入力してください';
        const run = (rate) => evalOf(eurUsd(), { exitPrice: '1.0875', quoteToJpyRate: rate });
        const bad = run('abc');
        const jpy = evalOf(openTrade(), { exitPrice: '150.25', quoteToJpyRate: 'abc' });
        return verdict([
          ['abc', issueTexts(bad, 'quoteToJpyRate').join() === `quoteToJpyRate/error/${msg}`, issueTexts(bad)],
          ['E-11 は重ねない', !bad.issues.some((i) => i.field === 'profitNeed'), issueTexts(bad)],
          ['0', run('0').issues.some((i) => i.field === 'quoteToJpyRate'), issueTexts(run('0'))],
          ['小数第4位', run('149.8505').issues.some((i) => i.field === 'quoteToJpyRate'), issueTexts(run('149.8505'))],
          ['正しいレート', run('149.85').hasError === false, issueTexts(run('149.85'))],
          ['JPYペアは無視', jpy.hasError === false && jpy.profitJpy === 2500, `${jpy.hasError}/${jpy.profitJpy}`],
        ]);
      }),

    t('CL-11', '確定損益の手入力：符号×金額で上書き（manual）。自動計算値は参考として残る。pips と符号が逆なら W-05', 'JPY 買い＋25.0pips・自動＋2,500円。手入力 −1,240／＋1,240',
      "−1,240：profitJpy=-1240・manual・autoProfitJpy=2500・W-05。＋1,240：W-05 なし",
      () => {
        const minus = evalOf(openTrade(), { exitPrice: '150.250', profitMode: 'manual', manualSign: '-', manualAmount: '1240' });
        const plus = evalOf(openTrade(), { exitPrice: '150.250', profitMode: 'manual', manualSign: '+', manualAmount: '1240' });
        const w05 = 'pips と損益（円）のプラス・マイナスが逆です。スワップや手数料の影響であればこのままで問題ありません。';
        return verdict([
          ['−1,240 の値', minus.profitJpy === -1240 && minus.profitSource === 'manual', `${minus.profitJpy}/${minus.profitSource}`],
          ['自動計算（参考）は残る', minus.autoProfitJpy === 2500, minus.autoProfitJpy],
          ['W-05（警告・保存は止めない）', minus.hasError === false && minus.issues.some((i) => i.field === 'manualProfit' && i.type === 'warning' && i.text === w05), issueTexts(minus)],
          ['＋1,240 は W-05 なし', plus.profitJpy === 1240 && plus.issues.length === 0, `${plus.profitJpy}/${issueTexts(plus)}`],
        ]);
      }),

    t('CL-12', '手入力モードでも金額が空なら上書きしない（自動計算のまま）。0 は符号に関係なく 0円', '手入力・金額なし／符号「−」で金額 0',
      '自動計算の値・auto／0（-0 にならない）・manual',
      () => {
        const empty = evalOf(openTrade(), { exitPrice: '150.250', profitMode: 'manual', manualSign: '-', manualAmount: '' });
        const zero = evalOf(openTrade(), { exitPrice: '150.250', profitMode: 'manual', manualSign: '-', manualAmount: '0' });
        return verdict([
          ['空は自動のまま', empty.profitJpy === 2500 && empty.profitSource === 'auto' && empty.manualValue === null, `${empty.profitJpy}/${empty.profitSource}`],
          ['0 は 0（-0 でない）', Object.is(zero.profitJpy, 0) && zero.profitSource === 'manual', Object.is(zero.profitJpy, -0) ? '-0' : zero.profitJpy],
        ]);
      }),

    t('CL-13', 'E-09：確定損益が整数でない（小数・文字・金額欄に残った符号）', "'12.5'／'abc'／'1234.0'／sign=+ で '-5'",
      "どれも E-09「損益（円）は整数で入力してください」で保存不可",
      () => {
        const run = (amount, sign = '+') => evalOf(openTrade(), { exitPrice: '150.250', profitMode: 'manual', manualSign: sign, manualAmount: amount });
        const msg = '損益（円）は整数で入力してください';
        const cases = [['12.5'], ['abc'], ['1234.0'], ['-5'], ['--5', '-'], ['+-5']];
        return verdict(cases.map(([a, s]) => {
          const ev = run(a, s);
          const i = ev.issues.find((x) => x.field === 'manualProfit');
          return [`'${a}'`, ev.hasError && i && i.type === 'error' && i.text === msg, issueTexts(ev)];
        }));
      }),

    t('CL-14', '非JPYペアは円換算レートなしでも、確定損益を入れれば保存できる（E-11 なし）', 'EUR/USD レート空・手入力 ＋3,700',
      'エラーなし・manual・円換算レートは空のまま',
      () => {
        const ev = evalOf(eurUsd(), { exitPrice: '1.0875', profitMode: 'manual', manualSign: '+', manualAmount: '3700' });
        const input = closeInputFromEvaluation(ev, fieldsOf(eurUsd(), { exitPrice: '1.0875' }));
        return verdict([
          ['エラーなし', ev.hasError === false && !ev.issues.some((i) => i.field === 'profitNeed'), issueTexts(ev)],
          ['manual', ev.profitJpy === 3700 && ev.profitSource === 'manual', `${ev.profitJpy}/${ev.profitSource}`],
          ['レートは null', input.quoteToJpyRate === null, input.quoteToJpyRate],
        ]);
      }),

    t('CL-15', '損益の欄の表示（design 14.2.7）：4つの状態と手入力', '価格なし／非JPYでレートなし／JPY 利益・損失／手入力（戻せる・戻せない）',
      "「—」＋「決済価格を入れると計算します」／「—」＋「円換算レートか確定損益を入力」＋pips／＋2,500円(profit)・＋25.0 pips／−…(loss)／手入力は参考値と戻す方法",
      () => {
        const none = describeProfit(evalOf(openTrade()), fieldsOf(openTrade()));
        const needRate = describeProfit(evalOf(eurUsd(), { exitPrice: '1.0875' }), fieldsOf(eurUsd(), { exitPrice: '1.0875' }));
        const win = describeProfit(evalOf(openTrade(), { exitPrice: '150.250' }), fieldsOf(openTrade(), { exitPrice: '150.250' }));
        const lossF = fieldsOf(openTrade(), { exitPrice: '149.885' });
        const loss = describeProfit(evalOf(openTrade(), { exitPrice: '149.885' }), lossF);
        const evenF = fieldsOf(openTrade(), { exitPrice: '150.000' });
        const even = describeProfit(evalOf(openTrade(), { exitPrice: '150.000' }), evenF);
        const mF = fieldsOf(openTrade(), { exitPrice: '150.250', profitMode: 'manual' });
        const manual = describeProfit(evalOf(openTrade(), { exitPrice: '150.250', profitMode: 'manual' }), mF);
        const mNoRateF = fieldsOf(eurUsd(), { exitPrice: '1.0875', profitMode: 'manual' });
        const mNoRate = describeProfit(evalOf(eurUsd(), { exitPrice: '1.0875', profitMode: 'manual' }), mNoRateF);
        return verdict([
          ['価格なし', none.main.text === '—' && none.main.tone === 'none' && none.hint === '決済価格を入れると計算します' && none.pips === null, JSON.stringify(none)],
          ['レートなし', needRate.main.text === '—' && needRate.hint === '円換算レートか確定損益を入力' && needRate.pips.text === '＋25.0 pips', JSON.stringify(needRate)],
          ['利益', win.main.text === '＋2,500円' && win.main.tone === 'profit' && win.pips.text === '＋25.0 pips' && win.pips.tone === 'profit' && win.hint === null, JSON.stringify(win)],
          ['損失', loss.main.text === '−1,150円' && loss.main.tone === 'loss' && loss.pips.text === '−11.5 pips', JSON.stringify(loss)],
          ['ゼロ', even.main.text === '±0円' && even.main.tone === 'even' && even.pips.text === '±0.0 pips', JSON.stringify(even)],
          ['手入力：参考値・戻す', manual.mode === 'manual' && manual.ref === '＋2,500円' && manual.back === 'button' && manual.pips.text === '＋25.0 pips', JSON.stringify(manual)],
          ['手入力：レートなしは戻せない', mNoRate.back === 'note' && mNoRate.ref === '—', JSON.stringify(mNoRate)],
        ]);
      }),

    t('CL-16', '符号付きの貼り付け（宿題）：符号に合わせて切替を変え、金額欄には数字だけを残す', "'−5,700'（U+2212）／'+2,480'／'－５，７００'／'＋２，４８０'／符号なし",
      "−5,700→{-,5700}・+2,480→{+,2480}・全角も同じ。符号なしは切替そのまま（切替「−」で '5,700'→{-,5700}）",
      () => {
        const r = (text, sign) => splitSignedAmount(text, sign);
        const eq = (a, sign, amount) => a.sign === sign && a.amount === amount;
        return verdict([
          ["切替＋で '−5,700'", eq(r('−5,700', '+'), '-', '5700'), r('−5,700', '+')],
          ["切替−で '+2,480'", eq(r('+2,480', '-'), '+', '2480'), r('+2,480', '-')],
          ["切替−で '−5,700'（二重にしない）", eq(r('−5,700', '-'), '-', '5700'), r('−5,700', '-')],
          ["半角ハイフン '-5700'", eq(r('-5700', '+'), '-', '5700'), r('-5700', '+')],
          ["全角 '－５，７００'", eq(r('－５，７００', '+'), '-', '5700'), r('－５，７００', '+')],
          ["全角 '＋２，４８０'", eq(r('＋２，４８０', '-'), '+', '2480'), r('＋２，４８０', '-')],
          ['前後の空白', eq(r('  −5,700 ', '+'), '-', '5700'), r('  −5,700 ', '+')],
          ["符号なし・切替＋", eq(r('5,700', '+'), '+', '5700'), r('5,700', '+')],
          ["符号なし・切替−（−5,700 のまま）", eq(r('5,700', '-'), '-', '5700'), r('5,700', '-')],
          ["空", eq(r('', '-'), '-', ''), r('', '-')],
          ["「-」だけ", eq(r('-', '+'), '-', ''), r('-', '+')],
          ["「+」だけは符号とみなさない", eq(r('+', '-'), '-', '+'), r('+', '-')],
        ]);
      }),

    t('CL-17', '貼り付けた値で保存される損益：切替＝−のとき「−5,700」を貼っても −5,700（＋5,700 にならない）', "切替「−」に '−5,700'／切替「＋」に '−5,700'／重なった符号 '--5'・'+-5'",
      '−5700・−5700・E-09',
      () => {
        const apply = (text, sign) => {
          const s = splitSignedAmount(text, sign);
          return resolveManualProfit({ profitMode: 'manual', manualSign: s.sign, manualAmount: s.amount });
        };
        const a = apply('−5,700', '-');
        const b = apply('−5,700', '+');
        const c = apply('--5', '+');
        const d = apply('+-5', '+');
        const e = apply('+2,480', '-');
        return verdict([
          ['切替−に −5,700', a.ok === true && a.value === -5700, a],
          ['切替＋に −5,700', b.ok === true && b.value === -5700, b],
          ["'--5' は E-09", c.ok === false && c.error === 'E-09', c],
          ["'+-5' は E-09", d.ok === false && d.error === 'E-09', d],
          ['切替−に +2,480', e.ok === true && e.value === 2480, e],
          ['自動計算モードは empty', resolveManualProfit({ profitMode: 'auto', manualSign: '-', manualAmount: '5' }).empty === true],
        ]);
      }),

    t('CL-18', '金額欄の表示：離れたら 3桁区切り、編集中は数字だけ。先頭の0は除く', "'1240'→'1,240'／'007'→'7'／'12.5'・'abc'・''",
      "'1,240'／'7'／そのまま",
      () => verdict([
        ['3桁区切り', formatAmountText('1240') === '1,240' && formatAmountText('1234567') === '1,234,567', formatAmountText('1240')],
        ['3桁未満', formatAmountText('240') === '240' && formatAmountText('0') === '0', formatAmountText('240')],
        ['整数でないものはそのまま', formatAmountText('12.5') === '12.5' && formatAmountText('abc') === 'abc' && formatAmountText('') === '', formatAmountText('12.5')],
        ['先頭の0を除く', tidyAmount('007') === '7' && tidyAmount('0') === '0', tidyAmount('007')],
        ['整数でないものはそのまま（tidy）', tidyAmount('12.5') === '12.5' && tidyAmount('') === '', tidyAmount('12.5')],
      ])),

    t('CL-19', '「確定損益を入力」を開いたときの符号の初期値と、詳細（任意）を閉じたときの 2 行目', 'pips −0.5／0／＋1／null。値の入った項目',
      "「−」／「＋」／「＋」／「＋」。入力済みなら「タグ、メモ 入力済み」、空なら '決済理由、感情、タグ、メモ、画像'",
      () => {
        const base = { exitReason: '', exitEmotion: '', tags: [], memo: '' };
        return verdict([
          ['pips<0 は −', initialManualSign(-0.5) === '-'],
          ['pips=0 は ＋', initialManualSign(0) === '+'],
          ['pips>0 は ＋', initialManualSign(1) === '+'],
          ['pips なしは ＋', initialManualSign(null) === '+'],
          ['空', detailsSummary(base) === '決済理由、感情、タグ、メモ、画像', detailsSummary(base)],
          ['画像だけ（T-24）', detailsSummary(base, 2) === '画像 入力済み', detailsSummary(base, 2)],
          ['タグ・メモ', detailsSummary({ ...base, tags: ['a'], memo: 'x' }) === 'タグ、メモ 入力済み', detailsSummary({ ...base, tags: ['a'], memo: 'x' })],
          ['全部', detailsSummary({ exitReason: 'tp', exitEmotion: '冷静', tags: ['a'], memo: 'x' }) === '決済理由、感情、タグ、メモ 入力済み'],
        ]);
      }),

    t('CL-20', '保存ボタンの文字（口座付き）とトースト', '本番／デモ／不明。損益 ＋1,265／−1,885／0／null',
      "「本番の決済を保存」「デモの決済を保存」「決済を保存」。「決済を保存しました ＋1,265円」…",
      () => verdict([
        ['本番', closeSaveLabel('real') === '本番の決済を保存', closeSaveLabel('real')],
        ['デモ', closeSaveLabel('demo') === 'デモの決済を保存', closeSaveLabel('demo')],
        ['不明は雛形', closeSaveLabel(null) === '決済を保存', closeSaveLabel(null)],
        ['トースト：利益', closeToastText(1265) === '決済を保存しました ＋1,265円', closeToastText(1265)],
        ['トースト：損失', closeToastText(-1885) === '決済を保存しました −1,885円', closeToastText(-1885)],
        ['トースト：ゼロ', closeToastText(0) === '決済を保存しました ±0円', closeToastText(0)],
        ['トースト：損益なし', closeToastText(null) === '決済を保存しました', closeToastText(null)],
      ])),

    t('CL-21', '保存する入力の組み立て：空の理由・感情は null、空白だけのメモは null、レート・手入力は評価結果から', 'JPY 買い＋手入力 −100・理由 tp・感情なし・メモ空白・タグ2つ',
      'exitPrice=150.25・exitAt=保存形式・manualProfitJpy=-100・exitReason=tp・exitEmotion=null・memo=null・tags コピー',
      () => {
        const f = fieldsOf(openTrade(), { exitPrice: '150.250', exitAt: '2026-10-15T23:05', profitMode: 'manual', manualSign: '-', manualAmount: '100', exitReason: 'tp', memo: '   ', tags: ['a', 'b'] });
        const ev = evaluateClose(openTrade(), f, { now: NOW });
        const input = closeInputFromEvaluation(ev, f);
        const f2 = fieldsOf(openTrade(), { exitPrice: '150.250', memo: '本文' });
        const input2 = closeInputFromEvaluation(evaluateClose(openTrade(), f2, { now: NOW }), f2);
        return verdict([
          ['価格・日時', input.exitPrice === 150.25 && input.exitAt === '2026-10-15T23:05:00+09:00', `${input.exitPrice}/${input.exitAt}`],
          ['手入力', input.manualProfitJpy === -100, input.manualProfitJpy],
          ['理由・感情', input.exitReason === 'tp' && input.exitEmotion === null, `${input.exitReason}/${input.exitEmotion}`],
          ['メモ（空白だけは null）', input.memo === null && input2.memo === '本文', `${input.memo}/${input2.memo}`],
          ['タグはコピー', input.tags.join() === 'a,b' && input.tags !== f.tags, input.tags],
          ['手入力なしは null', input2.manualProfitJpy === null, input2.manualProfitJpy],
        ]);
      }),

    t('CL-22', '読み上げ用の損益の文：計算できるときだけ。価格が読めないときは空', '+2,500円・+25.0pips／価格なし',
      "'損益 プラス2,500円、プラス25.0 pips'／''",
      () => {
        const ok = speakProfit(evalOf(openTrade(), { exitPrice: '150.250' }));
        const none = speakProfit(evalOf(openTrade()));
        return verdict([
          ['計算できる', ok === '損益 プラス2,500円、プラス25.0 pips', ok],
          ['価格なし', none === '', none],
        ]);
      }),

    t('CL-23', 'computeClose：自動計算／手入力の上書き（自動計算値は残る）／計算できない', 'USD/JPY 150.000→150.250／手入力 −100／EUR/USD レートなし',
      "{25, 2500, 2500, auto}／{25, 2500, -100, manual}／{25, null, null, null}",
      () => {
        const a = computeClose(openTrade(), { exitPrice: 150.25 });
        const m = computeClose(openTrade(), { exitPrice: 150.25, manualProfitJpy: -100 });
        const z = computeClose(openTrade(), { exitPrice: 150.25, manualProfitJpy: 0 });
        const n = computeClose(eurUsd(), { exitPrice: 1.0875 });
        return verdict([
          ['自動', a.pips === 25 && a.autoProfitJpy === 2500 && a.profitJpy === 2500 && a.profitSource === 'auto', JSON.stringify(a)],
          ['手入力', m.pips === 25 && m.autoProfitJpy === 2500 && m.profitJpy === -100 && m.profitSource === 'manual', JSON.stringify(m)],
          ['手入力 0 も manual', z.profitJpy === 0 && z.profitSource === 'manual', JSON.stringify(z)],
          ['計算できない', n.pips === 25 && n.autoProfitJpy === null && n.profitJpy === null && n.profitSource === null, JSON.stringify(n)],
        ]);
      }),

    t('CL-24', 'buildClosedTrade：決済を重ねた記録（pips・損益は自分で計算する。ほかの項目はそのまま）', 'JPY 買い 150.000→150.250・手入力なし／非JPY＋レート＋手入力／JPYにレートを渡す',
      'pips=25・profitJpy=2500・auto・32項目のまま・元の記録は変えない・JPY はレートを残さない・非JPY は手入力でもレートを残す',
      () => {
        const stored = openTrade();
        const before = JSON.stringify(stored);
        // JPY ペアに円換算レートを渡しても残さない。pips・profitJpy・status を渡しても使わない（保存側が自分で求める）
        const c = buildClosedTrade(stored, {
          exitPrice: 150.25, exitAt: '2026-10-15T23:05:00+09:00', quoteToJpyRate: 149.85, exitReason: 'tp', exitEmotion: '冷静',
          tags: ['a', 'b'], memo: '決済メモ', pips: 999, profitJpy: 999, status: 'closed',
        });
        const e = eurUsd();
        const nj = buildClosedTrade(e, { exitPrice: 1.0875, exitAt: '2026-10-15T23:05:00+09:00', quoteToJpyRate: 149.85, manualProfitJpy: 3700 });
        const keep = buildClosedTrade(stored, { exitPrice: 150.25, exitAt: '2026-10-15T23:05:00+09:00' });
        let err = null;
        try { buildClosedTrade(stored, { exitPrice: null, exitAt: 'x' }); } catch (x) { err = x; }
        return verdict([
          ['pips・円・算出方法', c.pips === 25 && c.profitJpy === 2500 && c.profitSource === 'auto', `${c.pips}/${c.profitJpy}/${c.profitSource}`],
          ['決済価格・日時', c.exitPrice === 150.25 && c.exitAt === '2026-10-15T23:05:00+09:00', `${c.exitPrice}/${c.exitAt}`],
          ['JPY ペアはレートを残さない', c.quoteToJpyRate === null, c.quoteToJpyRate],
          ['理由・感情・タグ・メモ', c.exitReason === 'tp' && c.exitEmotion === '冷静' && c.tags.join() === 'a,b' && c.memo === '決済メモ', `${c.exitReason}/${c.exitEmotion}/${c.tags}/${c.memo}`],
          ['項目は 32 のまま', Object.keys(c).length === TRADE_KEYS.length && TRADE_KEYS.every((k) => k in c), Object.keys(c).length],
          ['エントリー側は変わらない', c.entryPrice === 150 && c.lots === 1 && c.lotUnitSize === 10000 && c.slPrice === 149.8 && c.imageIds.join() === 'img-1', `${c.entryPrice}/${c.lotUnitSize}`],
          ['元の記録を書き換えない', JSON.stringify(stored) === before],
          ['status は渡していない（recompute が決める）', c.status === 'open' && recompute(c).status === 'closed', `${c.status}/${recompute(c).status}`],
          ['非JPY：手入力でもレートを残す', nj.quoteToJpyRate === 149.85 && nj.profitJpy === 3700 && nj.profitSource === 'manual', `${nj.quoteToJpyRate}/${nj.profitJpy}/${nj.profitSource}`],
          ['未指定の項目は記録のまま', keep.tags.join() === '指標前' && keep.memo === 'NY開始直後の上抜け' && keep.exitReason === null, `${keep.tags}/${keep.memo}`],
          ['決済価格なしは TypeError', err instanceof TypeError, err && err.name],
        ]);
      }),

    t('CL-25', 'buildReopenedTrade：決済を取り消した記録。残す項目（理由・感情・メモ・タグ・画像）と消す項目（fx-rules 4.5・roadmap 7.2 #19）', '決済済みの記録（理由 sl・感情 焦り・メモ・タグ・画像・手入力・レートあり）',
      'exitPrice・exitAt・pips・profitJpy・profitSource・quoteToJpyRate が null。理由・感情・メモ・タグ・imageIds は残り、recompute で open',
      () => {
        const closed = buildClosedTrade(eurUsd({ exitReason: 'sl', exitEmotion: '焦り', tags: ['ルール違反'], memo: 'メモ' }), {
          exitPrice: 1.0875, exitAt: '2026-10-15T23:05:00+09:00', quoteToJpyRate: 149.85, manualProfitJpy: -500,
        });
        const closedStatus = recompute(closed);
        const before = JSON.stringify(closedStatus);
        const r = buildReopenedTrade(closedStatus);
        return verdict([
          ['消す6項目', [r.exitPrice, r.exitAt, r.pips, r.profitJpy, r.profitSource, r.quoteToJpyRate].every((v) => v === null), [r.exitPrice, r.exitAt, r.pips, r.profitJpy, r.profitSource, r.quoteToJpyRate]],
          ['残す項目', r.exitReason === 'sl' && r.exitEmotion === '焦り' && r.memo === 'メモ' && r.tags.join() === 'ルール違反' && r.imageIds.join() === 'img-1', `${r.exitReason}/${r.exitEmotion}/${r.memo}/${r.tags}/${r.imageIds}`],
          ['エントリー側は変わらない', r.entryPrice === 1.085 && r.lots === 1 && r.lotUnitSize === 10000, `${r.entryPrice}/${r.lots}`],
          ['項目は 32 のまま', Object.keys(r).length === TRADE_KEYS.length],
          ['recompute で open', recompute(r).status === 'open', recompute(r).status],
          ['元の記録を書き換えない', JSON.stringify(closedStatus) === before],
          ['決済していた記録は closed だった', closedStatus.status === 'closed', closedStatus.status],
        ]);
      }),

    t('CL-26', '決済→取り消し→もう一度決済しても、取り消しで残した理由・感情は画面の初期値に入る（空で上書きして消さない）', 'CL-25 の取り消し後の記録で defaultCloseFields',
      "exitReason='sl'・exitEmotion='焦り'・tags=['ルール違反']・memo='メモ'・決済価格は空",
      () => {
        const closed = buildClosedTrade(openTrade({ exitReason: 'sl', exitEmotion: '焦り', tags: ['ルール違反'], memo: 'メモ' }), { exitPrice: 150.25, exitAt: '2026-10-15T23:05:00+09:00' });
        const reopened = recompute(buildReopenedTrade(recompute(closed)));
        const f = defaultCloseFields(reopened, '2026-10-16T09:00');
        return verdict([
          ['理由・感情', f.exitReason === 'sl' && f.exitEmotion === '焦り', `${f.exitReason}/${f.exitEmotion}`],
          ['タグ・メモ', f.tags.join() === 'ルール違反' && f.memo === 'メモ', `${f.tags}/${f.memo}`],
          ['決済価格は空', f.exitPrice === '', f.exitPrice],
        ]);
      }),

    t('CL-27', '損益の注記の下の「1lot＝○通貨で計算しています」（T-33 U-02）：自動計算に使う、その記録の 1lot の通貨数', 'closeLotUnitNote(記録 10000, 設定 100000)／(記録 なし, 設定 100000)／(なし, なし)',
      "'1lot＝1万通貨で計算しています（記録時の設定）。'（設定の今の値ではなく記録の値）／記録になければ設定の値（10万）／''",
      () => {
        const a = closeLotUnitNote(10000, 100000);
        const b = closeLotUnitNote(null, 100000);
        const c = closeLotUnitNote(undefined, null);
        return verdict([
          ['記録の値を使う', a === '1lot＝1万通貨で計算しています（記録時の設定）。', a],
          ['記録になければ設定の値', b === '1lot＝10万通貨で計算しています（記録時の設定）。', b],
          ['どちらもなければ出さない', c === '', c],
        ]);
      }),

    t('CL-28', '極端な値でも決済画面の計算が例外で止まらない（T-33 R-01）', 'エントリー価格 1e306 の保有中の記録で決済価格 151／決済価格 1000000',
      '例外なし・pips と損益は null／決済価格 1000000 は E-17「決済価格：1,000,000未満の値で入力してください」',
      () => {
        let a;
        let b;
        try {
          a = evaluateClose(openTrade({ entryPrice: 1e306 }), { ...defaultCloseFields(openTrade(), '2026-10-15T23:00'), exitPrice: '151' }, { now: NOW });
          b = evaluateClose(openTrade(), { ...defaultCloseFields(openTrade(), '2026-10-15T23:00'), exitPrice: '1000000' }, { now: NOW });
        } catch (e) {
          return { actual: `例外：${e.message}`, pass: false };
        }
        const e17 = b.issues.find((i) => i.field === 'exitPrice');
        return verdict([
          ['pips・損益は null', a.pips === null && a.profitJpy === null, `${a.pips}/${a.profitJpy}`],
          ['E-17 の文', e17 && e17.text === '決済価格：1,000,000未満の値で入力してください', e17 && e17.text],
        ]);
      }),

    t('FL-01', '一覧に戻った直後のハイライトの受け渡し：預けた記録を 1 度だけ渡す', "requestRowFlash('a') → take／もう一度 take",
      "'a'／null",
      () => {
        requestRowFlash('a', 1000);
        const first = takeRowFlash(1500);
        const second = takeRowFlash(1500);
        return verdict([['1回目', first === 'a', first], ['2回目は空', second === null, second]]);
      }),

    t('FL-02', '預けてから時間が経ったもの（一覧に戻らなかった）は渡さない。空の ID は預からない', `預けてから ${FLASH_WAIT_MS}ms 以内／超過／空の ID`,
      "'a'（ちょうど期限は可）／null／null",
      () => {
        requestRowFlash('a', 1000);
        const edge = takeRowFlash(1000 + FLASH_WAIT_MS);
        requestRowFlash('a', 1000);
        const late = takeRowFlash(1000 + FLASH_WAIT_MS + 1);
        requestRowFlash('', 1000);
        const empty = takeRowFlash(1001);
        requestRowFlash('a', 1000);
        requestRowFlash('b', 1000);
        const latest = takeRowFlash(1001);
        return verdict([
          ['期限ちょうどは可', edge === 'a', edge],
          ['期限超過は渡さない', late === null, late],
          ['空の ID は預からない', empty === null, empty],
          ['あとから預けたものが有効', latest === 'b', latest],
        ]);
      }),
  ];
}
