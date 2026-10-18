/* =========================================================
   tests/edit-form.test.js
   編集・削除まわりの「画面に依存しない部分」のテスト（T-22。design.md 14.5・14.3.8・14.7.5、fx-rules 4.4・4.5、architecture 9.3）。
     ・js/edit-form.js … 記録 → 入力欄の値・下書きの読み込み・変更の検出・口座区分を変えたときの 1lot の通貨数・
       再計算の表示・保存する記録の組み立て（データを落とさない・手入力損益を変えない）・別の画面で変更されたときの重ね合わせ
     ・js/draft-notice.js … 下書きの対象の判定（続きを開く／黙って消す／元の記録が変わったので破棄して知らせる）と、一覧のお知らせ行の文言
     ・js/deleted-toast.js … 「削除しました［取り消す］」を一覧の表示が終わってから出すための受け渡し
   画面（document）も IndexedDB も使わないので、Node.js でもブラウザでも実行する。
   保存・削除・取り消しの DB 処理（saveTrade の CONFLICT・編集の保存・deleteTrade/undoDeleteTrade）は tests/db.test.js の SV-15〜SV-17（ブラウザのみ）。

   ID：ED-xx（編集）、DN-xx（下書きの判定とお知らせ行）、DL-xx（削除トーストの受け渡し）
   ========================================================= */
import {
  editFieldsFromTrade, fieldsFromEditDraft, isEditChanged, isSameTradeContent, lotUnitSizeFor, editSaveLabel, describeLotUnit,
  evaluateEdit, buildEditedTrade, rebaseEditFields, rateAfterPairChange, hasCloseChanges, LOT_UNIT_NOTE, EDIT_FIELD_KEYS, cloneEditFields,
} from '../js/edit-form.js';
import { nextSession } from '../js/entry-form.js';
import { describeProfit } from '../js/close-form.js';
import { recompute } from '../js/trades.js';
import { TRADE_KEYS } from '../js/db.js';
import { judgeDraftTarget, draftTargetHash, draftSummary, buildDraftNotice, DRAFT_STALE_TEXT, keepsGoneDraft } from '../js/draft-notice.js';
import { createDraftAutosaver } from '../js/drafts.js';
import { DELETED_DRAFT_KEEP_MINUTES } from '../js/config.js';
import { requestDeletedToast, takeDeletedToast, DELETED_TOAST_WAIT_MS } from '../js/deleted-toast.js';
import { show } from './helpers.js';

const CATEGORY = '編集・削除';

/** 「今」＝ 2026-10-15（木）23:30（日本時間） */
const NOW = new Date('2026-10-15T23:30:00+09:00');

/** 口座ごとの 1lot の通貨数の「今の設定値」（本番 10,000・デモ 100,000） */
const UNITS = { real: 10000, demo: 100000 };
const getLotUnitSize = (a) => UNITS[a];
const ctx = { getLotUnitSize, now: NOW };

function verdict(checks) {
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) return { actual: `確認${checks.length}項目すべて一致`, pass: true };
  return { actual: failed.map(([label, , detail]) => `×${label}（実際：${show(detail)}）`).join('／'), pass: false };
}

const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run });

/** 保存されている記録の形にそろえる（32項目。保存側の recompute と同じ値を入れる） */
function stored(over = {}) {
  const base = {};
  for (const k of TRADE_KEYS) base[k] = null;
  return recompute({
    ...base,
    id: 'trade-1', accountType: 'real', pair: 'USD/JPY', side: 'buy', entryPrice: 150, entryAt: '2026-10-15T21:30:00+09:00',
    lots: 1, lotUnitSize: 10000, slPrice: 149.8, tpPrice: 150.4, session: 'newyork',
    entryReasons: ['トレンドフォロー'], tags: ['指標前'], memo: 'NY開始直後の上抜け', imageIds: ['img-1'],
    syncStatus: 'synced', syncedAt: '2026-10-15T21:40:00+09:00', createdAt: '2026-10-15T21:31:00+09:00', updatedAt: '2026-10-15T21:31:00+09:00',
    ...over,
  });
}

/** 決済済み（自動計算）：USD/JPY 買い 1lot 150.000→150.250（＋25.0 pips・＋2,500円） */
const closedAuto = (over = {}) => stored({
  exitPrice: 150.25, exitAt: '2026-10-15T23:05:00+09:00', pips: 25, profitJpy: 2500, profitSource: 'auto', exitReason: 'tp', exitEmotion: '冷静',
  ...over,
});

/** 決済済み（確定損益を手入力：−500円）。pips は +25.0 のまま（スワップ・手数料の影響の想定） */
const closedManual = (over = {}) => closedAuto({ profitJpy: -500, profitSource: 'manual', ...over });

/** 決済済み（非JPY）：EUR/USD 買い 1lot 1.08500→1.08750・レート 149.850（＋25.0 pips・＋3,746円） */
const closedEur = (over = {}) => closedAuto({
  pair: 'EUR/USD', entryPrice: 1.085, slPrice: null, tpPrice: null, exitPrice: 1.0875, quoteToJpyRate: 149.85, profitJpy: 3746, ...over,
});

/** 記録 → 入力欄の値 → 少し直す */
const fieldsOf = (trade, over = {}) => ({ ...editFieldsFromTrade(trade), ...over });
const evalOf = (trade, over = {}) => evaluateEdit(trade, fieldsOf(trade, over), ctx);
const buildOf = (trade, over = {}) => buildEditedTrade(trade, fieldsOf(trade, over), ctx);
/** 保存側（saveTrade）と同じく recompute を通した結果 */
const savedOf = (trade, over = {}) => recompute(buildOf(trade, over));
const issueKeys = (ev, type) => ev.issues.filter((i) => !type || i.type === type).map((i) => `${i.field}/${i.type}`);

