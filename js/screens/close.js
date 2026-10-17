/* =========================================================
   js/screens/close.js
   S-03 決済記録。型B（入力画面）。URL：#/trades/{id}/close（design.md 14.2、requirements F-02）

   【T-21】保有中のトレードを決済済みにする画面。
   ・開いたら決済価格の欄にキーボードを自動で出す（iOS が出さなかったときは欄をタップすれば入力できる：design 14.2.2）。
     下書きを復元して開いたときは自動で出さない（先に復元内容を見せるため）。
   ・決済価格・円換算レート・日時を入れるたびに pips と損益（円）を即時に表示する（計算は close-form.js → trades.js → calc.js）。
   ・損益（円）は「確定損益を入力」で手入力に上書きできる（＋/− 切替＋数字キーボード）。符号付きの値を貼り付けたら切替を合わせる。
   ・「詳細（任意）」に決済理由・決済時の感情・タグ・メモ。タグ・メモはエントリー時の内容が入った状態で始まる。
   ・入力のたびに下書きを自動保存し、アプリが閉じられても続きから入力できる（drafts.js。entry.js と同じ仕組み）。
   ・保存：入力チェック → trades.js の closeTrade（保存されている最新の記録に決済を重ねる。status は自動判定）
     → 一覧に戻る行を1秒ハイライトする予約 → トースト → 呼び出し元へ戻る。
   ・対象が見つからない（削除済み・存在しない ID）ときは「この記録は見つかりません」。決済済みなら詳細（#/trades/{id}）を開く
     （architecture 5.1）。どちらも残っている下書きは黙って消す（design 14.2.10）。
   ・「キャンセル」：変更があれば router.js の back() が破棄の確認を出す（この画面は hasUnsavedChanges / discardChanges /
     discardTitle を返すだけ）。

   表示の組み立て・入力チェック・符号の貼り付けの解釈は js/close-form.js（画面に依存しない純粋な関数。テストあり）。
   タグは「＋追加」で、この画面の中で新しい名前を追加できる（設定の選択肢にも加わる。T-18：design 14.2.6 ⑥。ui/tag-picker.js）。
   【T-24】「詳細（任意）」の最後に画像。エントリー時の画像を先に並べ（この画面では削除できない：× を出さない）、
   続けて決済時に追加した画像（kind＝exit。× で確認なしに削除できる）。合わせて最大4枚。追加した画像の ID は下書き（addedImageIds）と
   決済の保存（trades.js の closeTrade の addImageIds：保存されている最新の imageIds に足す）で持つ。破棄・対象が無くなったときは追加した画像も消す。
   文字はすべて ui/dom.js の h() を通す（innerHTML は使わない：architecture 14.1）。
   ========================================================= */
import { h, uniqueId } from '../ui/dom.js';
import { navbar, textButton, backButton, actionBar } from '../ui/bars.js';
import { button, badge, listGroup, emptyState, setBusy, showLoadingAfter } from '../ui/parts.js';
import { numberRow, dateTimeRow, segment, chips, textareaRow, setGroupMessages } from '../ui/fields.js';
import { icon } from '../ui/icons.js';
import { tagPicker } from '../ui/tag-picker.js';
import { imageField } from '../ui/image-field.js';
import { IMAGE_TEXT } from '../images.js';
import { renderNotices } from '../ui/notice.js';
import { actionSheet, showAlert } from '../ui/dialog.js';
import { showToast } from '../ui/toast.js';
import { settingsStore } from '../settings-store.js';
import { getPairSpec, EXIT_REASON_LABELS } from '../master.js';
import { getTrade, closeTrade } from '../trades.js';
import { getDraft, discardDraft, draftKeyOf, DRAFT_KIND, createDraftAutosaver } from '../drafts.js';
import { nowInputValue } from '../datetime.js';
import { formatPrice, formatLots, formatDateTime, formatDraftTime } from '../format.js';
import { isClosedTrade } from '../filter.js';
import { isAppError } from '../util.js';
import { requestRowFlash } from '../row-flash.js';
import { judgeDraftTarget, DRAFT_STALE_TEXT } from '../draft-notice.js';
import { withSelected } from '../choice-list.js'; // 設定から消された選択済みの値もチップに残す（T-16 で choice-list.js へ移した）
import {
  EXIT_REASONS, defaultCloseFields, fieldsFromCloseDraft, isCloseFormChanged, detailsSummary, closeSaveLabel, closeToastText,
  initialManualSign, splitSignedAmount, formatAmountText, tidyAmount, evaluateClose, describeProfit, speakProfit,
  closeInputFromEvaluation, CLOSE_DETAILS_LIST,
} from '../close-form.js';

