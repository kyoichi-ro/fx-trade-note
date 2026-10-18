/* =========================================================
   js/screens/entry.js
   S-02 エントリー記録。型B（入力画面）。URL：#/new（design.md 14.1、requirements F-01）

   【T-17 の範囲】必須6項目（①口座 ②通貨ペア ③売買方向 ④エントリー価格 ⑤ロット ⑥日時）の入力・入力チェック・保存と、
   下書きの自動保存・復元・破棄。
   【T-18 の範囲】「詳細（任意）」の中身：SL・TP（リスクリワードを1文字ごとに表示・方向と矛盾する場合の警告 W-01 など）、根拠（複数選択）、
   時間足、セッション（日時から自動判定・手で変えたら上書きしない）、感情、タグ（画面の中で追加できる。設定の選択肢にも加わる）、メモ。
   詳細は毎回閉じた状態で開く（下書きから復元したときだけ、下書きの開閉状態に戻す：design 14.1.5）。閉じたままでも必須6項目だけで従来どおり保存できる。
   【T-24 の範囲】「詳細（任意）」の最後に画像（最大4枚）。選んだ画像は縮小・JPEG 圧縮して images に先に保存し（architecture 11.5）、
   その ID を下書き（addedImageIds）と保存する記録（imageIds）に持たせる。キャンセル・破棄したときは追加した画像も消す
   （孤立画像を残さない）。縮小中に保存を押したら、終わるのを待ってから保存する（design 14.1.9）。
   【T-29】保存の直後に永続化リクエスト（data-protection.js の requestPersistenceOnce：architecture 12.5）。
   保存の失敗のアラートの文を、容量不足（QUOTA）とそれ以外で分けた（design 14.7.3。決済・編集の画面とそろえた）。

   画面の流れ：
   ・開いたとき：下書き（drafts の 'new'）があればその内容で開き、口座色の線の下に「入力途中の内容を復元しました［破棄］」。
     なければ初期値（口座・通貨ペア・ロットは前回値、ロットは口座ごと、売買方向は未選択、日時は今）で開く（design 14.1.5）。
   ・入力のたびに、初期値から変わっていれば0.5秒後に下書きを保存（drafts.js の自動保存の係。保存中の表示は出さない）。
   ・保存：入力チェック（validate.js）→ trades.js の saveNewTrade（status・リスクリワード・lotUnitSize は trades.js が決める）
     → 前回値 lastInput を更新 → トースト「保存しました」→ 呼び出し元（一覧）へ戻る。
   ・任意項目の読み取り・リスクリワードの表示・警告・セッションの自動判定・下書きの読み直しは js/entry-form.js
     （画面に依存しない純粋な関数。テストあり）。この画面はその結果を並べて描くだけ。
   ・「キャンセル」：変更があれば router.js の back() が破棄の確認を出す（この画面は hasUnsavedChanges / discardChanges を返すだけ）。

   文字はすべて ui/dom.js の h() を通す（innerHTML は使わない：architecture 14.1）。
   ========================================================= */
import { h, uniqueId } from '../ui/dom.js';
import { navbar, textButton, actionBar } from '../ui/bars.js';
import { button, listGroup, setBusy } from '../ui/parts.js';
import {
  numberRow, dateTimeRow, accountSegment, sideSegment, segment, chips, textareaRow, setGroupMessages,
} from '../ui/fields.js';
import { tagPicker } from '../ui/tag-picker.js';
import { imageField } from '../ui/image-field.js';
import { IMAGE_TEXT } from '../images.js';
import { icon } from '../ui/icons.js';
import { renderNotices } from '../ui/notice.js';
import { actionSheet, showAlert } from '../ui/dialog.js';
import { showToast } from '../ui/toast.js';
import { choosePair } from '../ui/pair-chooser.js';
import { settingsStore } from '../settings-store.js';
import { TIMEFRAME_LABELS } from '../master.js';
import { parsePrice, parseLots, normalizeNumberText } from '../validate.js';
import { saveNewTrade, getAllTrades } from '../trades.js';
import { getDraft, discardDraft, draftKeyOf, DRAFT_KIND, createDraftAutosaver } from '../drafts.js';
import { nowInputValue, fromInputValue } from '../datetime.js';
import { formatDraftTime } from '../format.js';
import { newId, isAppError } from '../util.js';
import { requestPersistenceOnce } from '../data-protection.js';
import { FAVORITE_GRID_COUNT } from '../config.js';
import { withSelected } from '../choice-list.js'; // 設定から消された選択済みの値もチップに残す
import {
  ENTRY_REQUIRED_KEYS, ENTRY_OPTIONAL_FIELDS, TIMEFRAMES, SESSIONS, SESSION_SEGMENT_LABELS, ENTRY_DETAILS_LIST, SL_LABEL, TP_LABEL,
  defaultOptionalFields, cloneFields, fieldsFromEntryDraft, isEntryChanged, entryDetailsSummary, nextSession, sessionNote,
  evaluateLevels, visibleIssues, buildOptionalInput, checkRequiredFields, pricePlaceholder, PRICE_LABEL,
  LOTS_PLACEHOLDER, lotUnitHint,
} from '../entry-form.js';

