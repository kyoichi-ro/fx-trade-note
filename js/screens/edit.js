/* =========================================================
   js/screens/edit.js
   S-05 編集。型B（入力画面）。URL：#/trades/{id}/edit（design.md 14.5、requirements F-04）

   【T-22】記録の全項目を、エントリー画面（S-02）・決済画面（S-03）と同じ部品・同じ並びで直せる画面。
   ・上から「エントリー」（口座・通貨ペア・売買方向・価格・ロット・日時・1lotの通貨数〔読み取り専用〕）、決済済みなら「決済」「損益」、
     「損切り・利確」、根拠・時間足・セッション・感情、決済済みなら決済理由・決済時の感情、タグ、メモ。詳細（任意）の折りたたみはなく、
     すべて展開して並べる（design 14.5.1）。
   ・【T-24】最後に画像（最大4枚）。エントリー時・決済時のすべての画像に × があり、外した画像は「変更を保存」で物理削除する
     （キャンセルなら元に戻る：architecture 11.4）。この編集で追加した画像は × で確認なしに消す。保存では imageIds を組み立て直し
     （buildImageIds：最新の記録の imageIds から外した分を除き、追加した分を足す）、外した画像の削除を記録の保存と同じトランザクションで行う。
   ・値を変えると、その場で pips・損益・RR を計算し直して見せる（計算は edit-form.js → close-form.js / entry-form.js → trades.js・calc.js。独自の式は持たない）。
   ・口座区分（デモ/本番）を変えたら、1lotの通貨数を変更先の今の設定値に取り直して損益を計算し直す。手入力（manual）の損益は変えない。
     保存ボタンは「デモに変更して保存」など。元の口座に戻したら 1lot も記録時の値に戻る（design 14.5.3。判断は edit-form.js）。
   ・入力のたびに下書き（edit:{id}）を自動保存し、アプリが閉じられても続きから編集できる。元の記録が下書きのあとに変わっていたら
     下書きは使わずに破棄して知らせる（architecture 9.3。判断は draft-notice.js の judgeDraftTarget）。
   ・保存：入力チェック → 変更がなければ何もせず詳細へ戻る（updatedAt も前回値 lastInput も変えない：design 14.5.1）
     → trades.js の saveTrade（status・RR・セッションは保存側が決める。expectedUpdatedAt で、編集を始めたあとに別の画面で
     記録が変わっていないかを確かめる）→ 一覧に戻ったときの行のハイライトの予約 → トースト → 詳細へ戻る。
   ・別の画面で先に記録が変更されていた（CONFLICT）ときは、アラートで知らせ、［最新の記録に反映して保存］を選ぶと
     「自分が変えた項目だけ」を最新の記録に重ねて保存する（別の画面での変更を失わない。edit-form.js の rebaseEditFields）。
   ・開いている間に記録が削除された（NOT_FOUND）ときは「この記録は見つかりません」に切り替わる。
   ・「キャンセル」：変更があれば router.js の back() が破棄の確認を出す（この画面は hasUnsavedChanges / discardChanges / discardTitle を返すだけ）。

   文字はすべて ui/dom.js の h() を通す（innerHTML は使わない：architecture 14.1）。
   ========================================================= */
import { h } from '../ui/dom.js';
import { navbar, textButton, backButton, actionBar } from '../ui/bars.js';
import { button, listGroup, emptyState, setBusy, showLoadingAfter } from '../ui/parts.js';
import {
  numberRow, dateTimeRow, accountSegment, sideSegment, segment, chips, textareaRow, setGroupMessages,
} from '../ui/fields.js';
import { tagPicker } from '../ui/tag-picker.js';
import { imageField } from '../ui/image-field.js';
import { buildImageIds, IMAGE_TEXT } from '../images.js';
import { icon } from '../ui/icons.js';
import { renderNotices } from '../ui/notice.js';
import { actionSheet, showAlert } from '../ui/dialog.js';
import { showToast } from '../ui/toast.js';
import { choosePair } from '../ui/pair-chooser.js';
import { settingsStore } from '../settings-store.js';
import { getPairSpec, TIMEFRAME_LABELS, EXIT_REASON_LABELS } from '../master.js';
import { getTrade, saveTrade, judgeStatus } from '../trades.js';
import { getDraft, discardDraft, draftKeyOf, DRAFT_KIND, createDraftAutosaver } from '../drafts.js';
import { nowInputValue } from '../datetime.js';
import { formatDraftTime, formatLotUnit } from '../format.js';
import { isAppError } from '../util.js';
import { requestRowFlash } from '../row-flash.js';
import { FAVORITE_GRID_COUNT } from '../config.js';
import { withSelected } from '../choice-list.js'; // 設定から消された選択済みの値もチップに残す
import { judgeDraftTarget, DRAFT_STALE_TEXT } from '../draft-notice.js';
import {
  TIMEFRAMES, SESSIONS, SESSION_SEGMENT_LABELS, SL_LABEL, TP_LABEL, PRICE_LABEL, nextSession, sessionNote, visibleIssues, pricePlaceholder,
} from '../entry-form.js';
import {
  EXIT_REASONS, initialManualSign, splitSignedAmount, formatAmountText, tidyAmount, describeProfit, speakProfit,
} from '../close-form.js';
import {
  EDIT_DISCARD_TITLE, EDIT_SAVED_TOAST, LOT_UNIT_NOTE, editFieldsFromTrade, fieldsFromEditDraft, cloneEditFields, isEditChanged,
  isSameTradeContent, evaluateEdit, buildEditedTrade, rebaseEditFields, rateAfterPairChange, hasCloseChanges,
} from '../edit-form.js';

/** 今表示しているこの画面の操作の係（unmount・hasUnsavedChanges から使う） */
let ctrl = null;

/** よく使う通貨ペアのうち、格子に並べる数（entry.js と同じ値を config.js から読む） */
const GRID_PAIRS = FAVORITE_GRID_COUNT;

/** エラーの欄を探す順（画面の上から）。E-11（profitNeed）は保存を押したときだけ出す */
const FIELD_ORDER = [
  'accountType', 'pair', 'side', 'entryPrice', 'lots', 'entryAt', 'exitPrice', 'quoteToJpyRate', 'exitAt', 'manualProfit', 'profitNeed',
  'slPrice', 'tpPrice',
];

/** 損益の説明文（グループの下・13px・灰：design 14.2.3・14.2.5。決済画面と同じ文） */
const NOTE_AUTO = '自動計算はスワップ・手数料を含みません。';
const NOTE_MANUAL = '業者アプリに表示された確定損益を入力します。スワップ・手数料を含めた値にできます。';