/** 今表示しているこの画面の操作の係（unmount・hasUnsavedChanges から使う） */
let ctrl = null;

/** 欄の並び（画面の上から＝エラーを探す順）。E-11（profitNeed）は保存を押したときだけ出す */
const FIELD_ORDER = ['exitPrice', 'quoteToJpyRate', 'exitAt', 'manualProfit', 'profitNeed'];

/** 損益の説明文（グループの下・13px・灰：design 14.2.3・14.2.5） */
const NOTE_AUTO = '自動計算はスワップ・手数料を含みません。';
const NOTE_MANUAL = '業者アプリに表示された確定損益を入力します。スワップ・手数料を含めた値にできます。';

/** 「確定損益を入力」の符号の切替を押した直後に、金額欄が空のまま自動計算に戻らないよう待つ時間（ミリ秒） */
const SIGN_TAP_GUARD_MS = 600;

/* ---------------------------------------------------------
   小さな部品
   --------------------------------------------------------- */

/** 「下書きの時刻」の文（entry.js と同じ書き方：「21:32 の下書き」） */
function draftTimeText(updatedAt) {
  const time = formatDraftTime(updatedAt);
  return time ? `${time} の下書き` : '';
}

/**
 * 対象トレードの要約（表示のみ・押せない：design 14.2.2）。
 * 1行目［口座］通貨ペア ▲買い、2行目 エントリー日時・ロット・エントリー価格、3行目 SL・TP（あるときだけ）。
 */
function summaryNode(trade, now) {
  const pair = trade.pair;
  const levels = [
    typeof trade.slPrice === 'number' ? `SL ${formatPrice(trade.slPrice, pair)}` : null,
    typeof trade.tpPrice === 'number' ? `TP ${formatPrice(trade.tpPrice, pair)}` : null,
  ].filter(Boolean);
  const row = h('div', { class: 'list-row close-summary__row' },
    h('div', { class: 'close-summary__title' },
      trade.accountType === 'demo' || trade.accountType === 'real' ? badge(trade.accountType) : null,
      h('span', { class: 'close-summary__pair' }, pair),
      trade.side === 'buy' || trade.side === 'sell' ? badge(trade.side) : null),
    h('div', { class: 'close-summary__meta num' },
      h('span', {}, formatDateTime(trade.entryAt, now)),
      h('span', {}, formatLots(trade.lots)),
      h('span', {}, formatPrice(trade.entryPrice, pair))),
    levels.length > 0 ? h('div', { class: 'close-summary__meta num' }, levels.map((x) => h('span', {}, x))) : null);
  return listGroup({ className: 'close-summary', rows: [row] });
}