/** 新規エントリーの下書きキー（drafts.js の約束：'new'） */
const DRAFT_KEY = draftKeyOf(DRAFT_KIND.NEW);

/** 必須グループの欄の並び（画面の上から＝エラーを探す順・フォーカスを移す順）。詳細（任意）の中の欄は ENTRY_OPTIONAL_FIELDS */
const FIELD_ORDER = ENTRY_REQUIRED_KEYS;

/** よく使う通貨ペアのうち、格子に並べる数（3列×2段：design 14.1.2。設定の編集画面の「上から6つ」と同じ値を config.js から読む） */
const GRID_PAIRS = FAVORITE_GRID_COUNT;

/** 今表示しているこの画面の操作の係（unmount・hasUnsavedChanges から使う） */
let ctrl = null;

/* ---------------------------------------------------------
   初期値と前回値（design 14.1.5、architecture 7.2）
   --------------------------------------------------------- */

/** 前回値（lastInput）から、その口座で前回使ったロット（入力した文字のまま）。なければ '' */
function lastLotsFor(accountType) {
  const last = settingsStore.get('lastInput');
  return (accountType && last && last.lots && last.lots[accountType]) || '';
}

/**
 * 初期値：口座・通貨ペアは前回値（初回は未選択）、ロットは選んでいる口座の前回値、売買方向は毎回未選択、日時は今。
 * 任意項目は空で、セッションだけ日時から自動判定した値（design 14.1.5）。
 * 下書きの fields と同じ形（入力欄の文字のまま：architecture 6.5）。
 */
function defaultFields() {
  const last = settingsStore.get('lastInput');
  const accountType = (last && last.accountType) || '';
  const entryAt = nowInputValue();
  return {
    accountType,
    pair: (last && last.pair) || '',
    side: '',
    entryPrice: '',
    lots: lastLotsFor(accountType),
    entryAt,
    ...defaultOptionalFields(entryAt),
  };
}

/** 「21:32 の下書き」（今日でなければ「10/14 21:32 の下書き」）：design 14.1.10。時刻の書き方は format.js にまとめている */
function draftTimeText(updatedAt) {
  const time = formatDraftTime(updatedAt);
  return time ? `${time} の下書き` : '';
}

/** 下部の保存ボタンの文字（口座を必ず添える：design 13章 ③・14.1.6） */
function saveLabel(accountType) {
  if (accountType === 'real') return '本番で保存';
  if (accountType === 'demo') return 'デモで保存';
  return '保存';
}

/* ---------------------------------------------------------
   入力チェック（design 14.1.8。判定・文言は entry-form.js の checkRequiredFields。T-22 で編集画面と共用にした）
   --------------------------------------------------------- */

/** 必須グループの全項目を確かめる。W-04 の 1lot の通貨数は「選んだ口座の今の設定値」 */
function checkFields(f) {
  return checkRequiredFields(f, { lotUnitSize: f.accountType ? settingsStore.get(`lotUnitSize.${f.accountType}`) : null });
}

/* ---------------------------------------------------------
   画面の部品
   --------------------------------------------------------- */

/* ---------------------------------------------------------
   画面の組み立てと操作
   --------------------------------------------------------- */

/**
 * 画面の中身を作り、操作の係を返す。
 * @param {HTMLElement} root
 * @param {object} nav router.js の移動の道具
 * @param {object|null} draft 復元する下書き（なければ null）
 * @param {{ firstRecord?: boolean }} [opts] firstRecord：記録が1件もない（ロットの行の下に「1lot＝1万通貨で計算します」を出す：T-33 U-02）
 */