/** 「確定損益を入力」の符号の切替を押した直後に、金額欄が空のまま自動計算に戻らないよう待つ時間（ミリ秒。決済画面と同じ） */
const SIGN_TAP_GUARD_MS = 600;

/* ---------------------------------------------------------
   小さな部品
   --------------------------------------------------------- */

/** 「21:32 の下書き」（今日でなければ「10/14 21:32 の下書き」：design 14.1.10） */
function draftTimeText(updatedAt) {
  const time = formatDraftTime(updatedAt);
  return time ? `${time} の下書き` : '';
}

/** 「この記録は見つかりません」（architecture 5.1・15.1：画面の中に空状態の形で出す） */
function renderMissing(root, nav) {
  root.replaceChildren(
    navbar({ left: backButton('一覧', () => nav.back('#/')), title: '編集' }),
    h('div', { class: 'screen__body' },
      emptyState({
        iconName: 'notebook',
        title: 'この記録は見つかりません',
        text: '削除された可能性があります。',
        action: button('一覧へ', { variant: 'secondary', onClick: () => nav.back('#/') }),
      })),
  );
}

/** 記録を読み込めなかった（DB のエラー）：画面全体の問題なのでお知らせ行（design 14.7.1）。再読み込みで同じ画面を作り直す */
function renderLoadError(root, nav, detailHash, retry) {
  const notices = h('div', { class: 'entry-notices' });
  renderNotices(notices, [{
    iconName: 'warning', tone: 'error', text: 'データを読み込めませんでした', action: { label: '再読み込み', onClick: retry },
  }]);
  root.replaceChildren(
    navbar({ left: textButton('キャンセル', { onClick: () => nav.back(detailHash) }), title: '編集' }),
    h('div', { class: 'screen__body' }, notices),
  );
}

/** チップの選択肢に、保存されている値が選択肢にないとき（知らない時間足・決済理由）も、その値を足す（保存で消さないため） */
function withUnknown(options, value) {
  return value !== '' && !options.some((o) => o.value === value) ? [...options, { value, label: value }] : options;
}

/* ---------------------------------------------------------
   画面の組み立てと操作
   --------------------------------------------------------- */

/**
 * 画面の中身を作り、操作の係を返す。
 * @param {HTMLElement} root
 * @param {object} nav router.js の移動の道具
 * @param {object} trade 編集前の記録（保存されている最新の写し）
 * @param {object|null} draft 復元する下書き（なければ null）
 * @param {{ staleText?: string }} [opts] staleText：元の記録が変わったため下書きを破棄したときの知らせ
 */