export function collectEditFormTests() {
  return [
    t('ED-01', '記録 → 入力欄の値（保有中）：数値は文字に、日時は日本時間の欄の値に。決済の欄は空', 'USD/JPY 買い 150.000 1lot・SL 149.8・TP 150.4・根拠・タグ・メモ',
      "entryPrice='150'・lots='1'・entryAt='2026-10-15T21:30'・slPrice='149.8'・tpPrice='150.4'・決済の欄は空・自動計算・session は記録の値",
      () => {
        const f = editFieldsFromTrade(stored());
        return verdict([
          ['口座・通貨ペア・売買方向', f.accountType === 'real' && f.pair === 'USD/JPY' && f.side === 'buy', `${f.accountType}/${f.pair}/${f.side}`],
          ['価格・ロット', f.entryPrice === '150' && f.lots === '1', `${f.entryPrice}/${f.lots}`],
          ['日時は分まで', f.entryAt === '2026-10-15T21:30', f.entryAt],
          ['SL・TP', f.slPrice === '149.8' && f.tpPrice === '150.4', `${f.slPrice}/${f.tpPrice}`],
          ['根拠・タグ・メモ', f.entryReasons.join() === 'トレンドフォロー' && f.tags.join() === '指標前' && f.memo === 'NY開始直後の上抜け'],
          ['決済の欄は空', f.exitPrice === '' && f.exitAt === '' && f.quoteToJpyRate === '' && f.exitReason === '' && f.exitEmotion === ''],
          ['自動計算・金額なし', f.profitMode === 'auto' && f.manualAmount === '', `${f.profitMode}/${f.manualAmount}`],
          ['session は記録の値', f.session === 'newyork', f.session],
          ['配列は別のもの（書き換えても記録に響かない）', (() => { const tr = stored(); const g = editFieldsFromTrade(tr); g.tags.push('z'); return tr.tags.length === 1; })()],
        ]);
      }),

    t('ED-02', '記録 → 入力欄の値（決済済み）：自動計算・手入力（符号と金額に分ける）・非JPY のレート', '自動／手入力 −500／手入力 0／EUR/USD レート 149.85',
      '自動は auto＋決済の欄／手入力は manual・符号 − ・金額 500／0 円は符号 ＋・金額 0／レートは文字',
      () => {
        const a = editFieldsFromTrade(closedAuto());
        const m = editFieldsFromTrade(closedManual());
        const z = editFieldsFromTrade(closedManual({ profitJpy: 0 }));
        const e = editFieldsFromTrade(closedEur());
        return verdict([
          ['決済価格・日時・理由・感情', a.exitPrice === '150.25' && a.exitAt === '2026-10-15T23:05' && a.exitReason === 'tp' && a.exitEmotion === '冷静'],
          ['自動計算', a.profitMode === 'auto' && a.manualAmount === '', `${a.profitMode}/${a.manualAmount}`],
          ['手入力（−500）', m.profitMode === 'manual' && m.manualSign === '-' && m.manualAmount === '500', `${m.profitMode}/${m.manualSign}/${m.manualAmount}`],
          ['手入力（0円）も手入力のまま', z.profitMode === 'manual' && z.manualSign === '+' && z.manualAmount === '0', `${z.profitMode}/${z.manualSign}/${z.manualAmount}`],
          ['非JPY のレート', e.quoteToJpyRate === '149.85', e.quoteToJpyRate],
        ]);
      }),

    t('ED-03', '記録 → 入力欄の値：壊れた・空の値の扱い', '指数表記になる価格・知らない時間足/決済理由・session が空・日時が読めない',
      "価格は 0.0000001（e を出さない）・知らない時間足/決済理由は消さずに持つ・session は日時から自動・読めない日時は ''",
      () => {
        const f = editFieldsFromTrade(stored({ entryPrice: 1e-7, timeframe: 'X9', session: null, emotion: null, memo: null, entryAt: 'broken' }));
        const g = editFieldsFromTrade(closedAuto({ exitReason: 'unknown', session: 'zzz' }));
        return verdict([
          ['指数表記にしない', f.entryPrice === '0.0000001', f.entryPrice],
          ['知らない時間足を消さない', f.timeframe === 'X9', f.timeframe],
          ['空の感情・メモは空文字', f.emotion === '' && f.memo === '', `${f.emotion}/${f.memo}`],
          ['読めない日時は空', f.entryAt === '', f.entryAt],
          ['知らない決済理由を消さない', g.exitReason === 'unknown', g.exitReason],
          ['知らない session は日時から自動（21:30 JST・木＝newyork）', g.session === 'newyork', g.session],
        ]);
      }),

    t('ED-04', '下書きの読み込み：知っている項目だけ取り出す（壊れた項目は記録の値のまま）', 'entryPrice=数値・side="x"・session="zzz"・tags 混在・正しい lots/memo/exitPrice',
      '正しい項目だけ反映し、壊れた項目は記録の値。下書きなしは記録の値のコピー',
      () => {
        const base = editFieldsFromTrade(closedAuto());
        const f = fieldsFromEditDraft({
          fields: {
            entryPrice: 150.1, lots: '0.5', side: 'x', session: 'zzz', timeframe: 'H1', exitPrice: '150.3', tags: ['a', 1, 'a', 'b'], memo: '直した',
            profitMode: 'manual', manualSign: '-', manualAmount: '300', accountType: 'demo', exitReason: 'qq',
          },
        }, base);
        const g = fieldsFromEditDraft(null, base);
        return verdict([
          ['数値の entryPrice は無視', f.entryPrice === base.entryPrice, f.entryPrice],
          ['正しい lots・memo・exitPrice・時間足', f.lots === '0.5' && f.memo === '直した' && f.exitPrice === '150.3' && f.timeframe === 'H1'],
          ['壊れた side・session・決済理由は記録の値', f.side === 'buy' && f.session === base.session && f.exitReason === 'tp', `${f.side}/${f.session}/${f.exitReason}`],
          ['タグは文字だけ・重複なし', f.tags.join() === 'a,b', f.tags],
          ['口座・手入力', f.accountType === 'demo' && f.profitMode === 'manual' && f.manualSign === '-' && f.manualAmount === '300'],
          ['下書きなしは記録の値のコピー', g.entryPrice === base.entryPrice && g.tags !== base.tags && g.tags.join() === base.tags.join()],
        ]);
      }),

    t('ED-05', '「変更あり」の判定：開いただけ・手入力を開いただけでは変更なし。口座を戻したら変更なし', '初期値／確定損益の入力を開いただけ／価格・メモ・口座などを変更／口座を変えて戻す',
      '前の3つは false、変更したら true。根拠・タグの順番だけの違いは false',
      () => {
        const tr = closedAuto();
        const init = editFieldsFromTrade(tr);
        const same = () => cloneEditFields(init);
        const changedIf = (over) => isEditChanged(init, { ...same(), ...over });
        return verdict([
          ['開いただけ', isEditChanged(init, same()) === false],
          ['確定損益を開いただけ（金額が空）', isEditChanged(init, { ...same(), profitMode: 'manual', manualSign: '-' }) === false],
          ['エントリー価格', changedIf({ entryPrice: '150.1' }) === true],
          ['決済価格', changedIf({ exitPrice: '150.3' }) === true],
          ['決済日時', changedIf({ exitAt: '2026-10-15T23:06' }) === true],
          ['口座', changedIf({ accountType: 'demo' }) === true],
          ['口座を変えて戻す', isEditChanged(init, { ...same(), accountType: 'real' }) === false],
          ['メモ', changedIf({ memo: '' }) === true],
          ['手入力の金額', changedIf({ profitMode: 'manual', manualAmount: '100' }) === true],
          ['手入力から自動へ戻した', isEditChanged(editFieldsFromTrade(closedManual()), { ...editFieldsFromTrade(closedManual()), profitMode: 'auto', manualAmount: '' }) === true],
          ['タグの順番だけ違う', isEditChanged(editFieldsFromTrade(stored({ tags: ['a', 'b'] })), { ...editFieldsFromTrade(stored({ tags: ['a', 'b'] })), tags: ['b', 'a'] }) === false],
        ]);
      }),

    t('ED-06', '1lotの通貨数：口座を変えたら変更先の今の設定値、元に戻したら記録時の値', '本番（記録時 10,000・今の設定も 10,000）／設定が 20,000 に変わったあと／デモ（今の設定 100,000）',
      '口座が記録のままなら記録時の値（設定が変わっていても）。変えたら変更先の今の値。戻したら記録時の値。未選択は null。記録に値がなければ今の設定値',
      () => {
        const tr = stored({ lotUnitSize: 10000 });
        const changedSetting = (a) => (a === 'real' ? 20000 : 100000);
        return verdict([
          ['記録のまま', lotUnitSizeFor(tr, 'real', getLotUnitSize) === 10000],
          ['設定が変わっても記録のままなら記録時の値', lotUnitSizeFor(tr, 'real', changedSetting) === 10000],
          ['デモへ変更', lotUnitSizeFor(tr, 'demo', getLotUnitSize) === 100000],
          ['デモから本番へ戻す（本番の設定が変わっていても記録時の値）', lotUnitSizeFor(tr, 'real', changedSetting) === 10000],
          ['口座が未選択は null', lotUnitSizeFor(tr, '', getLotUnitSize) === null],
          ['記録に値がなければ今の設定値', lotUnitSizeFor(stored({ lotUnitSize: null }), 'real', getLotUnitSize) === 10000],
        ]);
      }),

    t('ED-07', '保存ボタンの文言：口座を変えたときだけ「デモに変更して保存」など', '本番の記録を 本番／デモ に、デモの記録を 本番 に',
      '同じ口座は「変更を保存」、変えたら「デモに変更して保存」「本番に変更して保存」、戻したら「変更を保存」',
      () => verdict([
        ['変えない', editSaveLabel('real', 'real') === '変更を保存', editSaveLabel('real', 'real')],
        ['本番→デモ', editSaveLabel('real', 'demo') === 'デモに変更して保存', editSaveLabel('real', 'demo')],
        ['デモ→本番', editSaveLabel('demo', 'real') === '本番に変更して保存', editSaveLabel('demo', 'real')],
        ['戻したら元の文言', editSaveLabel('real', 'real') === '変更を保存'],
      ])),

    t('ED-08', '口座を変えたときの説明文（design 14.5.3 の表）', '決済済み自動／手入力／保有中／両方の設定値が同じ／元に戻す',
      '値が変わるときだけ「口座をデモに変えたため、1lotの通貨数を 10,000 → 100,000 に変更しました。」＋後半（損益を計算し直しています／手入力の値のまま／決済したときの損益に使います）。他はふだんの文',
      () => {
        const head = '口座をデモに変えたため、1lotの通貨数を 10,000 → 100,000 に変更しました。';
        const auto = evalOf(closedAuto(), { accountType: 'demo' });
        const manual = evalOf(closedManual(), { accountType: 'demo' });
        const open = evalOf(stored(), { accountType: 'demo' });
        const sameUnits = evaluateEdit(closedAuto(), fieldsOf(closedAuto(), { accountType: 'demo' }), { getLotUnitSize: () => 10000, now: NOW });
        const back = evalOf(closedAuto(), { accountType: 'real' });
        return verdict([
          ['自動計算', auto.lotUnit.changed && auto.lotUnit.text === `${head}損益を計算し直しています。`, auto.lotUnit.text],
          ['手入力', manual.lotUnit.changed && manual.lotUnit.text === `${head}損益（円）は手入力の値のまま変わりません。`, manual.lotUnit.text],
          ['保有中', open.lotUnit.changed && open.lotUnit.text === `${head}決済したときの損益に使います。`, open.lotUnit.text],
          ['両方の設定値が同じ', !sameUnits.lotUnit.changed && sameUnits.lotUnit.text === LOT_UNIT_NOTE, sameUnits.lotUnit.text],
          ['しかし保存ボタンは「デモに変更して保存」', sameUnits.saveLabel === 'デモに変更して保存', sameUnits.saveLabel],
          ['元に戻したらふだんの文・記録時の値', !back.lotUnit.changed && back.lotUnit.text === LOT_UNIT_NOTE && back.lotUnit.size === 10000, `${back.lotUnit.text}/${back.lotUnit.size}`],
          ['describeLotUnit を直接呼んでも同じ', describeLotUnit(closedAuto(), fieldsOf(closedAuto(), { accountType: 'demo' }), { getLotUnitSize, closed: true, manualProfit: false }).text === `${head}損益を計算し直しています。`],
        ]);
      }),

    t('ED-09', '再計算の表示：価格・ロットを変えると pips・損益が変わる（決済済み・自動計算）', 'USD/JPY 買い 150.000→150.250 1lot を、ロット 0.5／エントリー 150.100／決済 150.500 に',
      '元：＋25.0 pips・＋2,500円。ロット 0.5 → ＋1,250円。エントリー 150.100 → ＋15.0 pips・＋1,500円。決済 150.500 → ＋50.0 pips・＋5,000円',
      () => {
        const base = evalOf(closedAuto());
        const lots = evalOf(closedAuto(), { lots: '0.5' });
        const entry = evalOf(closedAuto(), { entryPrice: '150.100' });
        const exit = evalOf(closedAuto(), { exitPrice: '150.500' });
        return verdict([
          ['元の値', base.close.pips === 25 && base.close.profitJpy === 2500, `${base.close.pips}/${base.close.profitJpy}`],
          ['ロット 0.5', lots.close.pips === 25 && lots.close.profitJpy === 1250, `${lots.close.pips}/${lots.close.profitJpy}`],
          ['エントリー価格 150.100', entry.close.pips === 15 && entry.close.profitJpy === 1500, `${entry.close.pips}/${entry.close.profitJpy}`],
          ['決済価格 150.500', exit.close.pips === 50 && exit.close.profitJpy === 5000, `${exit.close.pips}/${exit.close.profitJpy}`],
          ['エラーなし', !base.hasError && !lots.hasError && !entry.hasError && !exit.hasError, issueKeys(base).join()],
          ['損益の表示（describeProfit）', describeProfit(entry.close, fieldsOf(closedAuto())).main.text === '＋1,500円', describeProfit(entry.close, fieldsOf(closedAuto())).main.text],
        ]);
      }),

    t('ED-10', '口座を変えたときの再計算：自動計算は新しい1lotで計算し直し、手入力の損益は変えない', '本番→デモ（1lot 10,000→100,000）。決済済み 自動／手入力 −500。元に戻す',
      '自動：＋25,000円。手入力：−500円のまま・manual・参考の自動計算値だけ＋25,000円。戻したら 1lot 10,000・＋2,500円',
      () => {
        const auto = evalOf(closedAuto(), { accountType: 'demo' });
        const manual = evalOf(closedManual(), { accountType: 'demo' });
        const back = evalOf(closedAuto(), { accountType: 'real' });
        const builtAuto = savedOf(closedAuto(), { accountType: 'demo' });
        const builtManual = savedOf(closedManual(), { accountType: 'demo' });
        const builtBack = savedOf(closedAuto(), { accountType: 'real' });
        return verdict([
          ['自動：表示は 25,000円', auto.close.profitJpy === 25000 && auto.close.profitSource === 'auto', `${auto.close.profitJpy}/${auto.close.profitSource}`],
          ['手入力：表示は −500円のまま', manual.close.profitJpy === -500 && manual.close.profitSource === 'manual', `${manual.close.profitJpy}/${manual.close.profitSource}`],
          ['手入力：参考の自動計算は 25,000円', manual.close.autoProfitJpy === 25000, manual.close.autoProfitJpy],
          ['戻したら 1lot 10,000・2,500円', back.lotUnit.size === 10000 && back.close.profitJpy === 2500, `${back.lotUnit.size}/${back.close.profitJpy}`],
          ['保存：自動は lotUnitSize 100000・profitJpy 25000', builtAuto.lotUnitSize === 100000 && builtAuto.profitJpy === 25000 && builtAuto.profitSource === 'auto', `${builtAuto.lotUnitSize}/${builtAuto.profitJpy}`],
          ['保存：手入力は profitJpy −500・manual・lotUnitSize 100000', builtManual.lotUnitSize === 100000 && builtManual.profitJpy === -500 && builtManual.profitSource === 'manual', `${builtManual.lotUnitSize}/${builtManual.profitJpy}/${builtManual.profitSource}`],
          ['保存：戻したら lotUnitSize 10000・profitJpy 2500', builtBack.lotUnitSize === 10000 && builtBack.profitJpy === 2500, `${builtBack.lotUnitSize}/${builtBack.profitJpy}`],
          ['保存：口座の値', builtAuto.accountType === 'demo' && builtBack.accountType === 'real'],
        ]);
      }),

    t('ED-11', '入力チェック：必須・決済の欄のエラー（画面の上から順）', 'エントリー価格を空に／ロット 0／決済日時をエントリーより前に／決済価格を空に',
      'entryPrice・lots・exitPrice・exitAt が error。決済日時のエラーは E-10 の文（エントリー日時入り）',
      () => {
        const ev = evalOf(closedAuto(), { entryPrice: '', lots: '0', exitPrice: '', exitAt: '2026-10-15T20:00' });
        const keys = issueKeys(ev, 'error');
        const e10 = ev.issues.find((i) => i.field === 'exitAt');
        return verdict([
          ['エラーの欄と順番（必須 → 決済）', keys.join() === 'entryPrice/error,lots/error,exitPrice/error,exitAt/error', keys.join()],
          ['E-10 の文', Boolean(e10) && e10.text === '決済日時がエントリー日時（10/15 21:30）より前になっています', e10 && e10.text],
          ['hasError', ev.hasError === true],
          ['エントリー価格が空でも W-02 のような警告は出ない', !ev.issues.some((i) => i.type === 'warning' && i.field === 'exitPrice'), issueKeys(ev).join()],
          ['エントリー価格が空のとき pips・損益は計算しない', ev.close.pips === null && ev.close.profitJpy === null, `${ev.close.pips}/${ev.close.profitJpy}`],
        ]);
      }),

    t('ED-12', '入力チェック：通貨ペアを JPY→非JPY に変えたら円換算レートが必要（E-11）。手入力があれば保存できる', 'USD/JPY の決済済み記録を EUR/USD・レート空に／手入力 −500 つき／レート 149.85',
      'レートも手入力も空は profitNeed の error。手入力ありは error なし。レートを入れると自動計算',
      () => {
        const tr = closedAuto({ entryPrice: 1.085, exitPrice: 1.0875, slPrice: null, tpPrice: null });
        const noRate = evalOf(tr, { pair: 'EUR/USD' });
        const withManual = evalOf(tr, { pair: 'EUR/USD', profitMode: 'manual', manualSign: '-', manualAmount: '500' });
        const withRate = evalOf(tr, { pair: 'EUR/USD', quoteToJpyRate: '149.85' });
        return verdict([
          ['レートも手入力もない → E-11', issueKeys(noRate, 'error').includes('profitNeed/error'), issueKeys(noRate).join()],
          ['円は計算しない（—）', noRate.close.profitJpy === null, noRate.close.profitJpy],
          ['手入力あり → エラーなし', !withManual.hasError, issueKeys(withManual).join()],
          ['レートあり → 3,746円（自動）', withRate.close.profitJpy === 3746 && withRate.close.profitSource === 'auto', `${withRate.close.profitJpy}`],
        ]);
      }),

    t('ED-13', '入力チェック：SL・TP と RR（保有中の記録）', 'SL・TP を変更／買いなのに SL がエントリー以上',
      'RR が出る（2.00）／矛盾は W-01 の警告（保存はできる）',
      () => {
        const ok = evalOf(stored(), { slPrice: '149.9', tpPrice: '150.2' });
        const bad = evalOf(stored(), { slPrice: '150.1' });
        return verdict([
          ['RR（損切り 10 pips・利確 20 pips）', ok.levels.rr.value === '2.00', ok.levels.rr.value],
          ['決済の欄は評価しない', ok.close === null && ok.closed === false],
          ['W-01 は警告（エラーではない）', bad.issues.some((i) => i.field === 'slPrice' && i.type === 'warning') && !bad.hasError, issueKeys(bad).join()],
        ]);
      }),

    t('ED-14', '保存する記録の組み立て（保有中）：変えた項目だけ置き換え、他は落とさない', '保有中の記録の ロット・SL・TP・タグ・メモ・時間足 を変更',
      'imageIds・createdAt・syncStatus・syncedAt・id・決済の欄（null）はそのまま。lotUnitSize も記録時のまま。変えた項目は新しい値',
      () => {
        const tr = stored();
        const b = buildOf(tr, { lots: '0.3', slPrice: '149.9', tpPrice: '', tags: ['a', 'b'], memo: '書き足した', timeframe: 'H1', emotion: '冷静' });
        return verdict([
          ['変えた項目', b.lots === 0.3 && b.slPrice === 149.9 && b.tpPrice === null && b.tags.join() === 'a,b' && b.memo === '書き足した' && b.timeframe === 'H1' && b.emotion === '冷静'],
          ['画像・作成日時・同期の項目はそのまま', b.imageIds.join() === 'img-1' && b.createdAt === tr.createdAt && b.syncStatus === 'synced' && b.syncedAt === tr.syncedAt && b.id === tr.id],
          ['lotUnitSize は記録時のまま', b.lotUnitSize === 10000, b.lotUnitSize],
          ['決済の欄は空のまま', b.exitPrice === null && b.exitAt === null && b.pips === null && b.profitJpy === null && b.profitSource === null],
          ['入力していない項目（根拠・エントリー価格）は記録のまま', b.entryReasons.join() === 'トレンドフォロー' && b.entryPrice === 150],
          ['項目は32個のまま', Object.keys(b).length === TRADE_KEYS.length && Object.keys(b).every((k) => TRADE_KEYS.includes(k)), Object.keys(b).length],
          ['配列は別のもの', b.tags !== tr.tags],
        ]);
      }),

    t('ED-15', '保存する記録の組み立て（決済済み）：価格を変えると pips・損益が再計算され、自動/手入力の切替が反映される', '決済価格 150.500／手入力 −300 に切替／手入力から自動に戻す／レートの扱い',
      '決済価格 150.500 → pips 50・5,000円（auto）。手入力へ → −300・manual。手入力の記録を自動に戻す → 2,500円・auto。JPYペアのレートは null',
      () => {
        const px = savedOf(closedAuto(), { exitPrice: '150.500' });
        const toManual = savedOf(closedAuto(), { profitMode: 'manual', manualSign: '-', manualAmount: '300' });
        const toAuto = savedOf(closedManual(), { profitMode: 'auto', manualAmount: '' });
        const jpyRate = savedOf(closedAuto(), { quoteToJpyRate: '149.85' });
        const eur = savedOf(closedEur(), { exitPrice: '1.09000' });
        return verdict([
          ['決済価格を変えた', px.pips === 50 && px.profitJpy === 5000 && px.profitSource === 'auto' && px.status === 'closed', `${px.pips}/${px.profitJpy}/${px.profitSource}`],
          ['手入力へ切替', toManual.profitJpy === -300 && toManual.profitSource === 'manual' && toManual.pips === 25, `${toManual.profitJpy}/${toManual.profitSource}`],
          ['手入力から自動へ', toAuto.profitJpy === 2500 && toAuto.profitSource === 'auto', `${toAuto.profitJpy}/${toAuto.profitSource}`],
          ['JPYペアのレートは null', jpyRate.quoteToJpyRate === null, jpyRate.quoteToJpyRate],
          ['非JPY：決済価格 1.09 → 50 pips・7,493円', eur.pips === 50 && eur.profitJpy === 7493 && eur.quoteToJpyRate === 149.85, `${eur.pips}/${eur.profitJpy}`],
          ['決済理由・感情を変えられる', savedOf(closedAuto(), { exitReason: 'sl', exitEmotion: '' }).exitReason === 'sl' && savedOf(closedAuto(), { exitEmotion: '' }).exitEmotion === null],
        ]);
      }),

    t('ED-16', '保存する記録の組み立て：空の値は ""（空文字）ではなく null で渡す（fx-expert の指摘）', '任意項目をすべて空にして保存',
      'どの項目にも空文字が入らない（SL・TP・時間足・感情・メモ・決済理由・決済時の感情は null）。RR は null',
      () => {
        const b = buildOf(closedAuto(), { slPrice: '', tpPrice: '', timeframe: '', emotion: '', memo: '   ', exitReason: '', exitEmotion: '', entryReasons: [], tags: [] });
        const r = recompute(b);
        const empties = Object.entries(r).filter(([, v]) => v === '').map(([k]) => k);
        return verdict([
          ['空文字の項目がない', empties.length === 0, empties.join()],
          ['SL・TP・時間足・感情・メモ', b.slPrice === null && b.tpPrice === null && b.timeframe === null && b.emotion === null && b.memo === null],
          ['決済理由・決済時の感情', b.exitReason === null && b.exitEmotion === null],
          ['RR は null', r.riskReward === null, r.riskReward],
        ]);
      }),

    t('ED-17', '保存する記録の組み立て：日時を触らなければ元の日時（秒つき）のまま。直したら新しい値', '記録の日時が 21:30:12 のまま他の項目だけ変更／日時を 21:45 に変更',
      '触らなければ 21:30:12 のまま。直したら 21:45:00。セッションは日時を変えても手で選んだ値を残す／自動のままなら追従',
      () => {
        const tr = stored({ entryAt: '2026-10-15T21:30:12+09:00' });
        const same = buildOf(tr, { memo: 'x' });
        const moved = buildOf(tr, { entryAt: '2026-10-15T21:45' });
        // 21:30 JST（木）は newyork（冬時間でなく夏時間：10/15 は NY が夏時間 → 21:30 JST＝8:30 NY）。10/16 の 17:30 JST は london
        const f = editFieldsFromTrade(tr);
        const followed = nextSession(f.entryAt, '2026-10-16T17:30', f.session);
        const manual = editFieldsFromTrade(stored({ session: 'tokyo' }));
        const kept = nextSession(manual.entryAt, '2026-10-16T17:30', manual.session);
        return verdict([
          ['触らなければ秒を残す', same.entryAt === '2026-10-15T21:30:12+09:00', same.entryAt],
          ['直したら :00 で保存', moved.entryAt === '2026-10-15T21:45:00+09:00', moved.entryAt],
          ['自動のままならセッションが追従（entry-form.js の nextSession と同じ判断）', followed === 'london', followed],
          ['手で選んだセッションは残る', kept === 'tokyo', kept],
          ['決済日時も同じ扱い', buildOf(closedAuto({ exitAt: '2026-10-15T23:05:30+09:00' }), { memo: 'x' }).exitAt === '2026-10-15T23:05:30+09:00'],
        ]);
      }),

    t('ED-18', '保存する記録の組み立て：必須が足りない入力は TypeError（画面の検査をすり抜けた誤り）', '価格が空／ロットが読めない／決済済みで決済価格が空',
      'TypeError で止まる（黙って壊れた記録を作らない）',
      () => {
        const throws = (fn) => { try { fn(); return false; } catch (e) { return e instanceof TypeError; } };
        return verdict([
          ['エントリー価格が空', throws(() => buildOf(stored(), { entryPrice: '' }))],
          ['ロットが読めない', throws(() => buildOf(stored(), { lots: 'abc' }))],
          ['売買方向が空', throws(() => buildOf(stored(), { side: '' }))],
          ['決済価格が空（決済済み）', throws(() => buildOf(closedAuto(), { exitPrice: '' }))],
          ['手入力が整数でない（決済済み）', throws(() => buildOf(closedAuto(), { profitMode: 'manual', manualAmount: '12.5' }))],
        ]);
      }),

    t('ED-19', '変更なしの判定：中身が同じなら保存しない（150 → 150.0 と打ち直しただけ・順番だけ違うタグ）', '4種類の記録（保有中・決済済み自動・手入力・非JPY）をそのまま組み立て／文字だけ変えた／メモを変えた',
      'そのまま・文字だけ・タグの順番は「同じ」。メモを変えたら「違う」。口座を変えたら「違う」',
      () => {
        const kinds = [['保有中', stored()], ['決済済み自動', closedAuto()], ['手入力', closedManual()], ['非JPY', closedEur()]];
        const checks = kinds.map(([name, tr]) => [`${name}：そのまま`, isSameTradeContent(tr, buildOf(tr))]);
        return verdict([
          ...checks,
          ['文字だけ変えた（150.0）', isSameTradeContent(stored(), buildOf(stored(), { entryPrice: '150.0', lots: '1.00' }))],
          ['タグの順番だけ違う', isSameTradeContent(stored({ tags: ['a', 'b'] }), buildOf(stored({ tags: ['a', 'b'] }), { tags: ['b', 'a'] }))],
          ['メモを変えた', !isSameTradeContent(stored(), buildOf(stored(), { memo: '変えた' }))],
          ['口座を変えた', !isSameTradeContent(stored(), buildOf(stored(), { accountType: 'demo' }))],
          ['決済価格を変えた', !isSameTradeContent(closedAuto(), buildOf(closedAuto(), { exitPrice: '150.3' }))],
        ]);
      }),

    t('ED-20', '別の画面で先に変更されたとき：自分が変えた項目だけを最新の記録に重ねる', '編集を始めたときの値・自分の値（メモとロットを変更）・最新の値（別の画面で決済価格とタグが変わった）',
      'メモ・ロットは自分の値、決済価格・タグは最新の値（別の画面での変更を失わない）。自分が触らなかった項目は最新のまま',
      () => {
        const initial = editFieldsFromTrade(closedAuto());
        const mine = { ...cloneEditFields(initial), memo: '自分のメモ', lots: '0.5' };
        const latest = editFieldsFromTrade(closedAuto({ exitPrice: 150.4, tags: ['別の画面'], memo: '古いメモ' }));
        const r = rebaseEditFields(initial, mine, latest);
        const untouched = rebaseEditFields(initial, cloneEditFields(initial), latest);
        return verdict([
          ['自分が変えた項目', r.memo === '自分のメモ' && r.lots === '0.5', `${r.memo}/${r.lots}`],
          ['別の画面で変わった項目は最新', r.exitPrice === '150.4' && r.tags.join() === '別の画面', `${r.exitPrice}/${r.tags}`],
          ['何も触っていなければ最新そのもの', EDIT_FIELD_KEYS.every((k) => JSON.stringify(untouched[k]) === JSON.stringify(latest[k]))],
          ['配列は別のもの', r.tags !== latest.tags],
        ]);
      }),

    t('ED-21', '通貨ペアを変えたときの円換算レート：決済通貨が変わるなら空にする（fx-rules 4.5 の推奨案）', 'EUR/USD（レート 149.85）を EUR/GBP／GBP/USD／USD/JPY に。戻す操作も',
      'EUR/GBP（決済通貨 GBP）は空。GBP/USD（決済通貨 USD のまま）は残す。USD/JPY（JPYペア）は空。EUR/GBP から EUR/USD に戻したら記録のレート 149.85 に戻る。自分で入れたレートは、決済通貨が同じ間は残る',
      () => {
        const init = editFieldsFromTrade(closedEur());
        const at = (prev, next) => rateAfterPairChange(init, prev, next);
        const gbp = at(init, 'EUR/GBP');
        const afterGbp = { ...init, pair: 'EUR/GBP', quoteToJpyRate: gbp };
        return verdict([
          ['EUR/USD → EUR/GBP は空', gbp === '', gbp],
          ['EUR/USD → GBP/USD（決済通貨は同じ USD）は残す', at(init, 'GBP/USD') === '149.85', at(init, 'GBP/USD')],
          ['EUR/USD → USD/JPY（JPYペア）は空', at(init, 'USD/JPY') === '', at(init, 'USD/JPY')],
          ['EUR/GBP から EUR/USD に戻すと記録のレート', at(afterGbp, 'EUR/USD') === '149.85', at(afterGbp, 'EUR/USD')],
          ['EUR/GBP で入れたレートも、決済通貨が変われば（EUR/CHF＝CHF）空', at({ ...afterGbp, quoteToJpyRate: '190.5' }, 'EUR/CHF') === '', at({ ...afterGbp, quoteToJpyRate: '190.5' }, 'EUR/CHF')],
          ['決済通貨が同じ GBP の間は（EUR/GBP → AUD/GBP）入れたレートを残す', at({ ...afterGbp, quoteToJpyRate: '190.5' }, 'AUD/GBP') === '190.5', at({ ...afterGbp, quoteToJpyRate: '190.5' }, 'AUD/GBP')],
          ['JPYの記録を非JPYにしても空（元から空）', rateAfterPairChange(editFieldsFromTrade(closedAuto()), editFieldsFromTrade(closedAuto()), 'EUR/USD') === ''],
          ['JPY → 別の JPY ペアは何も起きない（空のまま）', rateAfterPairChange(editFieldsFromTrade(closedAuto()), editFieldsFromTrade(closedAuto()), 'EUR/JPY') === ''],
        ]);
      }),

    t('ED-22', '通貨ペア変更後：自動計算の記録は E-11 で止まり、手入力の損益は変えない。保存でも古いレートは使われない', 'EUR/USD の決済済み（自動・3,746円）／手入力（−500円）を EUR/GBP に',
      '自動：レート空・円は「—」・profitNeed の error。手入力：エラーなし・保存の profitJpy −500（manual）・quoteToJpyRate は null。レートを入れ直せば自動計算（GBP 建て）',
      () => {
        const change = (tr, extra = {}) => {
          const f = editFieldsFromTrade(tr);
          return { ...f, pair: 'EUR/GBP', quoteToJpyRate: rateAfterPairChange(f, f, 'EUR/GBP'), ...extra };
        };
        const auto = evaluateEdit(closedEur(), change(closedEur()), ctx);
        const manualTr = closedEur({ profitJpy: -500, profitSource: 'manual' });
        const manual = evaluateEdit(manualTr, change(manualTr), ctx);
        const built = buildEditedTrade(manualTr, change(manualTr), ctx);
        const reentered = buildEditedTrade(closedEur(), change(closedEur(), { quoteToJpyRate: '190.456' }), ctx);
        return verdict([
          ['自動：レートは空', change(closedEur()).quoteToJpyRate === ''],
          ['自動：E-11（profitNeed）', issueKeys(auto, 'error').includes('profitNeed/error'), issueKeys(auto).join()],
          ['自動：円は計算されない', auto.close.profitJpy === null, auto.close.profitJpy],
          ['手入力：エラーなし', !manual.hasError, issueKeys(manual).join()],
          ['手入力：保存の損益は −500・manual・pips は価格から', built.profitJpy === -500 && built.profitSource === 'manual' && built.pair === 'EUR/GBP', `${built.profitJpy}/${built.profitSource}/${built.pair}`],
          ['手入力：古いレートは保存されない', built.quoteToJpyRate === null, built.quoteToJpyRate],
          ['レートを入れ直すと自動計算（25pips × 1lot × 1万 × 190.456 ÷ 10000 = 4,761円）', reentered.profitSource === 'auto' && reentered.quoteToJpyRate === 190.456 && reentered.profitJpy === 4761, `${reentered.profitJpy}/${reentered.quoteToJpyRate}`],
        ]);
      }),

    t('ED-23', '別の画面で先に変更されたとき：決済の取り消しと衝突する入力は検出し、通貨ペア変更のレートも重ねで古くならない', '自分が決済価格を直した／決済は触っていない／通貨ペアだけ変えた／タグの順番だけ変えた',
      '決済項目の変更ありを検出（手入力の金額も）。触っていなければ検出しない。ペアだけ変えると最新のレートは決済通貨が変わるなら空。タグの順番だけの違いは重ねない',
      () => {
        const init = editFieldsFromTrade(closedEur());
        const mine = (over) => ({ ...cloneEditFields(init), ...over });
        const latest = editFieldsFromTrade(closedEur({ quoteToJpyRate: 150.5, tags: ['a', 'b'], memo: '最新' }));
        const swapped = rebaseEditFields(editFieldsFromTrade(closedEur({ tags: ['a', 'b'] })), mine({ tags: ['b', 'a'] }), latest);
        const pairOnly = rebaseEditFields(init, mine({ pair: 'EUR/GBP', quoteToJpyRate: '' }), latest);
        const pairKeepRate = rebaseEditFields(init, mine({ pair: 'GBP/USD' }), latest);
        return verdict([
          ['決済価格を変えた', hasCloseChanges(init, mine({ exitPrice: '1.09' })) === true],
          ['手入力の金額を変えた', hasCloseChanges(init, mine({ profitMode: 'manual', manualAmount: '100' })) === true],
          ['決済理由を変えた', hasCloseChanges(init, mine({ exitReason: 'sl' })) === true],
          ['メモだけ変えた', hasCloseChanges(init, mine({ memo: 'x' })) === false],
          ['確定損益を開いただけ（金額が空）', hasCloseChanges(init, mine({ profitMode: 'manual' })) === false],
          ['タグの順番だけの違いは重ねない（最新の順番のまま）', swapped.tags.join() === 'a,b', swapped.tags.join()],
          ['ペア変更＋レートを空にした → 重ねても空・ペアは自分の値', pairOnly.pair === 'EUR/GBP' && pairOnly.quoteToJpyRate === '', `${pairOnly.pair}/${pairOnly.quoteToJpyRate}`],
          ['ペアだけ変えた（レートは触っていない）：最新のレート 150.5 は決済通貨が同じ GBP/USD なら残る', pairKeepRate.pair === 'GBP/USD' && pairKeepRate.quoteToJpyRate === '150.5', `${pairKeepRate.pair}/${pairKeepRate.quoteToJpyRate}`],
          ['ペアだけ変えた（EUR/GBP）：最新のレートは使わず空', rebaseEditFields(init, mine({ pair: 'EUR/GBP' }), latest).quoteToJpyRate === ''],
        ]);
      }),

    /* ===== 下書きの対象の判定・お知らせ行 ===== */

    t('DN-01', '下書きの対象の判定：続きを開く／黙って消す／元の記録が変わったので破棄して知らせる', '新規・編集・決済の下書きと、記録の状態（変更なし／updatedAt が違う／削除済み／ない／決済済み）',
      '新規は常に ok。編集：同じ updatedAt は ok・違えば stale・削除済み/ないは gone。決済：さらに決済済みは gone。baseUpdatedAt がない古い下書きは ok',
      () => {
        const open = stored();
        const draft = (kind, base = open.updatedAt) => ({ kind, tradeId: open.id, baseUpdatedAt: base });
        const bumped = { ...open, updatedAt: '2026-10-15T22:00:00+09:00' };
        return verdict([
          ['新規は ok', judgeDraftTarget({ kind: 'new' }, null) === 'ok'],
          ['編集：変更なし → ok', judgeDraftTarget(draft('edit'), open) === 'ok'],
          ['編集：updatedAt が違う → stale', judgeDraftTarget(draft('edit'), bumped) === 'stale'],
          ['編集：削除済み → gone', judgeDraftTarget(draft('edit'), { ...open, deletedAt: '2026-10-15T22:30:00+09:00' }) === 'gone'],
          ['編集：記録がない → gone', judgeDraftTarget(draft('edit'), null) === 'gone'],
          ['編集：決済済みでも ok（編集できる）', judgeDraftTarget(draft('edit', closedAuto().updatedAt), closedAuto()) === 'ok'],
          ['決済：変更なし → ok', judgeDraftTarget(draft('close'), open) === 'ok'],
          ['決済：updatedAt が違う → stale（T-21 申し送り #9）', judgeDraftTarget(draft('close'), bumped) === 'stale'],
          ['決済：もう決済済み → gone', judgeDraftTarget(draft('close', closedAuto().updatedAt), closedAuto()) === 'gone'],
          ['決済：削除済み → gone', judgeDraftTarget(draft('close'), { ...open, deletedAt: 'x' }) === 'gone'],
          ['baseUpdatedAt がない古い下書きは ok', judgeDraftTarget(draft('edit', null), bumped) === 'ok'],
          ['破棄の知らせの文言（編集）', DRAFT_STALE_TEXT.edit === '元の記録が変更されたため、入力途中の編集を破棄しました', DRAFT_STALE_TEXT.edit],
        ]);
      }),

    t('DN-02', 'お知らせ行の文言：1件ずつ（エントリー・決済・編集）', '下書き1件を 新規／決済／編集 で',
      '「入力途中のエントリー（決済・編集）があります」＋2行目（新規は下書きの通貨ペア・方向、決済・編集は記録の「本番 USD/JPY ▲買い」）＋時刻。［続ける］の行き先',
      () => {
        const tr = stored();
        const mk = (kind, extra = {}) => ({ kind, tradeId: tr.id, fields: {}, updatedAt: '2026-10-15T23:05:12+09:00', ...extra });
        const n = buildDraftNotice([{ draft: mk('new', { tradeId: 'x', fields: { pair: 'EUR/USD', side: 'sell' } }), trade: null }], NOW);
        const nEmpty = buildDraftNotice([{ draft: mk('new', { tradeId: 'x' }), trade: null }], NOW);
        const c = buildDraftNotice([{ draft: mk('close'), trade: tr }], NOW);
        const e = buildDraftNotice([{ draft: mk('edit', { updatedAt: '2026-10-14T21:32:00+09:00' }), trade: stored({ accountType: 'demo', side: 'sell' }) }], NOW);
        return verdict([
          ['新規', n.text === '入力途中のエントリーがあります' && n.subtext === 'EUR/USD ▼売り・23:05' && n.mode === 'continue' && n.hash === '#/new', `${n.text}/${n.subtext}/${n.hash}`],
          ['新規（何も選んでいない）は時刻だけ', nEmpty.subtext === '23:05', nEmpty.subtext],
          ['決済', c.text === '入力途中の決済があります' && c.subtext === '本番 USD/JPY ▲買い・23:05' && c.hash === '#/trades/trade-1/close', `${c.text}/${c.subtext}/${c.hash}`],
          ['編集（日付が今日でなければ「10/14 21:32」）', e.text === '入力途中の編集があります' && e.subtext === 'デモ USD/JPY ▼売り・10/14 21:32' && e.hash === '#/trades/trade-1/edit', `${e.text}/${e.subtext}/${e.hash}`],
          ['0件は null', buildDraftNotice([], NOW) === null],
          ['URL の符号化', draftTargetHash({ kind: 'edit', tradeId: 'a/b#c' }) === '#/trades/a%2Fb%23c/edit', draftTargetHash({ kind: 'edit', tradeId: 'a/b#c' })],
          ['draftSummary を直接', draftSummary(mk('close'), tr, NOW) === '本番 USD/JPY ▲買い・23:05'],
        ]);
      }),

    t('DN-03', 'お知らせ行の文言：2件以上は［選ぶ］（新しい順・件数の言い方）', '新規1・決済2・編集1 を古い順に渡す',
      '「入力途中の記録が4件あります」・「エントリー1件・決済2件・編集1件」・［選ぶ］・シートの行は新しい順で「決済　本番 USD/JPY ▲買い　23:05」の形',
      () => {
        const tr = stored();
        const mk = (kind, updatedAt, extra = {}) => ({ kind, tradeId: tr.id, fields: {}, updatedAt, ...extra });
        const items = [
          { draft: mk('new', '2026-10-15T21:32:00+09:00', { tradeId: 'x', fields: { pair: 'USD/JPY', side: 'buy' } }), trade: null },
          { draft: mk('close', '2026-10-15T22:00:00+09:00', { tradeId: 'c1' }), trade: stored({ id: 'c1', accountType: 'demo', pair: 'EUR/USD' }) },
          { draft: mk('edit', '2026-10-15T23:10:00+09:00'), trade: tr },
          { draft: mk('close', '2026-10-15T23:05:00+09:00'), trade: tr },
        ];
        const n = buildDraftNotice(items, NOW);
        const labels = n.choices.map((c) => c.label);
        return verdict([
          ['見出し・2行目・ボタン', n.text === '入力途中の記録が4件あります' && n.subtext === 'エントリー1件・決済2件・編集1件' && n.mode === 'choose', `${n.text}/${n.subtext}/${n.mode}`],
          ['新しい順', labels[0].startsWith('編集') && labels[1].startsWith('決済') && labels[3].startsWith('エントリー'), labels.join(' | ')],
          ['行の形（全角スペース区切り）', labels[1] === '決済　本番 USD/JPY ▲買い　23:05', labels[1]],
          ['行き先', n.choices[0].hash === '#/trades/trade-1/edit' && n.choices[3].hash === '#/new', n.choices.map((c) => c.hash).join(' ')],
          ['件数の言い方は0件の種類を出さない', buildDraftNotice([items[1], items[3]], NOW).subtext === '決済2件', buildDraftNotice([items[1], items[3]], NOW).subtext],
        ]);
      }),

    t('DN-04', '削除して1分以内の記録の決済・編集の下書きは、対象が削除済み（gone）でも消さずに残す（T-33：T-30 の R-10）', '削除から 30秒／60秒／61秒、記録なし、新規の下書き',
      '30秒・60秒は残す（true）。61秒・記録なし・削除されていない・新規は false（今までどおり）',
      () => {
        const now = new Date('2026-10-15T23:00:00+09:00');
        // deletedAt は保存形式（+09:00）で渡す
        const jst = (sec) => {
          const d = new Date(now.getTime() - sec * 1000 + 9 * 3600e3);
          const p = (x) => String(x).padStart(2, '0');
          return { id: 'a', deletedAt: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+09:00` };
        };
        const close = { kind: 'close', tradeId: 'a' };
        const edit = { kind: 'edit', tradeId: 'a' };
        const r = [
          keepsGoneDraft(close, jst(30), now), keepsGoneDraft(edit, jst(60), now), keepsGoneDraft(close, jst(61), now),
          keepsGoneDraft(close, null, now), keepsGoneDraft(close, { id: 'a', deletedAt: null }, now), keepsGoneDraft({ kind: 'new' }, jst(10), now),
        ];
        return verdict([
          ['30秒・60秒は残す', r[0] === true && r[1] === true, r.join()],
          ['61秒は消す', r[2] === false, r[2]],
          ['記録なし・削除されていない・新規は false', r[3] === false && r[4] === false && r[5] === false, r.slice(3).join()],
          ['残す時間は1分', DELETED_DRAFT_KEEP_MINUTES === 1, DELETED_DRAFT_KEEP_MINUTES],
        ]);
      }),

    t('DN-05', '自動保存は「保存済みの画像を外しただけ」の変更も書く（T-33：T-30 の R-08）', '編集の下書きを1回保存 → removedImageIds だけ変えて flush → baseUpdatedAt だけ変えて flush',
      '3回とも保存される（2回目・3回目を「同じ内容」として飛ばさない）。同じ内容のままの flush は書かない',
      async () => {
        const saved = [];
        const service = { saveDraft: async (d) => { saved.push(JSON.stringify([d.removedImageIds, d.baseUpdatedAt])); return d; }, discardDraft: async () => true };
        const draft = { kind: 'edit', tradeId: 'a', fields: { memo: 'x' }, uiState: {}, addedImageIds: [], removedImageIds: [], baseUpdatedAt: 'u1' };
        const saver = createDraftAutosaver({ key: 'edit:a', build: () => ({ ...draft }), isChanged: () => true, service, lifecycle: false });
        await saver.flush();
        draft.removedImageIds = ['img-1'];
        await saver.flush();
        draft.baseUpdatedAt = 'u2';
        await saver.flush();
        await saver.flush(); // 何も変えていない
        saver.dispose();
        return verdict([
          ['保存の回数', saved.length === 3, saved.length],
          ['外した画像が書かれた', saved[1] === JSON.stringify([['img-1'], 'u1']), saved[1]],
          ['土台の updatedAt が書かれた', saved[2] === JSON.stringify([['img-1'], 'u2']), saved[2]],
        ]);
      }),

    /* ===== 削除トーストの受け渡し ===== */

    t('DL-01', '削除トーストの受け渡し：預けたものを1度だけ渡す。期限を過ぎたら渡さない', 'request → take → take／期限切れ／不正な値',
      '1度目は { id, deletedAt }、2度目は null。期限（5秒）を過ぎたら null。空の値は預からない',
      () => {
        requestDeletedToast({ id: 'a', deletedAt: '2026-10-15T23:00:00+09:00' }, 1000);
        const first = takeDeletedToast(1500);
        const second = takeDeletedToast(1600);
        requestDeletedToast({ id: 'a', deletedAt: 'd' }, 1000);
        const late = takeDeletedToast(1000 + DELETED_TOAST_WAIT_MS + 1);
        requestDeletedToast({ id: 'a', deletedAt: 'd' }, 1000);
        const edge = takeDeletedToast(1000 + DELETED_TOAST_WAIT_MS);
        requestDeletedToast({ id: '', deletedAt: 'd' }, 1000);
        const bad1 = takeDeletedToast(1001);
        requestDeletedToast({ id: 'a', deletedAt: null }, 1000);
        const bad2 = takeDeletedToast(1001);
        return verdict([
          ['1度目', Boolean(first) && first.id === 'a' && first.deletedAt === '2026-10-15T23:00:00+09:00', show(first && first.id)],
          ['2度目は空', second === null],
          ['期限を過ぎたら null', late === null],
          ['期限ちょうどは渡す', Boolean(edge) && edge.id === 'a'],
          ['ID が空は預からない', bad1 === null],
          ['削除日時がないものは預からない（取り消せないため）', bad2 === null],
        ]);
      }),
  ];
}