function buildScreen(root, nav, draft, { firstRecord = false } = {}) {
  const defaults = defaultFields();
  const initial = cloneFields(defaults); // 「初期値から変わったか」の比べる相手（開いた時刻の日時を含む：architecture 9.2）
  const fields = draft ? fieldsFromEntryDraft(draft, defaults) : cloneFields(defaults);
  const tradeId = (draft && typeof draft.tradeId === 'string' && draft.tradeId) || newId(); // 開いた時点で採番（architecture 8章 ①・11.5）
  const ui = { detailsOpen: Boolean(draft && draft.uiState && draft.uiState.detailsOpen), returnTo: '#/' };
  const favorites = settingsStore.get('favoritePairs');
  const choices = settingsStore.get('choices');
  const gridPairs = favorites.slice(0, GRID_PAIRS);

  let finished = false;      // 保存した・破棄した（もう下書きを作らない）
  let saving = false;
  let draftFailed = false;   // 下書きの保存に失敗している（design 14.7.6）
  let restored = Boolean(draft);
  const shown = new Set();   // エラー・警告の文を出してよい欄（欄から離れた・選んだ・保存を押した欄：design 14.1.8）

  // 画像は入力欄の文字（fields）には入らない。追加した画像があれば「変更あり」（キャンセルの確認・下書きを作る判定）
  const isChanged = () => isEntryChanged(initial, fields) || images.isChanged();

  /* ----- 部品 ----- */
  const accountLine = h('div', { class: 'account-line', 'aria-hidden': 'true' });
  const notices = h('div', { class: 'entry-notices' });

  const account = accountSegment({ value: fields.accountType || null, onChange: (v) => onAccountChange(v) });
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
    onInput: (e) => { fields.entryPrice = e.target.value; changed(); },
    onBlur: () => { if (fields.entryPrice !== '') touched('entryPrice'); else refresh(); },
  });
  // ロットは、詳細を閉じているときは最後の文字入力欄なので「完了」、開いているときは SL へ続くので「次へ」（renderDetails が切り替える：design 8.4）
  // 見本は数字にしない（「0.1」だと入力済みの値に見えて、そのまま保存してエラーになる：T-33 U-01）
  const lots = numberRow({
    label: 'ロット', name: 'lots', value: fields.lots, unit: 'lot', placeholder: LOTS_PLACEHOLDER, enterkeyhint: 'done',
    onInput: (e) => { fields.lots = e.target.value; changed(); },
    onBlur: () => { if (fields.lots !== '') touched('lots'); else refresh(); },
  });
  const dt = dateTimeRow({
    label: '日時', name: 'entryAt', value: fields.entryAt,
    onNow: () => { dt.input.value = nowInputValue(); onEntryAtChange(dt.input.value); touched('entryAt'); },
    onChange: () => { onEntryAtChange(dt.input.value); touched('entryAt'); },
  });
  dt.input.addEventListener('input', () => { onEntryAtChange(dt.input.value); changed(); });
  // PC の Enter キー：価格 → ロット →（詳細を開いていれば）SL → TP → 入力を終える
  // （iPhone の数字キーボードには Enter がないので、PC での確認用。iPhone は ∧∨ で同じ順に移れる：design 14.1.3）
  price.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lots.input.focus(); } });
  lots.input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (ui.detailsOpen) sl.input.focus(); else lots.input.blur();
  });

  // 記録が1件もないときだけ、ロットの行の下に「1lot＝1万通貨で計算します（設定で変更）」（T-33 U-02。renderAccount が口座に合わせて書き換える）
  const lotHint = h('p', { class: 'field-hint', hidden: true });

  // 読み上げ用のまとまりの名前（design 14.1.2：セグメント・チップの行には画面上のラベルを置かない）
  const required = listGroup({
    header: '必須',
    className: 'entry-required',
    rows: [
      h('div', { class: 'field-row' }, account.el),
      h('div', { class: 'field-row' }, pairChips.el),
      otherRow,
      h('div', { class: 'field-row' }, side.el),
      price.row,
      lots.row,
      lotHint,
      dt.row,
    ],
  });

  /* ----- 詳細（任意）：SL・TP、根拠、時間足、セッション、感情、タグ、メモ（design 14.1.4）。毎回閉じた状態で開く ----- */

  // 損切り・利確：SL・TP とリスクリワードの自動表示。リスクリワードは事実の表示のみ（値の良し悪しを色やコメントで評価しない：design 14.1.7）
  const sl = numberRow({
    label: SL_LABEL, name: 'slPrice', value: fields.slPrice, placeholder: pricePlaceholder(fields.pair),
    onInput: (e) => { fields.slPrice = e.target.value; changed(); },
    onBlur: () => { announceRr(); if (fields.slPrice !== '') touched('slPrice'); else refresh(); },
  });
  const tp = numberRow({
    label: TP_LABEL, name: 'tpPrice', value: fields.tpPrice, placeholder: pricePlaceholder(fields.pair), enterkeyhint: 'done',
    onInput: (e) => { fields.tpPrice = e.target.value; changed(); },
    onBlur: () => { announceRr(); if (fields.tpPrice !== '') touched('tpPrice'); else refresh(); },
  });
  sl.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tp.input.focus(); } });
  tp.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tp.input.blur(); } });
  const rrValue = h('span', { class: 'rr-row__value num' });
  const rrSub = h('span', { class: 'rr-row__sub num' });
  const rrRow = h('div', { class: 'list-row rr-row' }, h('span', { class: 'list-row__label' }, 'リスクリワード'), rrValue, rrSub);
  const levelsGroup = listGroup({ header: '損切り・利確', className: 'entry-levels', rows: [sl.row, tp.row, rrRow] });
  // 計算結果は1文字ごとには読み上げず、欄から離れたときに1回だけ読ませる（design 14.1.7）
  const rrLive = h('div', { class: 'visually-hidden', 'aria-live': 'polite' });
  levelsGroup.append(rrLive);

  /** 選択肢がひとつもないとき（設定ですべて削除した）の案内。設定へ行けば足せることを伝える */
  const emptyHint = (kindLabel) => h('p', { class: 'choice-empty' }, `選択肢がありません。設定の「${kindLabel}」で追加できます。`);

  const reasonOptions = withSelected(choices.entryReasons, fields.entryReasons);
  const reasonChips = chips({
    label: 'エントリー根拠', options: reasonOptions.map((v) => ({ value: v, label: v })), selected: fields.entryReasons, multiple: true,
    onChange: (sel) => { fields.entryReasons = sel; onDetailsChanged(); },
  });
  const timeframeChips = chips({
    label: '時間足', options: TIMEFRAMES.map((v) => ({ value: v, label: TIMEFRAME_LABELS[v] })),
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
    label: '感情', options: emotionOptions.map((v) => ({ value: v, label: v })), selected: fields.emotion ? [fields.emotion] : [], multiple: false,
    onChange: (sel) => { fields.emotion = sel[0] || ''; onDetailsChanged(); },
  });
  // タグだけ、この画面の中で追加できる（追加したタグは設定の選択肢にも加わる：design 14.1.5）
  const tags = tagPicker({ selected: fields.tags, onChange: (sel) => { fields.tags = sel; onDetailsChanged(); } });
  const memo = textareaRow({
    label: 'メモ', name: 'memo', value: fields.memo, warnAt: 100, // 1,900文字を超えたら残り文字数（design 14.1.5）
    onInput: (e) => { fields.memo = e.target.value; onDetailsChanged(); },
  });
  // 見出し「メモ」があるので、行の中のラベルは画面には出さず読み上げ用に残す
  memo.row.querySelector('.form-row__label').classList.add('visually-hidden');

  // 画像（最大4枚）。追加した画像の ID は下書きに、保存したら記録の imageIds になる（architecture 11.5）
  const images = imageField({
    tradeId, kind: 'entry', addedIds: draft && Array.isArray(draft.addedImageIds) ? draft.addedImageIds : [],
    onChange: () => onDetailsChanged(),
    // 写真の選択画面・カメラを開く直前と、画像を 1 枚保存した直後に、下書きをすぐ書く（iPhone はカメラ起動でページが再読み込みされることがある：architecture 9.2）
    onBeforePick: () => { if (!finished) autosaver.flush(); },
    onAdded: () => { if (!finished) autosaver.flush(); },
  });

  const detailsId = uniqueId('details');
  const detailsBody = h('div', { class: 'entry-details__body', id: detailsId },
    levelsGroup,
    listGroup({ header: '根拠（複数選択）', rows: [h('div', { class: 'field-row' }, reasonChips.el, choices.entryReasons.length === 0 && fields.entryReasons.length === 0 ? emptyHint('エントリー根拠') : null)] }),
    listGroup({ header: '時間足', rows: [h('div', { class: 'field-row' }, timeframeChips.el)] }),
    sessionGroup,
    listGroup({ header: '感情', rows: [h('div', { class: 'field-row' }, emotionChips.el, choices.emotions.length === 0 && !fields.emotion ? emptyHint('感情') : null)] }),
    tags.el,
    listGroup({ header: 'メモ', rows: [memo.row] }),
    images.el);
  const detailsSub = h('span', { class: 'entry-details__sub' });
  const detailsToggle = h('button', {
    type: 'button', class: 'list-row entry-details__toggle', 'aria-controls': detailsId, onClick: () => toggleDetails(),
  },
  h('span', { class: 'entry-details__text' },
    h('span', { class: 'entry-details__title' }, '詳細（任意）'),
    detailsSub),
  icon('chevronRight', { size: 'sm', className: 'entry-details__chevron' }));
  const details = h('section', { class: 'list-group entry-details' }, h('div', { class: 'list-group__body' }, detailsToggle));

  const topSave = textButton('保存', { strong: true, onClick: () => save() });
  const saveBtn = button(saveLabel(fields.accountType), { variant: 'primary', block: true, onClick: () => save() });

  root.append(
    navbar({ left: textButton('キャンセル', { onClick: () => nav.back(ui.returnTo) }), title: '新規エントリー', right: topSave }),
    accountLine,
    h('div', { class: 'screen__body entry-body' }, notices, required, details, detailsBody),
    actionBar(saveBtn),
  );

  /* ----- 下書きの自動保存（architecture 9.2） ----- */
  const autosaver = createDraftAutosaver({
    key: DRAFT_KEY,
    hasStored: Boolean(draft),
    isChanged,
    build: () => ({
      kind: DRAFT_KIND.NEW, tradeId, fields: cloneFields(fields), uiState: { ...ui }, addedImageIds: images.getAddedIds(), removedImageIds: [],
    }),
    onStatus: (ok) => { if (draftFailed === ok) { draftFailed = !ok; renderNoticeRows(); } },
  });

  /* ----- 表示の更新 ----- */
  function renderAccount() {
    accountLine.dataset.account = fields.accountType || 'none';
    const label = saveBtn.querySelector('.btn__label');
    if (label && !saving) label.textContent = saveLabel(fields.accountType);
    renderLotHint();
  }

  /** 「1lot＝1万通貨で計算します（設定で変更）」：記録0件のときだけ。数値は選んだ口座の今の設定値（T-33 U-02） */
  function renderLotHint() {
    const text = firstRecord
      ? lotUnitHint(fields.accountType, { demo: settingsStore.get('lotUnitSize.demo'), real: settingsStore.get('lotUnitSize.real') })
      : '';
    lotHint.textContent = text;
    lotHint.hidden = text === '';
  }

  function renderPair() {
    const other = fields.pair && !gridPairs.includes(fields.pair);
    otherValue.replaceChildren(...(other ? [fields.pair, icon('check', { size: 'xs', className: 'other-pair__check' })] : []));
    otherRow.setAttribute('aria-label', other ? `その他の通貨ペア、${fields.pair}を選択中` : 'その他の通貨ペア');
    for (const row of [price, sl, tp]) row.input.placeholder = pricePlaceholder(fields.pair);
  }

  function renderDetails() {
    detailsToggle.setAttribute('aria-expanded', ui.detailsOpen ? 'true' : 'false');
    detailsBody.hidden = !ui.detailsOpen;
    // 閉じているとき、値が入っている項目名を2行目に出す（閉じても消えていないことが分かるように：design 14.1.4）
    detailsSub.textContent = ui.detailsOpen ? ENTRY_DETAILS_LIST : entryDetailsSummary(fields, images.addedCount());
    // ロットの次に SL へ進めるのは、詳細を開いているときだけ
    lots.input.setAttribute('enterkeyhint', ui.detailsOpen ? 'next' : 'done');
  }

  /** セッション欄の選択と、その下の説明（自動で判定したか／手動か） */
  function renderSession() {
    sessionSeg.setValue(fields.session || null);
    sessionGroup.querySelector('.list-group__footer').textContent = sessionNote(fields);
  }

  /** リスクリワードの欄を、今の入力で更新する（1文字入力するたびに呼ぶ：design 14.1.7。エラー・警告の文は触らない） */
  function renderLevels() {
    const lv = evaluateLevels(fields);
    rrValue.textContent = lv.rr.value;
    rrValue.classList.toggle('is-empty', lv.rr.value === '—');
    rrSub.textContent = lv.rr.sub || '';
    rrSub.hidden = !lv.rr.sub;
    return lv;
  }

  function announceRr() {
    const lv = evaluateLevels(fields);
    rrLive.textContent = lv.rr.value === '—' ? '' : `リスクリワード ${lv.rr.value}`;
  }

  function renderNoticeRows() {
    const items = [];
    if (restored) {
      items.push({
        iconName: 'pencil', text: '入力途中の内容を復元しました', subtext: draftTimeText(draft.updatedAt),
        action: { label: '破棄', onClick: () => onDiscardRestored() },
      });
    }
    if (draftFailed) {
      items.push({ iconName: 'warning', tone: 'warning', text: '下書きを保存できません', subtext: 'アプリを閉じると入力内容が消えます。' });
    }
    renderNotices(notices, items);
  }

  /**
   * エラー・警告の文を出し直す（出してよい欄の分だけ）。戻り値は全項目の判定結果（画面の上から順：必須 → 損切り・利確）。
   * 損切り・利確の W-01 は、通貨ペア・売買方向・エントリー価格・SL・TP がそろったときだけ出る（fx-rules 5.3）ので、
   * SL だけ先に入れた途中には出ない。
   */
  function refresh() {
    const issues = checkFields(fields);
    const targetOf = { accountType: account.el, pair: pairChips.el, side: side.el, entryPrice: price.input, lots: lots.input, entryAt: dt.input };
    setGroupMessages(required, issues.filter((i) => shown.has(i.field)).map((i) => ({ type: i.type, text: i.text, target: targetOf[i.field] })));
    const levelIssues = evaluateLevels(fields).issues;
    const levelTarget = { slPrice: sl.input, tpPrice: tp.input };
    setGroupMessages(levelsGroup, visibleIssues(levelIssues, shown).map((i) => ({ type: i.type, text: i.text, target: levelTarget[i.field] })));
    return [...issues, ...levelIssues];
  }

  /* ----- 操作 ----- */
  function changed() {
    renderLevels();
    renderDetails();
    if (!finished) autosaver.schedule();
  }

  /**
   * エントリー日時が変わった：セッションが「自動のまま」なら新しい日時で判定し直し、手で選んでいたら残す
   * （fx-rules 11.7 の再判定のタイミング。判断は entry-form.js の nextSession）
   */
  function onEntryAtChange(next) {
    const prev = fields.entryAt;
    fields.entryAt = next;
    fields.session = nextSession(prev, next, fields.session);
    renderSession();
  }

  /** 詳細（任意）の中の選択・入力が変わった：閉じたときの2行目を更新し、下書きの保存を予約する */
  function onDetailsChanged() {
    renderSession(); // セッションの説明（自動／手動）は、日時以外の変更では変わらないが、手で選んだ直後はここで更新する
    changed();
  }

  /** 欄から離れた・選んだ：その欄の文を出してよいことにして出し直し、下書きの保存を予約する */
  function touched(field) {
    shown.add(field);
    refresh();
    changed();
  }

  function onAccountChange(v) {
    const prev = fields.accountType;
    fields.accountType = v;
    // ロットは口座ごとの前回値に入れ替える（design 14.1.5 ⑤）。ただし手で打ち直したロットは消さない
    // （前の口座の前回値のままのときだけ入れ替える。打った値が黙って消える事故を防ぐため）
    if (fields.lots === lastLotsFor(prev)) {
      fields.lots = lastLotsFor(v);
      lots.input.value = fields.lots;
    }
    renderAccount();
    touched('accountType');
  }

  function onPairChange(pair) {
    fields.pair = pair;
    renderPair();
    // 入力済みの価格（エントリー価格・SL・TP）の桁数を新しいペアの上限でその場で再チェックする（design 14.1.8）
    if (fields.entryPrice !== '') shown.add('entryPrice');
    if (fields.slPrice !== '') shown.add('slPrice');
    if (fields.tpPrice !== '') shown.add('tpPrice');
    touched('pair');
  }

  async function onOtherPair() {
    const picked = await choosePair(favorites, fields.pair);
    if (!picked || finished) return;
    pairChips.setSelected([picked]); // 格子にないペアなら、格子のチップはどれも選択中にならない
    onPairChange(picked);
  }

  function toggleDetails() {
    ui.detailsOpen = !ui.detailsOpen;
    renderDetails();
    if (ui.detailsOpen) detailsToggle.scrollIntoView({ block: 'start', behavior: 'smooth' });
    // 開閉は「入力」ではないので下書きを新しく作る理由にはしないが、下書きがあるときは開閉状態も覚えておく（design 14.1.10）
    if (autosaver.hasStored()) changed();
  }

  /** 最初のエラーの欄までスクロールしてフォーカス（design 14.1.8） */
  function focusField(field) {
    // 詳細（任意）の中の欄でエラーのときは、詳細を自動で開いてからフォーカスする（design 14.1.8）
    if (ENTRY_OPTIONAL_FIELDS.includes(field) && !ui.detailsOpen) {
      ui.detailsOpen = true;
      renderDetails();
    }
    const el = {
      accountType: account.el.querySelector('input'), pair: pairChips.el.querySelector('button'),
      side: side.el.querySelector('input'), entryPrice: price.input, lots: lots.input, entryAt: dt.input,
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
    // 保存の途中に画像を足す・外すと、記録に入らないまま消えることがあるので押せなくする（T-30 の R-04）
    images.setDisabled(on);
    if (!on) renderAccount();
  }

  /** 保存（design 14.1.6・architecture 8章） */
  async function save() {
    if (saving || finished) return;
    [...FIELD_ORDER, ...ENTRY_OPTIONAL_FIELDS].forEach((k) => shown.add(k));
    const issues = refresh();
    const firstError = issues.find((i) => i.type === 'error');
    if (firstError) {
      focusField(firstError.field);
      return;
    }
    setSaving(true);
    // 画像の縮小・保存の途中なら、終わるのを待ってから保存する（ボタンは「保存中」のまま：design 14.1.9）
    await images.whenIdle();
    // 自動保存を止め、保存中の下書きが書き終わるのを待つ（後から下書きが作り直されないように）
    await autosaver.stop();
    if (finished) return; // 待っている間に「入力内容を破棄」が選ばれた（画像も消えている）。保存しない
    const input = {
      id: tradeId,
      accountType: fields.accountType,
      pair: fields.pair,
      side: fields.side,
      entryPrice: parsePrice(fields.entryPrice, fields.pair).value,
      lots: parseLots(fields.lots).value,
      entryAt: fromInputValue(fields.entryAt),
      // 任意項目（SL・TP・根拠・時間足・セッション・感情・タグ・メモ）。riskReward は保存側が calcRiskReward で決める
      ...buildOptionalInput(fields),
      // 追加した画像は保存済み（images）。記録には ID だけを持たせる。保存が失敗しても画像は下書きが覚えているので孤立しない
      imageIds: images.getAddedIds(),
    };
    try {
      await saveNewTrade(input, { draftKey: DRAFT_KEY });
    } catch (e) {
      if (!isAppError(e, 'DUPLICATE')) {
        console.error('記録を保存できませんでした', e);
        setSaving(false);
        // 追加した画像が images から消えていたとき（別の画面・掃除で消えた）は、画面の一覧からも外して知らせる（記録は保存していない）
        if (isAppError(e, 'IMAGE_MISSING')) {
          await images.pruneMissing();
          autosaver.resume();
          autosaver.flush();
          await showAlert({ title: '保存できませんでした', message: '追加した画像の一部が見つかりませんでした。画像を追加し直してください。入力内容はこの画面に残っています。' });
          return;
        }
        // 下書きは残す（もう一度保存できるよう、自動保存を再開して今の内容をすぐ書いておく：design 14.1.6）
        autosaver.resume();
        autosaver.flush();
        // 容量不足（QUOTA）とそれ以外の失敗で文を分ける（design 14.7.3。決済・編集の画面と同じ分け方。
        // 容量の問題でないのに「空き容量が不足」と出すと、利用者が要らない写真を消してしまうなど、見当違いの対処をするため）
        const choice = await showAlert({
          title: '保存できませんでした',
          message: isAppError(e, 'QUOTA')
            ? '端末の空き容量が不足している可能性があります。入力内容はこの画面に残っています。'
            : '保存中に問題が起きました。入力内容はこの画面に残っています。',
          buttons: [{ label: '閉じる', value: 'close' }, { label: 'もう一度保存', value: 'retry', primary: true }],
        });
        if (choice === 'retry') save();
        return;
      }
      // 同じ ID がすでに保存されている＝前回の保存は成功していた（二重保存の防止：architecture 8章・15.1）。
      // 記録の保存と同じトランザクションの下書き削除は取り消されているので、ここで消す
      await discardDraft(DRAFT_KEY).catch((err) => console.error('下書きを消せませんでした', err));
    }
    finished = true;
    autosaver.dispose();
    images.dispose();
    rememberLastInput(input.accountType, input.pair, normalizeNumberText(fields.lots));
    // 最初の記録を保存した直後に、ブラウザへ「データを勝手に消さないで」と頼む（architecture 12.5。
    // 記録があれば起動時にも頼むが、記録0件で始めた起動ではここが最初の機会になる）。1回の起動で1回だけで、待たない
    requestPersistenceOnce();
    showToast('保存しました');
    nav.back(ui.returnTo);
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
    root.replaceChildren();
    window.scrollTo(0, 0);
    ctrl = buildScreen(root, nav, null, { firstRecord });
  }

  /**
   * 下書きを消し、この画面ではもう下書きを作らない（キャンセルの破棄・復元の破棄で使う）。
   * この入力で追加した画像も一緒に消す（孤立画像を残さない：architecture 9.4）。下書きにまだ書けていない画像
   * （0.5秒の待ちの途中など）も、画面が覚えている ID で確実に消す。縮小中の画像は dispose で捨てる。
   */
  async function discardAll() {
    finished = true;
    const added = images.getAddedIds();
    images.dispose();
    await autosaver.stop();
    autosaver.dispose();
    await discardDraft(DRAFT_KEY, { alsoImageIds: added });
  }

  renderAccount();
  renderPair();
  renderDetails();
  renderSession();
  renderLevels();
  renderNoticeRows();

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

/** 記録（削除済みを除く）が1件もないか */
async function hasNoRecords() {
  const trades = await getAllTrades();
  return !trades.some((t) => t && t.deletedAt == null);
}

/**
 * 前回値（lastInput）を更新する。新規エントリーの保存に成功したときだけ呼ぶ（design 14.1.5・architecture 7.2）。
 * ロットは保存した口座の分だけ書き換え、もう一方の口座のロットは残す。売買方向は覚えない。
 * 書き込めなくても記録は保存済みなので、利用者には知らせずにコンソールに残すだけにする
 * （「保存しました」の直後に「設定を保存できませんでした」と出すと、記録まで失敗したように見えるため）。
 */
function rememberLastInput(accountType, pair, lotsText) {
  try {
    const last = settingsStore.get('lastInput');
    const lotsByAccount = { demo: null, real: null, ...((last && last.lots) || {}) };
    lotsByAccount[accountType] = lotsText;
    settingsStore.set('lastInput', { accountType, pair, lots: lotsByAccount });
  } catch (e) {
    console.warn('前回値を保存できませんでした', e);
  }
}

export default {
  layout: 'form',
  tab: null,
  title: '新規エントリー',

  async mount(root, { nav }) {
    // 下書きがあれば、前回値ではなく下書きの内容で開く（design 14.1.10）。読めなくても初期値で開く（入力を止めない）
    // 他の画面が古い版の DB を開いたままだと読み込みが終わらないので、2秒待っても返らなければ初期値で開く（画面を真っ白にしない）
    // 記録が1件もないか（「1lot＝1万通貨で計算します」を出すか：T-33 U-02）も同時に確かめる。読めない・2秒で返らないときは出さない
    const [draft, firstRecord] = await Promise.all([
      Promise.race([getDraft(DRAFT_KEY), new Promise((resolve) => { setTimeout(() => resolve(null), 2000); })])
        .catch((e) => { console.error('下書きを読み込めませんでした', e); return null; }),
      Promise.race([hasNoRecords(), new Promise((resolve) => { setTimeout(() => resolve(false), 2000); })])
        .catch((e) => { console.error('記録の件数を確かめられませんでした', e); return false; }),
    ]);
    ctrl = buildScreen(root, nav, draft, { firstRecord });
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