function buildScreen(root, nav, trade, draft, { staleText = '' } = {}) {
  const detailHash = `#/trades/${encodeURIComponent(trade.id)}`;
  const draftKey = draftKeyOf(DRAFT_KIND.EDIT, trade.id);
  const closed = judgeStatus(trade) === 'closed'; // 状態（保有中/決済済み）は編集では変えられない（design 14.5.1）
  const now = new Date();
  const getLotUnitSize = (accountType) => settingsStore.get(`lotUnitSize.${accountType}`);
  const calcCtx = { getLotUnitSize, now };

  let base = trade;          // 保存の土台にしている記録（別の画面で変更されて重ね直したときに差し替える）
  const initialFields = editFieldsFromTrade(trade);
  const initial = cloneEditFields(initialFields); // 「開いたときから変わったか」の比べる相手
  const fields = draft ? fieldsFromEditDraft(draft, initialFields) : cloneEditFields(initialFields);
  const favorites = settingsStore.get('favoritePairs');
  const choices = settingsStore.get('choices');
  const gridPairs = favorites.slice(0, GRID_PAIRS);

  let finished = false;      // 保存した・破棄した・対象が無くなった（もう下書きを作らない）
  let saving = false;
  let draftFailed = false;   // 下書きの保存に失敗している（design 14.7.6）
  let staleOpen = Boolean(staleText);
  const restored = Boolean(draft);
  const shown = new Set();   // エラー・警告の文を出してよい欄（欄から離れた・保存を押した欄：design 14.1.8）
  let signTapUntil = 0;      // この時刻までは、金額欄が空で外れても自動計算に戻さない（＋/− 切替を押している最中）
  let renderedKey = '';      // 損益グループに今並べている行の種類（変わったときだけ並べ直す）
  let rateReset = false;     // 通貨ペアを変えて決済通貨が変わったので、円換算レート欄を空にした（入れ直しの案内を出す）

  // 画像は入力欄の文字（fields）には入らない。追加した・外した画像があれば「変更あり」
  const isChanged = () => isEditChanged(initial, fields) || images.isChanged();
  const evaluate = () => evaluateEdit(base, fields, calcCtx);
  const isJpy = () => !fields.pair || getPairSpec(fields.pair).isJpyPair;

  /* ----- エントリーグループ（design 14.5.2） ----- */
  const accountLine = h('div', { class: 'account-line', 'aria-hidden': 'true' });
  const notices = h('div', { class: 'entry-notices' });

  const account = accountSegment({ value: fields.accountType || null, onChange: (v) => { fields.accountType = v; touched('accountType'); } });
  const pairChips = chips({
    label: '通貨ペア', options: gridPairs.map((p) => ({ value: p, label: p })), selected: fields.pair ? [fields.pair] : [],
    multiple: false, required: true, className: 'chips--pair-grid', onChange: (sel) => onPairChange(sel[0] || ''),
  });
  const otherValue = h('span', { class: 'list-row__value other-pair__value num' });
  const otherRow = h('button', { type: 'button', class: 'list-row list-row--link other-pair', onClick: () => onOtherPair() },
    h('span', { class: 'list-row__label' }, 'その他の通貨ペア'),
    otherValue,
    h('span', { class: 'list-row__chevron' }, icon('chevronRight', { size: 'sm' })));
  const side = sideSegment({ value: fields.side || null, onChange: (v) => { fields.side = v; touched('side'); } });
  const price = numberRow({
    label: PRICE_LABEL, name: 'entryPrice', value: fields.entryPrice, placeholder: pricePlaceholder(fields.pair),
    onInput: (e) => { fields.entryPrice = e.target.value; onInput(); },
    onBlur: () => { if (fields.entryPrice !== '') touched('entryPrice'); else refresh(); },
  });
  const lots = numberRow({
    label: 'ロット', name: 'lots', value: fields.lots, unit: 'lot', placeholder: '0.1', enterkeyhint: 'done',
    onInput: (e) => { fields.lots = e.target.value; onInput(); },
    onBlur: () => { if (fields.lots !== '') touched('lots'); else refresh(); },
  });
  const entryDt = dateTimeRow({
    label: '日時', name: 'entryAt', value: fields.entryAt,
    onNow: () => { entryDt.input.value = nowInputValue(); onEntryAtChange(entryDt.input.value); touched('entryAt'); },
    onChange: () => { onEntryAtChange(entryDt.input.value); touched('entryAt'); },
  });
  entryDt.input.addEventListener('input', () => { onEntryAtChange(entryDt.input.value); onInput(); });
  // 1lotの通貨数：読み取り専用の行（値は灰・押せない：design 14.5.2）
  const lotUnitValue = h('span', { class: 'list-row__value num' });
  const lotUnitRow = h('div', { class: 'list-row' }, h('span', { class: 'list-row__label' }, '1lotの通貨数'), lotUnitValue);
  const lotNote = h('p', { class: 'close-note' }, LOT_UNIT_NOTE);
  const entryGroup = listGroup({
    header: 'エントリー', className: 'entry-required',
    rows: [
      h('div', { class: 'field-row' }, account.el),
      h('div', { class: 'field-row' }, pairChips.el),
      otherRow,
      h('div', { class: 'field-row' }, side.el),
      price.row, lots.row, entryDt.row, lotUnitRow,
    ],
    footer: lotNote,
  });

  /* ----- 決済グループ・損益グループ（決済済みのときだけ。決済画面と同じ部品・同じ動き：design 14.2） ----- */
  const exitPrice = numberRow({
    label: '決済価格', name: 'exitPrice', value: fields.exitPrice, placeholder: pricePlaceholder(fields.pair), enterkeyhint: 'next',
    onInput: (e) => { fields.exitPrice = e.target.value; onInput(); },
    onBlur: () => { announce(); if (fields.exitPrice !== '') touched('exitPrice'); else refresh(); },
  });
  const rate = numberRow({
    // 円換算レートの欄名は「決済通貨/JPY」。通貨ペアを変えたとき（JPY⇔非JPY）に出し入れし、名前も付け替える
    label: '円換算レート', name: 'quoteToJpyRate', value: fields.quoteToJpyRate, placeholder: '0.000', enterkeyhint: 'done',
    onInput: (e) => { fields.quoteToJpyRate = e.target.value; onInput(); },
    onBlur: () => { announce(); if (fields.quoteToJpyRate !== '') touched('quoteToJpyRate'); else refresh(); },
  });
  const rateLabel = rate.row.querySelector('.form-row__label');
  const exitDt = dateTimeRow({
    label: '日時', name: 'exitAt', value: fields.exitAt,
    onNow: () => { exitDt.input.value = nowInputValue(); fields.exitAt = exitDt.input.value; touched('exitAt'); },
    onChange: () => { fields.exitAt = exitDt.input.value; touched('exitAt'); },
  });
  exitDt.input.addEventListener('input', () => { fields.exitAt = exitDt.input.value; onInput(); });
  const exitNote = h('p', { class: 'close-note' });
  const exitGroup = listGroup({ header: '決済', className: 'close-exit', rows: [exitPrice.row, rate.row, exitDt.row], footer: exitNote });

  const autoMain = h('span', { class: 'close-profit__main num' });
  const autoHint = h('span', { class: 'close-profit__sub' });
  const autoPips = h('span', { class: 'close-profit__sub num' });
  const autoRow = h('div', { class: 'list-row close-profit' },
    h('span', { class: 'list-row__label' }, '損益'),
    h('div', { class: 'close-profit__values' }, autoMain, autoHint, autoPips));
  const enterManualRow = h('button', { type: 'button', class: 'list-row list-row--link close-action', onClick: () => enterManual() },
    h('span', { class: 'close-action__label' }, '確定損益を入力'),
    h('span', { class: 'list-row__chevron' }, icon('chevronRight', { size: 'sm' })));
  const signSeg = segment({
    name: 'manualSign', label: '損益の符号', value: fields.manualSign,
    options: [{ value: '+', label: '＋' }, { value: '-', label: '−' }],
    onChange: (v) => onSignChange(v),
  });
  signSeg.el.addEventListener('pointerdown', () => { signTapUntil = Date.now() + SIGN_TAP_GUARD_MS; });
  const amountInput = h('input', {
    class: 'form-row__input num', type: 'text', inputmode: 'numeric', name: 'manualProfit', enterkeyhint: 'done',
    value: formatAmountText(fields.manualAmount), placeholder: '0', 'aria-label': '確定損益の金額（円）',
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false',
    onInput: () => onAmountInput(),
    onBlur: (e) => onAmountBlur(e),
  });
  amountInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); amountInput.blur(); } });
  const manualRow = h('div', { class: 'form-row manual-row' },
    h('span', { class: 'form-row__label' }, '確定損益'), signSeg.el, amountInput, h('span', { class: 'form-row__unit' }, '円'));
  const manualPips = h('span', { class: 'list-row__value num' });
  const manualPipsRow = h('div', { class: 'list-row' }, h('span', { class: 'list-row__label' }, 'pips'), manualPips);
  const manualRef = h('span', { class: 'list-row__value num close-ref__value' });
  const manualRefRow = h('div', { class: 'list-row close-ref' }, h('span', { class: 'list-row__label' }, '自動計算（参考）'), manualRef);
  const backBtn = h('button', { type: 'button', class: 'list-row close-action', onClick: () => toAuto() },
    h('span', { class: 'close-action__label' }, '自動計算に戻す'));
  const backNote = h('div', { class: 'list-row close-back-note' }, '円換算レートを入れると自動計算に戻せます');
  const profitNote = h('p', { class: 'close-note' }, NOTE_AUTO);
  const profitGroup = listGroup({ header: '損益', className: 'close-profit-group', rows: [autoRow, enterManualRow], footer: profitNote });
  const profitLive = h('div', { class: 'visually-hidden', 'aria-live': 'polite' });
  profitGroup.append(profitLive);
  /** 計算結果は 1 文字ごとには読み上げず、欄から離れたときに 1 回だけ読ませる（design 14.1.7 と同じ方針） */
  function announce() {
    const ev = evaluate();
    profitLive.textContent = ev.close ? speakProfit(ev.close) : '';
  }

  /* ----- 損切り・利確（リスクリワードは事実の表示のみ：design 14.1.7） ----- */
  const sl = numberRow({
    label: SL_LABEL, name: 'slPrice', value: fields.slPrice, placeholder: pricePlaceholder(fields.pair),
    onInput: (e) => { fields.slPrice = e.target.value; onInput(); },
    onBlur: () => { announceRr(); if (fields.slPrice !== '') touched('slPrice'); else refresh(); },
  });
  const tp = numberRow({
    label: TP_LABEL, name: 'tpPrice', value: fields.tpPrice, placeholder: pricePlaceholder(fields.pair), enterkeyhint: 'done',
    onInput: (e) => { fields.tpPrice = e.target.value; onInput(); },
    onBlur: () => { announceRr(); if (fields.tpPrice !== '') touched('tpPrice'); else refresh(); },
  });
  const rrValue = h('span', { class: 'rr-row__value num' });
  const rrSub = h('span', { class: 'rr-row__sub num' });
  const rrRow = h('div', { class: 'list-row rr-row' }, h('span', { class: 'list-row__label' }, 'リスクリワード'), rrValue, rrSub);
  const levelsGroup = listGroup({ header: '損切り・利確', className: 'entry-levels', rows: [sl.row, tp.row, rrRow] });
  const rrLive = h('div', { class: 'visually-hidden', 'aria-live': 'polite' });
  levelsGroup.append(rrLive);
  function announceRr() {
    const v = evaluate().levels.rr.value;
    rrLive.textContent = v === '—' ? '' : `リスクリワード ${v}`;
  }

  /* ----- 根拠・時間足・セッション・感情・決済理由・タグ・メモ（すべて展開して並べる：design 14.5.1） ----- */
  const emptyHint = (kindLabel) => h('p', { class: 'choice-empty' }, `選択肢がありません。設定の「${kindLabel}」で追加できます。`);
  const reasonOptions = withSelected(choices.entryReasons, fields.entryReasons);
  const reasonChips = chips({
    label: 'エントリー根拠', options: reasonOptions.map((v) => ({ value: v, label: v })), selected: fields.entryReasons, multiple: true,
    onChange: (sel) => { fields.entryReasons = sel; onDetailsChanged(); },
  });
  const timeframeChips = chips({
    label: '時間足', options: withUnknown(TIMEFRAMES.map((v) => ({ value: v, label: TIMEFRAME_LABELS[v] })), fields.timeframe),
    selected: fields.timeframe ? [fields.timeframe] : [], multiple: false,
    onChange: (sel) => { fields.timeframe = sel[0] || ''; onDetailsChanged(); },
  });
  const sessionSeg = segment({
    name: 'session', label: 'セッション', value: fields.session || null,
    options: SESSIONS.map((v) => ({ value: v, label: SESSION_SEGMENT_LABELS[v] })),
    onChange: (v) => { fields.session = v; onDetailsChanged(); },
  });
  const sessionGroup = listGroup({ header: 'セッション', rows: [h('div', { class: 'field-row' }, sessionSeg.el)], footer: sessionNote(fields) });
  const emotionOptions = withSelected(choices.emotions, fields.emotion ? [fields.emotion] : []);
  const emotionChips = chips({
    label: 'エントリー時の感情', options: emotionOptions.map((v) => ({ value: v, label: v })), selected: fields.emotion ? [fields.emotion] : [],
    multiple: false, onChange: (sel) => { fields.emotion = sel[0] || ''; onDetailsChanged(); },
  });
  const exitReasonChips = chips({
    label: '決済理由',
    options: withUnknown(EXIT_REASONS.map((v) => ({ value: v, label: EXIT_REASON_LABELS[v] })), fields.exitReason),
    selected: fields.exitReason ? [fields.exitReason] : [], multiple: false,
    onChange: (sel) => { fields.exitReason = sel[0] || ''; onDetailsChanged(); },
  });
  const exitEmotionOptions = withSelected(choices.emotions, fields.exitEmotion ? [fields.exitEmotion] : []);
  const exitEmotionChips = chips({
    label: '決済時の感情', options: exitEmotionOptions.map((v) => ({ value: v, label: v })),
    selected: fields.exitEmotion ? [fields.exitEmotion] : [], multiple: false,
    onChange: (sel) => { fields.exitEmotion = sel[0] || ''; onDetailsChanged(); },
  });
  // タグ・メモはエントリー・決済で共通の1つ（design 14.5.2）。タグは画面の中で新しい名前を追加できる
  const tags = tagPicker({ selected: fields.tags, onChange: (sel) => { fields.tags = sel; onDetailsChanged(); } });
  const memo = textareaRow({
    label: 'メモ', name: 'memo', value: fields.memo, warnAt: 100,
    onInput: (e) => { fields.memo = e.target.value; onDetailsChanged(); },
  });
  memo.row.querySelector('.form-row__label').classList.add('visually-hidden');

  // 画像（最大4枚）。保存済みの画像にも × がある（外した分は保存のとき物理削除）。この編集で追加する画像の種類は、保有中なら entry・決済済みなら exit
  const images = imageField({
    tradeId: trade.id, kind: closed ? 'exit' : 'entry', removableExisting: true,
    existingIds: Array.isArray(trade.imageIds) ? trade.imageIds : [],
    addedIds: draft && Array.isArray(draft.addedImageIds) ? draft.addedImageIds : [],
    removedIds: draft && Array.isArray(draft.removedImageIds) ? draft.removedImageIds : [],
    onChange: () => onInput(),
    onBeforePick: () => { if (!finished) autosaver.flush(); },
    onAdded: () => { if (!finished) autosaver.flush(); },
  });

  /** 保存する記録の imageIds：最新の記録（base）の imageIds から外した画像を除き、追加した画像を足す */
  const withImages = (built) => ({ ...built, imageIds: buildImageIds(base.imageIds, images.getAddedIds(), images.getRemovedIds()) });

  const topSave = textButton('保存', { strong: true, onClick: () => save() });
  const cancelBtn = textButton('キャンセル', { onClick: () => nav.back(detailHash) });
  const saveBtn = button('変更を保存', { variant: 'primary', block: true, onClick: () => save() });

  root.replaceChildren(
    navbar({ left: cancelBtn, title: '編集', right: topSave }),
    accountLine,
    h('div', { class: 'screen__body entry-body' },
      notices,
      entryGroup,
      closed ? exitGroup : null,
      closed ? profitGroup : null,
      levelsGroup,
      listGroup({ header: '根拠（複数選択）', rows: [h('div', { class: 'field-row' }, reasonChips.el, choices.entryReasons.length === 0 && fields.entryReasons.length === 0 ? emptyHint('エントリー根拠') : null)] }),
      listGroup({ header: '時間足', rows: [h('div', { class: 'field-row' }, timeframeChips.el)] }),
      sessionGroup,
      listGroup({ header: closed ? '感情（エントリー時）' : '感情', rows: [h('div', { class: 'field-row' }, emotionChips.el, choices.emotions.length === 0 && !fields.emotion ? emptyHint('感情') : null)] }),
      closed ? listGroup({ header: '決済理由', rows: [h('div', { class: 'field-row' }, exitReasonChips.el)] }) : null,
      closed ? listGroup({ header: '決済時の感情', rows: [h('div', { class: 'field-row' }, exitEmotionChips.el, choices.emotions.length === 0 && !fields.exitEmotion ? emptyHint('感情') : null)] }) : null,
      tags.el,
      listGroup({ header: 'メモ', rows: [memo.row] }),
      images.el),
    actionBar(saveBtn),
  );

  /* ----- 下書きの自動保存（architecture 9.2。entry.js・close.js と同じ係） ----- */
  const autosaver = createDraftAutosaver({
    key: draftKey,
    hasStored: restored,
    isChanged,
    build: () => ({
      kind: DRAFT_KIND.EDIT, tradeId: trade.id, fields: cloneEditFields(fields), uiState: {},
      addedImageIds: images.getAddedIds(), removedImageIds: images.getRemovedIds(),
      baseUpdatedAt: trade.updatedAt,
    }),
    onStatus: (ok) => { if (draftFailed === ok) { draftFailed = !ok; renderNoticeRows(); } },
  });

  /* ----- 表示の更新 ----- */

  function renderPair() {
    const other = fields.pair && !gridPairs.includes(fields.pair);
    otherValue.replaceChildren(...(other ? [fields.pair, icon('check', { size: 'xs', className: 'other-pair__check' })] : []));
    otherRow.setAttribute('aria-label', other ? `その他の通貨ペア、${fields.pair}を選択中` : 'その他の通貨ペア');
    for (const row of [price, exitPrice, sl, tp]) row.input.placeholder = pricePlaceholder(fields.pair);
  }

  function renderSession() {
    sessionSeg.setValue(fields.session || null);
    sessionGroup.querySelector('.list-group__footer').textContent = sessionNote(fields);
  }

  /** 損益の表示・行の並び・見本（決済済みのとき。入力のたびに呼ぶ。エラー・警告の文は触らない：入力中は責めない） */
  function renderProfit(ev) {
    if (!ev.close) return;
    const v = describeProfit(ev.close, fields);
    const tone = (el, t, extra) => { el.className = `${extra} tone-${t}`; };
    autoMain.textContent = v.main.text;
    tone(autoMain, v.main.tone, 'close-profit__main num');
    autoHint.textContent = v.hint || '';
    autoHint.hidden = !v.hint;
    autoPips.textContent = v.pips ? v.pips.text : '';
    autoPips.hidden = !v.pips;
    if (v.pips) tone(autoPips, v.pips.tone, 'close-profit__sub num');
    manualPips.textContent = v.pips ? v.pips.text : '—';
    manualPips.className = `list-row__value num tone-${v.pips ? v.pips.tone : 'none'}`;
    manualRef.textContent = v.ref;
    // 金額欄の灰色の見本：自動計算値（符号なし）。計算できないときは 0（design 14.2.5）
    amountInput.placeholder = ev.close.autoProfitJpy == null ? '0' : formatAmountText(String(Math.abs(ev.close.autoProfitJpy)));
    // 行の並べ替えは「自動／手入力」「戻すボタン／注記」が変わったときだけ（入力中の欄を作り直さないため）
    const key = `${v.mode}:${v.back}`;
    if (key !== renderedKey) {
      renderedKey = key;
      const body = profitGroup.querySelector('.list-group__body');
      body.replaceChildren(...(v.mode === 'manual' ? [manualRow, manualPipsRow, manualRefRow, v.back === 'button' ? backBtn : backNote] : [autoRow, enterManualRow]));
    }
    profitNote.textContent = v.mode === 'manual' ? NOTE_MANUAL : NOTE_AUTO;
  }

  /** 通貨ペアに合わせた円換算レートの行（非JPYだけ）と説明文 */
  function renderExitGroup() {
    if (!closed) return;
    const jpy = isJpy();
    rate.row.hidden = jpy;
    const quote = fields.pair && !jpy ? getPairSpec(fields.pair).quoteToJpyPair : null;
    rateLabel.textContent = quote ? `円換算レート ${quote}` : '円換算レート';
    const guide = `決済時点の${quote}を入れると損益（円）を自動計算します。空欄なら確定損益を入力してください。`;
    // 通貨ペアを変えて決済通貨が変わったときは、古いレートを消したことを中立な文で伝える（レートを入れ直す案内。評価・助言はしない）
    exitNote.textContent = jpy ? '' : (rateReset && fields.quoteToJpyRate === '' ? `通貨ペアを変えたので、円換算レートを入れ直してください。${guide}` : guide);
    exitNote.hidden = jpy;
    exitPrice.input.setAttribute('enterkeyhint', jpy ? 'done' : 'next');
  }

  /** 入力のたびに：RR・損益・1lotの通貨数と説明文・保存ボタンの文言・口座色の線を更新する（エラー・警告の文は触らない） */
  function renderValues(ev) {
    accountLine.dataset.account = fields.accountType || 'none';
    const label = saveBtn.querySelector('.btn__label');
    if (label && !saving) label.textContent = ev.saveLabel;
    lotUnitValue.textContent = ev.lotUnit.size == null ? '—' : `${formatLotUnit(ev.lotUnit.size)}通貨`;
    lotNote.textContent = ev.lotUnit.text;
    rrValue.textContent = ev.levels.rr.value;
    rrValue.classList.toggle('is-empty', ev.levels.rr.value === '—');
    rrSub.textContent = ev.levels.rr.sub || '';
    rrSub.hidden = !ev.levels.rr.sub;
    renderExitGroup();
    renderProfit(ev);
  }

  /** 出してよい欄のエラー・警告の文を出し直す（欄から離れた・保存を押した欄だけ：design 14.1.8） */
  function renderMessages(ev) {
    const targetOf = {
      accountType: account.el, pair: pairChips.el, side: side.el, entryPrice: price.input, lots: lots.input, entryAt: entryDt.input,
      exitPrice: exitPrice.input, quoteToJpyRate: rate.input, exitAt: exitDt.input, manualProfit: amountInput,
      // E-11 は「円換算レートか確定損益」のうち打つ量が少ない円換算レートへ誘導する（design 14.2.9）
      profitNeed: rate.input, slPrice: sl.input, tpPrice: tp.input,
    };
    const pick = (list) => visibleIssues(ev.issues.filter((i) => list.includes(i.field)), shown)
      .map((i) => ({ type: i.type, text: i.text, target: targetOf[i.field] }));
    setGroupMessages(entryGroup, pick(['accountType', 'pair', 'side', 'entryPrice', 'lots', 'entryAt']));
    if (closed) {
      setGroupMessages(exitGroup, pick(['exitPrice', 'quoteToJpyRate', 'exitAt']));
      setGroupMessages(profitGroup, pick(['manualProfit', 'profitNeed']));
    }
    setGroupMessages(levelsGroup, pick(['slPrice', 'tpPrice']));
  }

  function refresh() {
    const ev = evaluate();
    renderValues(ev);
    renderMessages(ev);
    return ev;
  }

  function renderNoticeRows() {
    const items = [];
    if (restored) {
      items.push({
        iconName: 'pencil', text: '入力途中の内容を復元しました', subtext: draftTimeText(draft.updatedAt),
        action: { label: '破棄', onClick: () => onDiscardRestored() },
      });
    }
    if (staleOpen) {
      // 元の記録が変わったため下書きを破棄した知らせ（× で閉じるだけ：design 14.3.8）
      items.push({ iconName: 'pencil', text: staleText, onClose: () => { staleOpen = false; renderNoticeRows(); } });
    }
    if (draftFailed) {
      items.push({ iconName: 'warning', tone: 'warning', text: '下書きを保存できません', subtext: 'アプリを閉じると入力内容が消えます。' });
    }
    renderNotices(notices, items);
  }

  /* ----- 操作 ----- */
  function changed() {
    if (!finished) autosaver.schedule();
  }

  /** 入力のたびに：計算の表示だけ更新し、下書きの保存を予約する */
  function onInput() {
    renderValues(evaluate());
    changed();
  }

  /** 欄から離れた・選んだ：その欄の文を出してよいことにして出し直し、下書きの保存を予約する */
  function touched(field) {
    shown.add(field);
    refresh();
    changed();
  }

  /** 根拠・時間足・セッション・感情・タグ・メモなど、計算に関わらない欄が変わった */
  function onDetailsChanged() {
    renderSession();
    onInput();
  }

  /**
   * エントリー日時が変わった：セッションが「自動のまま」なら新しい日時で判定し直し、手で選んでいたら残す
   * （fx-rules 11.7。判断は entry-form.js の nextSession＝エントリー画面と同じ）
   */
  function onEntryAtChange(next) {
    const prev = fields.entryAt;
    fields.entryAt = next;
    fields.session = nextSession(prev, next, fields.session);
    renderSession();
  }

  function onPairChange(pair) {
    // 決済通貨が変わるときは円換算レート欄を空にする（古いレートは別の通貨のレートになり、損益（円）が誤るため。fx-rules 4.5）。
    // 決済通貨が同じペア同士なら残し、記録を開いたときのペアに戻したら記録のレートに戻す。手入力の損益は変わらない
    const prevRate = fields.quoteToJpyRate;
    fields.quoteToJpyRate = rateAfterPairChange(initial, fields, pair);
    rateReset = fields.quoteToJpyRate === '' && prevRate !== '';
    rate.input.value = fields.quoteToJpyRate;
    fields.pair = pair;
    renderPair();
    // 入力済みの価格の桁数を新しいペアの上限でその場で再チェックする（design 14.1.8）
    for (const k of ['entryPrice', 'slPrice', 'tpPrice', 'exitPrice']) if (fields[k] !== '') shown.add(k);
    touched('pair');
  }

  async function onOtherPair() {
    const picked = await choosePair(favorites, fields.pair);
    if (!picked || finished) return;
    pairChips.setSelected([picked]); // 格子にないペアなら、格子のチップはどれも選択中にならない
    onPairChange(picked);
  }

  /** 「確定損益を入力 ›」：手入力の行に変え、金額欄にフォーカスして数字キーボードを出す（design 14.2.5） */
  function enterManual() {
    const ev = evaluate();
    fields.profitMode = 'manual';
    fields.manualSign = initialManualSign(ev.close ? ev.close.pips : null); // pips がマイナスなら「−」、それ以外は「＋」
    fields.manualAmount = '';
    signSeg.setValue(fields.manualSign);
    amountInput.value = '';
    refresh();
    amountInput.focus(); // ボタンを押した処理の中で呼ぶので、iPhone でもキーボードが出る
    changed();
  }

  /** 「自動計算に戻す」・金額を空にして欄から離れたとき：手入力の値を消して自動計算の表示に戻る（確認なし：design 14.2.5） */
  function toAuto() {
    fields.profitMode = 'auto';
    fields.manualAmount = '';
    amountInput.value = '';
    shown.delete('manualProfit');
    refresh();
    changed();
  }

  /** 金額欄の入力・貼り付け：符号が付いていたら切替をその符号に合わせ、金額欄には数字だけを残す（close-form.js の splitSignedAmount） */
  function onAmountInput() {
    const r = splitSignedAmount(amountInput.value, fields.manualSign);
    if (r.sign !== fields.manualSign) {
      fields.manualSign = r.sign;
      signSeg.setValue(r.sign);
    }
    if (r.amount !== amountInput.value) amountInput.value = r.amount;
    fields.manualAmount = r.amount;
    onInput();
  }

  function onAmountBlur(e) {
    fields.manualAmount = tidyAmount(fields.manualAmount);
    amountInput.value = formatAmountText(fields.manualAmount);
    if (fields.manualAmount !== '') {
      announce();
      touched('manualProfit');
      return;
    }
    // 金額が空のまま欄から離れたら自動計算の表示に戻る（空欄＝上書きしない）。＋/− 切替を押している最中は戻さない
    const movingToSign = e.relatedTarget && manualRow.contains(e.relatedTarget);
    if (movingToSign || Date.now() < signTapUntil) return;
    toAuto();
  }

  /** ＋/− 切替を押した：金額が入っていれば結果を確かめ、押したあとも続けて金額を打てるよう金額欄へ focus を戻す */
  function onSignChange(v) {
    fields.manualSign = v;
    if (fields.manualAmount !== '') touched('manualProfit');
    else onInput();
    amountInput.focus();
  }

  /** 最初のエラーの欄までスクロールしてフォーカス（design 14.1.8） */
  function focusField(field) {
    const el = {
      accountType: account.el.querySelector('input'), pair: pairChips.el.querySelector('button'), side: side.el.querySelector('input'),
      entryPrice: price.input, lots: lots.input, entryAt: entryDt.input,
      exitPrice: exitPrice.input, quoteToJpyRate: rate.input, exitAt: exitDt.input, manualProfit: amountInput, profitNeed: rate.input,
      slPrice: sl.input, tpPrice: tp.input,
    }[field];
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
  }

  function setSaving(on) {
    saving = on;
    setBusy(saveBtn, on);
    topSave.disabled = on;
    cancelBtn.disabled = on; // 保存の途中で破棄の確認が出て、保存と破棄が重ならないように
    // 保存の途中に画像を足す・外すと、記録に入らない・外したつもりが残る、が起きるので押せなくする（T-30 の R-04）
    images.setDisabled(on);
    if (!on) renderValues(evaluate());
  }

  /** 保存を終えて詳細へ戻る（保存した・変更がなかった）。toast が空なら何も出さない */
  function leaveToDetail(toast) {
    finished = true;
    autosaver.dispose();
    images.dispose();
    if (toast) {
      requestRowFlash(base.id); // 一覧に戻る場合に、この行を 1 秒だけ目立たせる（design 14.3.4。詳細へ戻るなら使われず期限で消える）
      showToast(toast);
    }
    nav.back(detailHash);
  }

  /** 保存（design 14.5.5・architecture 8章）。変更がなければ何も保存せず、updatedAt も lastInput も変えない（design 14.5.1） */
  async function save() {
    if (saving || finished) return;
    FIELD_ORDER.forEach((k) => shown.add(k));
    const ev = refresh();
    const firstError = ev.issues.find((i) => i.type === 'error');
    if (firstError) {
      focusField(firstError.field);
      return;
    }
    setSaving(true);
    // 画像の縮小・保存の途中なら、終わるのを待ってから保存する（ボタンは「保存中」のまま：design 14.1.9）
    await images.whenIdle();
    // 自動保存を止め、保存中の下書きが書き終わるのを待つ（後から下書きが作り直されないように）
    await autosaver.stop();
    let built;
    try {
      built = withImages(buildEditedTrade(base, fields, calcCtx));
    } catch (e) {
      // 画面の検査をすり抜けた誤り（プログラムの誤り）。記録は変更しない
      console.error('保存する記録を組み立てられませんでした', e);
      await onSaveFailed(e);
      return;
    }
    if (!isChanged() || isSameTradeContent(base, built)) {
      await noChange();
      return;
    }
    await commit(built, base.updatedAt);
  }

  /** 変更がなかった：保存せず、下書きがあれば消して詳細へ戻る（トーストなし） */
  async function noChange() {
    try {
      await discardAll();
    } catch (e) {
      console.error('下書きを消せませんでした', e);
    }
    leaveToDetail('');
  }

  /** 記録を保存する（saveTrade）。別の画面で変更されていたら CONFLICT（expected と保存されている updatedAt が違う） */
  async function commit(built, expected) {
    try {
      // 外した画像の物理削除は、記録の保存と同じトランザクションで行う（片方だけ成功しない：architecture 8章）
      await saveTrade(built, { draftKey, expectedUpdatedAt: expected, deleteImageIds: images.getRemovedIds() });
    } catch (e) {
      await onSaveFailed(e);
      return;
    }
    leaveToDetail(EDIT_SAVED_TOAST);
  }

  /** 保存に失敗したとき（design 14.7.3・architecture 15.1） */
  async function onSaveFailed(e) {
    setSaving(false);
    if (isAppError(e, 'NOT_FOUND')) {
      // 開いている間に記録が削除された。保存先がないので下書きも消し、「見つかりません」を出す
      await discardAll();
      renderMissing(root, nav);
      return;
    }
    // 下書きは残す（もう一度保存できるよう、自動保存を再開して今の内容をすぐ書いておく：design 14.1.6）
    autosaver.resume();
    autosaver.flush();
    if (isAppError(e, 'IMAGE_MISSING')) {
      // 追加した画像が images から消えていた：画面の一覧からも外して知らせる（編集は保存していない）
      await images.pruneMissing();
      autosaver.flush();
      await showAlert({ title: '保存できませんでした', message: '追加した画像の一部が見つかりませんでした。画像を追加し直してください。入力内容はこの画面に残っています。' });
      return;
    }
    if (isAppError(e, 'CONFLICT')) {
      const choice = await showAlert({
        title: '記録が変更されています',
        message: 'この記録は、編集を始めたあとに別の画面で変更されました。自分が変えた項目だけを最新の記録に反映して保存できます。',
        buttons: [{ label: '閉じる', value: 'close' }, { label: '最新の記録に反映して保存', value: 'rebase', primary: true }],
      });
      if (choice === 'rebase') await rebaseAndSave();
      return;
    }
    console.error('編集を保存できませんでした', e);
    const message = isAppError(e, 'QUOTA')
      ? '端末の空き容量が不足している可能性があります。入力内容はこの画面に残っています。'
      : '保存中に問題が起きました。入力内容はこの画面に残っています。';
    const choice = await showAlert({
      title: '保存できませんでした',
      message,
      buttons: [{ label: '閉じる', value: 'close' }, { label: 'もう一度保存', value: 'retry', primary: true }],
    });
    if (choice === 'retry') save();
  }

  /**
   * 別の画面で変更された記録に、自分が変えた項目だけを重ねて保存する（edit-form.js の rebaseEditFields）。
   * 最新の記録と重ねた結果に入力の問題が出たとき（例：別の画面で決済日時が変わり、直したエントリー日時より前になった）は、
   * 保存せず知らせる（入力内容と下書きは残す）。
   */
  async function rebaseAndSave() {
    if (saving || finished) return;
    setSaving(true);
    let latest;
    try {
      latest = await getTrade(trade.id);
    } catch (e) {
      console.error('最新の記録を読み込めませんでした', e);
      setSaving(false);
      await showAlert({ title: '保存できませんでした', message: '保存中に問題が起きました。入力内容はこの画面に残っています。' });
      return;
    }
    if (!latest || latest.deletedAt != null) {
      await discardAll();
      renderMissing(root, nav);
      return;
    }
    // 別の画面で決済が取り消され（最新が保有中）、自分が決済の項目を直しているときは、重ねる先がなく黙って落ちてしまう。
    // 保存せず知らせる（入力内容と下書きは残す）
    if (judgeStatus(latest) !== 'closed' && hasCloseChanges(initial, fields)) {
      setSaving(false);
      await showAlert({
        title: '反映できませんでした',
        message: '最新の記録は決済が取り消されて保有中に戻っているため、決済の入力は反映できません。入力内容はこの画面に残っています。',
      });
      return;
    }
    const merged = rebaseEditFields(initial, fields, editFieldsFromTrade(latest));
    const check = evaluateEdit(latest, merged, calcCtx);
    if (check.hasError) {
      setSaving(false);
      await showAlert({
        title: '反映できませんでした',
        message: '最新の記録と重ねると入力に問題があるため、保存しませんでした。入力内容はこの画面に残っています。',
      });
      return;
    }
    base = latest; // 以降の保存は、最新の記録を土台にする（画像も、最新の imageIds を土台に組み立て直す）
    const built = withImages(buildEditedTrade(latest, merged, calcCtx));
    await autosaver.stop();
    if (isSameTradeContent(latest, built)) {
      await noChange();
      return;
    }
    await commit(built, latest.updatedAt);
  }

  /** 「入力途中の内容を復元しました［破棄］」（design 14.1.10）：確認して、下書きを消し、記録の値に戻して画面に留まる */
  async function onDiscardRestored() {
    const ok = await actionSheet({
      title: '入力途中の内容を破棄しますか？',
      message: images.addedCount() > 0 ? IMAGE_TEXT.discardNote : '',
      actions: [{ label: '入力内容を破棄', value: true, danger: true }],
    });
    if (ok !== true || finished) return;
    await discardAll();
    window.scrollTo(0, 0);
    ctrl = buildScreen(root, nav, base, null);
  }

  /**
   * 下書きを消し、この画面ではもう下書きを作らない（キャンセルの破棄・復元の破棄・変更なし・対象が無くなったときに使う）。
   * この編集で追加した画像も一緒に消す（孤立画像を残さない）。外しただけの画像は消さない（キャンセルなら元に戻る：architecture 9.4）。
   */
  async function discardAll() {
    finished = true;
    const added = images.getAddedIds();
    images.dispose();
    await autosaver.stop();
    autosaver.dispose();
    await discardDraft(draftKey, { alsoImageIds: added });
  }

  refresh();
  renderPair();
  renderSession();
  renderNoticeRows();
  // 復元した下書きの手入力の状態に合わせて、金額欄を整える（編集中でないので 3 桁区切りで見せる）
  amountInput.value = formatAmountText(fields.manualAmount);

  return {
    hasUnsavedChanges: () => !finished && isChanged(),
    /** 「入力内容を破棄」の確認の説明。画像を追加していたら「追加した画像も削除されます。」を添える（design 14.7.4） */
    discardMessage: () => (images.addedCount() > 0 ? IMAGE_TEXT.discardNote : ''),
    discardChanges: () => discardAll(),
    /** 画面を離れる：保存も破棄もしていなければ、待たずに下書きを保存する（architecture 9.2） */
    leave() {
      if (!finished) autosaver.flush();
      autosaver.dispose();
      images.dispose(); // 表示用 URL の解放（architecture 11.3）。縮小中の画像は保存せずに捨てる
    },
  };
}