/** 「この記録は見つかりません」（architecture 5.1・15.1：画面の中に空状態の形で出す） */
function renderMissing(root, nav) {
  root.replaceChildren(
    navbar({ left: backButton('一覧', () => nav.back('#/')), title: '決済' }),
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
function renderLoadError(root, nav, retry) {
  const notices = h('div', { class: 'entry-notices' });
  renderNotices(notices, [{
    iconName: 'warning', tone: 'error', text: 'データを読み込めませんでした', action: { label: '再読み込み', onClick: retry },
  }]);
  root.replaceChildren(
    navbar({ left: textButton('キャンセル', { onClick: () => nav.back('#/') }), title: '決済' }),
    h('div', { class: 'screen__body' }, notices),
  );
}

/* ---------------------------------------------------------
   画面の組み立てと操作
   --------------------------------------------------------- */

/**
 * 画面の中身を作り、操作の係を返す。
 * @param {HTMLElement} root
 * @param {object} nav router.js の移動の道具
 * @param {object} trade 保有中の記録
 * @param {object|null} draft 復元する下書き（なければ null）
 * @param {{ staleText?: string }} [opts] staleText：元の記録が変わったため下書きを破棄したときの知らせ（T-22：T-21 申し送り #9）
 */
function buildScreen(root, nav, trade, draft, { staleText = '' } = {}) {
  const spec = getPairSpec(trade.pair);
  const base = `#/trades/${encodeURIComponent(trade.id)}`;
  const draftKey = draftKeyOf(DRAFT_KIND.CLOSE, trade.id);
  const now = new Date();
  const defaults = defaultCloseFields(trade, nowInputValue(now));
  const initial = { ...defaults, tags: [...defaults.tags] }; // 「初期値から変わったか」の比べる相手（開いた時刻の日時を含む：architecture 9.2）
  const fields = draft ? fieldsFromCloseDraft(draft, defaults) : { ...defaults, tags: [...defaults.tags] };
  const ui = { detailsOpen: Boolean(draft && draft.uiState && draft.uiState.detailsOpen) };
  const choices = settingsStore.get('choices');

  let finished = false;      // 保存した・破棄した・対象が無くなった（もう下書きを作らない）
  let saving = false;
  let draftFailed = false;   // 下書きの保存に失敗している（design 14.7.6）
  const restored = Boolean(draft);
  let staleOpen = Boolean(staleText);
  const shown = new Set();   // エラー・警告の文を出してよい欄（欄から離れた・保存を押した欄：design 14.1.8）
  let signTapUntil = 0;      // この時刻までは、金額欄が空で外れても自動計算に戻さない（＋/− 切替を押している最中）
  let renderedKey = '';      // 損益グループに今並べている行の種類（変わったときだけ並べ直す）

  // 画像は入力欄の文字（fields）には入らない。この画面で追加した画像があれば「変更あり」
  const isChanged = () => isCloseFormChanged(initial, fields) || images.isChanged();
  const evaluate = () => evaluateClose(trade, fields, { now });

  /* ----- 決済グループ ----- */
  const price = numberRow({
    label: '決済価格', name: 'exitPrice', value: fields.exitPrice, placeholder: `0.${'0'.repeat(spec.maxInputDecimals)}`,
    enterkeyhint: spec.isJpyPair ? 'done' : 'next',
    onInput: (e) => { fields.exitPrice = e.target.value; onValueInput(); },
    onBlur: () => { announce(); if (fields.exitPrice !== '') touched('exitPrice'); else refresh(); },
  });
  const rate = spec.isJpyPair ? null : numberRow({
    // 円換算レートの欄名は「決済通貨/JPY」（EUR/USD・GBP/USD → USD/JPY：design 14.2.4）。前回値は入れない
    label: `円換算レート ${spec.quoteToJpyPair}`, name: 'quoteToJpyRate', value: fields.quoteToJpyRate, placeholder: '0.000',
    enterkeyhint: 'done',
    onInput: (e) => { fields.quoteToJpyRate = e.target.value; onValueInput(); },
    onBlur: () => { announce(); if (fields.quoteToJpyRate !== '') touched('quoteToJpyRate'); else refresh(); },
  });
  const dt = dateTimeRow({
    label: '日時', name: 'exitAt', value: fields.exitAt,
    onNow: () => { dt.input.value = nowInputValue(); fields.exitAt = dt.input.value; touched('exitAt'); },
    onChange: () => { fields.exitAt = dt.input.value; touched('exitAt'); },
  });
  dt.input.addEventListener('input', () => { fields.exitAt = dt.input.value; onValueInput(); });
  // PC の Enter キー：入力を終える（iPhone の数字キーボードには Enter がないので、PC での確認用）
  for (const el of [price.input, rate && rate.input]) {
    if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
  }
  const exitNote = spec.isJpyPair ? null
    : h('p', { class: 'close-note' }, `決済時点の${spec.quoteToJpyPair}を入れると損益（円）を自動計算します。空欄なら確定損益を入力してください。`);
  const exitGroup = listGroup({ header: '決済', className: 'close-exit', rows: [price.row, rate && rate.row, dt.row], footer: exitNote });

  /* ----- 損益グループ（自動計算の表示／確定損益の手入力：design 14.2.5・14.2.7） ----- */
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
  // 切替を押すと一瞬、金額欄から focus が外れる。そのとき金額が空でも自動計算に戻さないための目印
  signSeg.el.addEventListener('pointerdown', () => { signTapUntil = Date.now() + SIGN_TAP_GUARD_MS; });
  const amountInput = h('input', {
    class: 'form-row__input num', type: 'text', inputmode: 'numeric', name: 'manualProfit', enterkeyhint: 'done',
    value: formatAmountText(fields.manualAmount), placeholder: '0', 'aria-label': '確定損益の金額（円）',
    // 数字の欄では自動修正・自動の大文字化・入力候補が邪魔になるので止める（fields.js の numberRow と同じ）
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false',
    // 3 桁区切り（1,240）は欄から離れたときだけ付ける。編集中にカンマが残っていても、打つたびに onAmountInput が取り除く
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
  const announce = (() => {
    // 計算結果は 1 文字ごとには読み上げず、欄から離れたときに 1 回だけ読ませる（design 14.1.7 と同じ方針）
    const live = h('div', { class: 'visually-hidden', 'aria-live': 'polite' });
    profitGroup.append(live);
    return () => { live.textContent = speakProfit(evaluate()); };
  })();

  /* ----- 詳細（任意）：決済理由・決済時の感情・タグ・メモ ----- */
  const reasonChips = chips({
    label: '決済理由', options: EXIT_REASONS.map((v) => ({ value: v, label: EXIT_REASON_LABELS[v] })),
    selected: fields.exitReason ? [fields.exitReason] : [], multiple: false,
    onChange: (sel) => { fields.exitReason = sel[0] || ''; onDetailsChanged(); },
  });
  const emotionOptions = withSelected(choices.emotions, fields.exitEmotion ? [fields.exitEmotion] : []);
  const emotionChips = chips({
    label: '決済時の感情', options: emotionOptions.map((v) => ({ value: v, label: v })),
    selected: fields.exitEmotion ? [fields.exitEmotion] : [], multiple: false,
    onChange: (sel) => { fields.exitEmotion = sel[0] || ''; onDetailsChanged(); },
  });
  // タグは入力画面の中で新しい名前を追加できる。追加したタグは設定の選択肢にも加わる（design 14.2.6 ⑥、ui/tag-picker.js）
  const tags = tagPicker({ selected: fields.tags, onChange: (sel) => { fields.tags = sel; onDetailsChanged(); } });
  const memo = textareaRow({
    label: 'メモ', name: 'memo', value: fields.memo,
    onInput: (e) => { fields.memo = e.target.value; onDetailsChanged(); },
  });
  // 見出し「メモ」があるので、行の中のラベルは画面には出さず読み上げ用に残す
  memo.row.querySelector('.form-row__label').classList.add('visually-hidden');

  // 画像（エントリー時の画像＋この画面で追加する画像で最大4枚。エントリー時の画像は削除できない：design 14.2.10）
  const images = imageField({
    tradeId: trade.id, kind: 'exit', header: '画像（最大4枚・エントリーと合わせて）',
    existingIds: Array.isArray(trade.imageIds) ? trade.imageIds : [],
    addedIds: draft && Array.isArray(draft.addedImageIds) ? draft.addedImageIds : [],
    onChange: () => onDetailsChanged(),
    onBeforePick: () => { if (!finished) autosaver.flush(); },
    onAdded: () => { if (!finished) autosaver.flush(); },
  });

  const detailsId = uniqueId('details');
  const detailsBody = h('div', { class: 'close-details__body', id: detailsId },
    listGroup({ header: '決済理由', rows: [h('div', { class: 'field-row' }, reasonChips.el)] }),
    listGroup({ header: '決済時の感情', rows: [h('div', { class: 'field-row' }, emotionChips.el)] }),
    tags.el,
    listGroup({ header: 'メモ', rows: [memo.row], footer: 'エントリー時のメモに続けて書けます。' }),
    images.el);
  const detailsSub = h('span', { class: 'entry-details__sub' });
  const detailsToggle = h('button', {
    type: 'button', class: 'list-row entry-details__toggle', 'aria-controls': detailsId, onClick: () => toggleDetails(),
  },
  h('span', { class: 'entry-details__text' }, h('span', { class: 'entry-details__title' }, '詳細（任意）'), detailsSub),
  icon('chevronRight', { size: 'sm', className: 'entry-details__chevron' }));
  const details = h('section', { class: 'list-group entry-details' }, h('div', { class: 'list-group__body' }, detailsToggle));

  /* ----- 画面全体 ----- */
  const accountLine = h('div', { class: 'account-line', 'aria-hidden': 'true' });
  accountLine.dataset.account = trade.accountType === 'demo' || trade.accountType === 'real' ? trade.accountType : 'none';
  const notices = h('div', { class: 'entry-notices' });
  const topSave = textButton('保存', { strong: true, onClick: () => save() });
  const cancelBtn = textButton('キャンセル', { onClick: () => nav.back('#/') });
  const saveBtn = button(closeSaveLabel(trade.accountType), { variant: 'primary', block: true, onClick: () => save() });

  root.replaceChildren(
    navbar({ left: cancelBtn, title: '決済', right: topSave }),
    accountLine,
    h('div', { class: 'screen__body entry-body' }, notices, summaryNode(trade, now), exitGroup, profitGroup, details, detailsBody),
    actionBar(saveBtn),
  );

  /* ----- 下書きの自動保存（architecture 9.2。entry.js と同じ係） ----- */
  const autosaver = createDraftAutosaver({
    key: draftKey,
    hasStored: restored,
    isChanged,
    build: () => ({
      kind: DRAFT_KIND.CLOSE, tradeId: trade.id, fields: { ...fields, tags: [...fields.tags] }, uiState: { ...ui },
      addedImageIds: images.getAddedIds(), removedImageIds: [], baseUpdatedAt: trade.updatedAt,
    }),
    onStatus: (ok) => { if (draftFailed === ok) { draftFailed = !ok; renderNoticeRows(); } },
  });

  /* ----- 表示の更新 ----- */

  /** 損益の表示・行の並び・見本の更新（入力のたびに呼ぶ。エラー・警告の文は触らない：入力中は責めない） */
  function renderValues(ev) {
    const v = describeProfit(ev, fields);
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
    amountInput.placeholder = ev.autoProfitJpy == null ? '0' : formatAmountText(String(Math.abs(ev.autoProfitJpy)));

    // 行の並べ替えは「自動／手入力」「戻すボタン／注記」が変わったときだけ（入力中の欄を作り直さないため）
    const key = `${v.mode}:${v.back}`;
    if (key !== renderedKey) {
      renderedKey = key;
      const body = profitGroup.querySelector('.list-group__body');
      body.replaceChildren(...(v.mode === 'manual' ? [manualRow, manualPipsRow, manualRefRow, v.back === 'button' ? backBtn : backNote] : [autoRow, enterManualRow]));
    }
    profitNote.textContent = v.mode === 'manual' ? NOTE_MANUAL : NOTE_AUTO;
  }

  /** 出してよい欄のエラー・警告の文を出し直す（欄から離れた・保存を押した欄だけ：design 14.1.8） */
  function renderMessages(ev) {
    const show = (fieldsOfGroup) => ev.issues.filter((i) => fieldsOfGroup.includes(i.field) && shown.has(i.field));
    const targetOf = {
      exitPrice: price.input, quoteToJpyRate: rate && rate.input, exitAt: dt.input, manualProfit: amountInput,
      // E-11 は「円換算レートか確定損益」のうち打つ量が少ない円換算レートへ誘導する（design 14.2.9）
      profitNeed: rate && rate.input,
    };
    const toMessage = (i) => ({ type: i.type, text: i.text, target: targetOf[i.field] || undefined });
    setGroupMessages(exitGroup, show(['exitPrice', 'quoteToJpyRate', 'exitAt']).map(toMessage));
    setGroupMessages(profitGroup, show(['manualProfit', 'profitNeed']).map(toMessage));
  }

  function refresh() {
    const ev = evaluate();
    renderValues(ev);
    renderMessages(ev);
    return ev;
  }

  function renderDetails() {
    detailsToggle.setAttribute('aria-expanded', ui.detailsOpen ? 'true' : 'false');
    detailsBody.hidden = !ui.detailsOpen;
    // 閉じているとき、値が入っている項目名を 2 行目に出す（閉じても消えていないことが分かるように：design 14.1.4）
    detailsSub.textContent = ui.detailsOpen ? CLOSE_DETAILS_LIST : detailsSummary(fields, images.addedCount());
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
      // 下書きを作ったあとに元の記録が変わったので、下書きは使わずに破棄した（× で閉じるだけ：design 14.3.8）
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

  /** 入力のたびに：損益の表示だけ更新し、下書きの保存を予約する */
  function onValueInput() {
    renderValues(evaluate());
    changed();
  }

  /** 欄から離れた・選んだ：その欄の文を出してよいことにして出し直し、下書きの保存を予約する */
  function touched(field) {
    shown.add(field);
    refresh();
    changed();
  }

  function onDetailsChanged() {
    renderDetails();
    changed();
  }

  function toggleDetails() {
    ui.detailsOpen = !ui.detailsOpen;
    renderDetails();
    if (ui.detailsOpen) detailsToggle.scrollIntoView({ block: 'start', behavior: 'smooth' });
    // 開閉は「入力」ではないので下書きを新しく作る理由にはしないが、下書きがあるときは開閉状態も覚えておく（design 14.1.10）
    if (autosaver.hasStored()) changed();
  }

  /** 「確定損益を入力 ›」：手入力の行に変え、金額欄にフォーカスして数字キーボードを出す（design 14.2.5） */
  function enterManual() {
    const ev = evaluate();
    fields.profitMode = 'manual';
    fields.manualSign = initialManualSign(ev.pips); // pips がマイナスなら「−」、それ以外は「＋」
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

  /**
   * 金額欄の入力・貼り付け：符号が付いていたら切替をその符号に合わせ、金額欄には数字だけを残す（close-form.js の splitSignedAmount）。
   * 「−5,700」を貼ったのに切替が「＋」のまま＋5,700 で保存される事故を防ぐ。
   */
  function onAmountInput() {
    const r = splitSignedAmount(amountInput.value, fields.manualSign);
    if (r.sign !== fields.manualSign) {
      fields.manualSign = r.sign;
      signSeg.setValue(r.sign);
    }
    // 打っている途中の文字は、符号・カンマ・全角を直す必要があるときだけ書き換える（カーソルが飛ぶのを避けるため）
    if (r.amount !== amountInput.value) amountInput.value = r.amount;
    fields.manualAmount = r.amount;
    onValueInput();
  }

  function onAmountBlur(e) {
    fields.manualAmount = tidyAmount(fields.manualAmount);
    amountInput.value = formatAmountText(fields.manualAmount);
    if (fields.manualAmount !== '') {
      announce();
      touched('manualProfit');
      return;
    }
    // 金額が空のまま欄から離れたら自動計算の表示に戻る（空欄＝上書きしない：design 14.2.5）。
    // ただし ＋/− 切替を押している最中（focus が切替へ移る・切替を押した直後）は戻さない
    const movingToSign = e.relatedTarget && manualRow.contains(e.relatedTarget);
    if (movingToSign || Date.now() < signTapUntil) return;
    toAuto();
  }

  /** ＋/− 切替を押した：金額が入っていれば結果を確かめ、押したあとも続けて金額を打てるよう金額欄へ focus を戻す */
  function onSignChange(v) {
    fields.manualSign = v;
    if (fields.manualAmount !== '') touched('manualProfit');
    else onValueInput();
    amountInput.focus();
  }

  /** 最初のエラーの欄までスクロールしてフォーカス（design 14.1.8） */
  function focusField(field) {
    const el = {
      exitPrice: price.input, quoteToJpyRate: rate && rate.input, exitAt: dt.input, manualProfit: amountInput,
      profitNeed: rate && rate.input,
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
  }

  /** 保存（design 14.2.8・architecture 8章） */
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
    let saved;
    try {
      // 追加した画像は保存済み（images）。保存されている最新の imageIds の後ろに足す（addImageIds）
      saved = await closeTrade(trade.id, { ...closeInputFromEvaluation(ev, fields), addImageIds: images.getAddedIds() }, { draftKey });
    } catch (e) {
      await onSaveFailed(e);
      return;
    }
    finished = true;
    autosaver.dispose();
    images.dispose();
    requestRowFlash(trade.id); // 一覧に戻ったら、この行を 1 秒だけ目立たせる（design 14.3.4）
    showToast(closeToastText(saved.profitJpy));
    nav.back('#/');
  }

  /** 保存に失敗したとき（design 14.7.3・architecture 15.1） */
  async function onSaveFailed(e) {
    setSaving(false);
    if (isAppError(e, 'NOT_FOUND')) {
      // 開いている間に記録が削除された。入力先がないので下書きも消し、「見つかりません」を出す
      await discardAll();
      renderMissing(root, nav);
      return;
    }
    if (isAppError(e, 'ALREADY_CLOSED')) {
      // 別の画面で先に決済された。上書きせず、下書きを黙って消して詳細を開く（design 14.2.10）
      await discardAll();
      nav.replace(base);
      return;
    }
    if (isAppError(e, 'IMAGE_MISSING')) {
      // 追加した画像が images から消えていた：画面の一覧からも外して知らせる（決済は保存していない）
      await images.pruneMissing();
      autosaver.resume();
      autosaver.flush();
      await showAlert({ title: '保存できませんでした', message: '追加した画像の一部が見つかりませんでした。画像を追加し直してください。入力内容はこの画面に残っています。' });
      return;
    }
    console.error('決済を保存できませんでした', e);
    // 下書きは残す（もう一度保存できるよう、自動保存を再開して今の内容をすぐ書いておく：design 14.1.6）
    autosaver.resume();
    autosaver.flush();
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

  /** 「入力途中の内容を復元しました［破棄］」（design 14.1.10）：確認して、下書きを消し、初期値に戻して画面に留まる */
  async function onDiscardRestored() {
    const ok = await actionSheet({
      title: '入力途中の内容を破棄しますか？',
      message: images.addedCount() > 0 ? IMAGE_TEXT.discardNote : '',
      actions: [{ label: '入力内容を破棄', value: true, danger: true }],
    });
    if (ok !== true || finished) return;
    await discardAll();
    window.scrollTo(0, 0);
    ctrl = buildScreen(root, nav, trade, null);
  }

  /**
   * 下書きを消し、この画面ではもう下書きを作らない（キャンセルの破棄・復元の破棄・対象が無くなったときに使う）。
   * この画面で追加した画像も一緒に消す（孤立画像を残さない）。エントリー時の画像（記録に付いているもの）は消えない。
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
  renderDetails();
  renderNoticeRows();
  // 復元した下書きの手入力の状態に合わせて、金額欄を整える（編集中でないので 3 桁区切りで見せる）
  amountInput.value = formatAmountText(fields.manualAmount);
  // 開いたら決済価格にフォーカスしてキーボードを出す。下書きを復元したときは出さない（先に復元内容を見せる：design 14.2.2）。
  // 「決済」ボタンのタップから画面を描くまでの間に非同期の処理（画面ファイルの読み込み・記録の取得）が挟まるため、
  // iPhone ではキーボードが出ないことがある。そのときは欄をタップすれば入力できる（タップが 1 つ増えるだけ）
  if (!draft) price.input.focus({ preventScroll: true });

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

/** 下書きを読む。読めなくても初期値で開く（入力を止めない）。DB が詰まっていて 2 秒返らないときも初期値で開く（entry.js と同じ） */
async function readDraft(key, tradeId) {
  try {
    const draft = await Promise.race([getDraft(key), new Promise((resolve) => { setTimeout(() => resolve(null), 2000); })]);
    return draft && draft.tradeId === tradeId ? draft : null;
  } catch (e) {
    console.error('下書きを読み込めませんでした', e);
    return null;
  }
}

/** 下書きを消す（対象が削除・決済済みのとき：design 14.2.10・元の記録が変わったとき）。消せなくても画面は止めない */
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
  title: '決済',
  /** 「キャンセル」の確認シートの見出し（design 14.7.4：決済の破棄）。router.js の back() が使う */
  discardTitle: '決済の入力内容を破棄しますか？',

  async mount(root, { params, nav }) {
    const id = params.id;
    const base = `#/trades/${encodeURIComponent(id)}`;
    const draftKey = draftKeyOf(DRAFT_KIND.CLOSE, id);

    // 先にバーだけ出して、記録の読み込みを待つ（0.3秒以上かかるときだけ回転アイコン：design 9.15）
    const skeleton = navbar({
      left: textButton('キャンセル', { onClick: () => nav.back('#/') }), title: '決済', right: textButton('保存', { disabled: true, strong: true }),
    });
    const body = h('div', { class: 'screen__body' });
    root.replaceChildren(skeleton, body);
    const loading = showLoadingAfter(body);

    let trade = null;
    let draft = null;
    let failed = false;
    try {
      trade = await getTrade(id);
      if (trade && trade.deletedAt == null && !isClosedTrade(trade)) draft = await readDraft(draftKey, trade.id);
    } catch (e) {
      console.error('記録を読み込めませんでした', e);
      failed = true;
    }
    loading.stop();
    // 読み込み中に別の画面へ移っていたら、何も描かずに終わる（移った先の画面を壊さないため）
    if (!skeleton.isConnected) return;

    if (failed) {
      renderLoadError(root, nav, () => screen.mount(root, { params, nav }));
      return;
    }
    if (!trade || trade.deletedAt != null) {
      await dropDraft(draftKey);
      renderMissing(root, nav);
      return;
    }
    if (isClosedTrade(trade)) {
      // 決済済みの記録で決済画面を開いた（戻る操作など）：決済画面ではなく詳細を表示する（architecture 5.1）。下書きは黙って消す
      await dropDraft(draftKey);
      nav.replace(base);
      return;
    }
    // 下書きを作ったあとに元の記録が変わっていたら、下書きは使わずに破棄して知らせる
    // （エントリー時のタグ・メモが入った下書きで、あとから編集した内容を古い内容で戻さないため：T-21 申し送り #9）
    let staleText = '';
    if (draft && judgeDraftTarget(draft, trade) === 'stale') {
      await dropDraft(draftKey);
      draft = null;
      staleText = DRAFT_STALE_TEXT.close;
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