/** 下書きを読む。読めなくても記録の値で開く（入力を止めない）。DB が詰まっていて 2 秒返らないときも同じ（entry.js・close.js と同じ） */
async function readDraft(key, tradeId) {
  try {
    const draft = await Promise.race([getDraft(key), new Promise((resolve) => { setTimeout(() => resolve(null), 2000); })]);
    return draft && draft.tradeId === tradeId ? draft : null;
  } catch (e) {
    console.error('下書きを読み込めませんでした', e);
    return null;
  }
}

/** 下書きを消す（対象が無くなった・元の記録が変わったとき）。消せなくても画面は止めない */
async function dropDraft(key) {
  try {
    await discardDraft(key);
  } catch (e) {
    console.error('下書きを消せませんでした', e);
  }
}

const screen = {
  layout: 'form',
  tab: null,
  title: '編集',
  /** 「キャンセル」の確認シートの見出し（design 14.7.4：編集の破棄）。router.js の back() が使う */
  discardTitle: EDIT_DISCARD_TITLE,

  async mount(root, { params, nav }) {
    const id = params.id;
    // 履歴がないときの戻り先はその記録の詳細（architecture 5.1）
    const detailHash = `#/trades/${encodeURIComponent(id)}`;
    const draftKey = draftKeyOf(DRAFT_KIND.EDIT, id);

    // 先にバーだけ出して、記録の読み込みを待つ（0.3秒以上かかるときだけ回転アイコン：design 9.15）
    const skeleton = navbar({
      left: textButton('キャンセル', { onClick: () => nav.back(detailHash) }), title: '編集', right: textButton('保存', { disabled: true, strong: true }),
    });
    const body = h('div', { class: 'screen__body' });
    root.replaceChildren(skeleton, body);
    const loading = showLoadingAfter(body);

    let trade = null;
    let draft = null;
    let failed = false;
    try {
      trade = await getTrade(id);
      if (trade && trade.deletedAt == null) draft = await readDraft(draftKey, trade.id);
    } catch (e) {
      console.error('記録を読み込めませんでした', e);
      failed = true;
    }
    loading.stop();
    // 読み込み中に別の画面へ移っていたら、何も描かずに終わる（移った先の画面を壊さないため）
    if (!skeleton.isConnected) return;

    if (failed) {
      renderLoadError(root, nav, detailHash, () => screen.mount(root, { params, nav }));
      return;
    }
    if (!trade || trade.deletedAt != null) {
      await dropDraft(draftKey);
      renderMissing(root, nav);
      return;
    }
    // 下書きを作ったあとに元の記録が変わっていたら、下書きは使わずに破棄して知らせる（architecture 9.3・design 14.1.10）
    let staleText = '';
    if (draft && judgeDraftTarget(draft, trade) === 'stale') {
      await dropDraft(draftKey);
      draft = null;
      staleText = DRAFT_STALE_TEXT.edit;
    }
    ctrl = buildScreen(root, nav, trade, draft, { staleText });
  },

  unmount() {
    if (ctrl) ctrl.leave();
    ctrl = null;
  },

  hasUnsavedChanges() {
    return Boolean(ctrl && ctrl.hasUnsavedChanges());
  },

  discardMessage() {
    return ctrl ? ctrl.discardMessage() : '';
  },

  discardChanges() {
    return ctrl ? ctrl.discardChanges() : undefined;
  },
};

export default screen;
