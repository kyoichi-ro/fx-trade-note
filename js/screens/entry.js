/* =========================================================
   js/screens/entry.js
   S-02 エントリー記録。型B（入力画面）。URL：#/new（design.md 14.1、requirements F-01）

   【T-17 の範囲】必須6項目（①口座 ②通貨ペア ③売買方向 ④エントリー価格 ⑤ロット ⑥日時）の入力・入力チェック・保存と、
   下書きの自動保存・復元・破棄。「詳細（任意）」は開閉する入れ物だけで、中身（SL/TP・根拠・画像など）は T-18・T-24 で作る。

   画面の流れ：
   ・開いたとき：下書き（drafts の 'new'）があればその内容で開き、口座色の線の下に「入力途中の内容を復元しました［破棄］」。
     なければ初期値（口座・通貨ペア・ロットは前回値、ロットは口座ごと、売買方向は未選択、日時は今）で開く（design 14.1.5）。
   ・入力のたびに、初期値から変わっていれば0.5秒後に下書きを保存（drafts.js の自動保存の係。保存中の表示は出さない）。
   ・保存：入力チェック（validate.js）→ trades.js の saveNewTrade（status・セッション・lotUnitSize は trades.js が決める）
     → 前回値 lastInput を更新 → トースト「保存しました」→ 呼び出し元（一覧）へ戻る。
   ・「キャンセル」：変更があれば router.js の back() が破棄の確認を出す（この画面は hasUnsavedChanges / discardChanges を返すだけ）。

   文字はすべて ui/dom.js の h() を通す（innerHTML は使わない：architecture 14.1）。
   ========================================================= */
import { h, uniqueId } from '../ui/dom.js';
import { navbar, textButton, actionBar } from '../ui/bars.js';
import { button, listGroup, setBusy } from '../ui/parts.js';
import { numberRow, dateTimeRow, accountSegment, sideSegment, chips, setGroupMessages } from '../ui/fields.js';
import { icon } from '../ui/icons.js';
import { renderNotices } from '../ui/notice.js';
import { actionSheet, showAlert } from '../ui/dialog.js';
import { showToast } from '../ui/toast.js';
import { openSheet } from '../ui/sheet.js';
import { settingsStore } from '../settings-store.js';
import { PAIR_MASTER, getPairSpec } from '../master.js';
import { parsePrice, parseLots, isOutOfPriceRange, isLargeQuantity, normalizeNumberText } from '../validate.js';
import { saveNewTrade } from '../trades.js';
import { getDraft, discardDraft, draftKeyOf, DRAFT_KIND, createDraftAutosaver } from '../drafts.js';
import { nowInputValue, fromInputValue } from '../datetime.js';
import { formatDraftTime } from '../format.js';
import { newId, isAppError } from '../util.js';
import { FAVORITE_GRID_COUNT } from '../config.js';

/** 新規エントリーの下書きキー（drafts.js の約束：'new'） */
const DRAFT_KEY = draftKeyOf(DRAFT_KIND.NEW);

/** 必須グループの欄の並び（画面の上から＝エラーを探す順・フォーカスを移す順） */
const FIELD_ORDER = ['accountType', 'pair', 'side', 'entryPrice', 'lots', 'entryAt'];

/** よく使う通貨ペアのうち、格子に並べる数（3列×2段：design 14.1.2。設定の編集画面の「上から6つ」と同じ値を config.js から読む） */
const GRID_PAIRS = FAVORITE_GRID_COUNT;

/** 価格の欄の名前（E-01〜E-04・W-06 の文の先頭に付ける：design 14.1.8） */
const PRICE_LABEL = 'エントリー価格';

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
 * 下書きの fields と同じ形（入力欄の文字のまま：architecture 6.5）。
 */
function defaultFields() {
  const last = settingsStore.get('lastInput');
  const accountType = (last && last.accountType) || '';
  return {
    accountType,
    pair: (last && last.pair) || '',
    side: '',
    entryPrice: '',
    lots: lastLotsFor(accountType),
    entryAt: nowInputValue(),
  };
}

/** 下書きの fields を、知っている項目だけ文字として取り出す（壊れた下書きで画面が止まらないように） */
function fieldsFromDraft(draft, defaults) {
  const out = { ...defaults };
  const src = (draft && draft.fields) || {};
  for (const k of FIELD_ORDER) {
    if (typeof src[k] === 'string') out[k] = src[k];
  }
  if (!['demo', 'real', ''].includes(out.accountType)) out.accountType = defaults.accountType;
  if (!['buy', 'sell', ''].includes(out.side)) out.side = '';
  return out;
}

/** 「21:32 の下書き」（今日でなければ「10/14 21:32 の下書き」）：design 14.1.10。時刻の書き方は format.js にまとめている */
function draftTimeText(updatedAt) {
  const time = formatDraftTime(updatedAt);
  return time ? `${time} の下書き` : '';
}

/** 価格の見本：JPYペア「0.000」、非JPYペア「0.00000」（入力できる桁数に合わせる：design 14.1.5） */
function pricePlaceholder(pair) {
  const digits = pair ? getPairSpec(pair).maxInputDecimals : 3;
  return `0.${'0'.repeat(digits)}`;
}

/** 下部の保存ボタンの文字（口座を必ず添える：design 13章 ③・14.1.6） */
function saveLabel(accountType) {
  if (accountType === 'real') return '本番で保存';
  if (accountType === 'demo') return 'デモで保存';
  return '保存';
}

/* ---------------------------------------------------------
   入力チェック（design 14.1.8。判定は validate.js、文言はここ）
   --------------------------------------------------------- */

const PRICE_ERRORS = {
  'E-01': `${PRICE_LABEL}：数値で入力してください`,
  'E-02': `${PRICE_LABEL}：0より大きい値を入力してください`,
  'E-03': `${PRICE_LABEL}：価格は小数第3位までで入力してください`,
  'E-04': `${PRICE_LABEL}：価格は小数第5位までで入力してください`,
};
const LOTS_ERRORS = {
  'E-05': 'ロット：0より大きい値を入力してください',
  'E-06': 'ロット：ロットは小数第2位までで入力してください',
};

/**
 * 必須グループの全項目を確かめ、エラー・警告を欄の上からの順に返す。
 * @param {object} f 入力欄の文字（fields）
 * @returns {{ field: string, type: 'error'|'warning', text: string }[]}
 */
function checkFields(f) {
  const out = [];
  const err = (field, text) => out.push({ field, type: 'error', text });
  const warn = (field, text) => out.push({ field, type: 'warning', text });

  if (!f.accountType) err('accountType', 'デモか本番を選んでください');
  if (!f.pair) err('pair', '通貨ペアを選んでください');
  if (!f.side) err('side', '買いか売りを選んでください');

  // 価格：通貨ペアが未選択のときは桁数を決められないので、数値として読めるか・0より大きいかだけを見る
  // （桁の上限が大きい非JPYペアの規則で読み、E-01・E-02 だけを使う。桁数は通貨ペアを選んだ時点でその場で再チェックする）
  const price = parsePrice(f.entryPrice, f.pair || 'EUR/USD');
  if (price.empty) err('entryPrice', 'エントリー価格を入力してください');
  else if (!price.ok && (f.pair || price.error === 'E-01' || price.error === 'E-02')) err('entryPrice', PRICE_ERRORS[price.error]);
  else if (price.ok && f.pair && isOutOfPriceRange(price.value, f.pair)) {
    warn('entryPrice', `${PRICE_LABEL}：${f.pair} の価格としては大きく外れています。通貨ペアと桁を確認してください。`);
  }

  const lots = parseLots(f.lots);
  if (lots.empty) err('lots', 'ロットを入力してください');
  else if (!lots.ok) err('lots', LOTS_ERRORS[lots.error]);
  else if (f.accountType && isLargeQuantity(lots.value, settingsStore.get(`lotUnitSize.${f.accountType}`))) {
    warn('lots', '数量が非常に大きくなっています。ロットと1lotの通貨数を確認してください。');
  }

  if (!fromInputValue(f.entryAt)) err('entryAt', '日時を入力してください');
  return out;
}

/* ---------------------------------------------------------
   画面の部品
   --------------------------------------------------------- */

/**
 * 「その他の通貨ペア」のボトムシート（design 14.1.6）：上に検索欄、下に全ペア（よく使うペアが先頭）。タップで選んで閉じる。
 * @param {string[]} favorites 設定の「よく使う通貨ペア」（全部）
 * @param {string} selected 今選んでいるペア
 * @returns {Promise<string|null>} 選んだペア。キャンセルなら null
 */
function choosePair(favorites, selected) {
  // よく使うペア（設定で追加したペアを含む）→ マスタの残り、の順。同じペアは1回だけ
  const all = [...new Set([...favorites, ...PAIR_MASTER.map((p) => p.pair)])];
  // 検索は大文字小文字・全角半角・区切りの「/」を無視する（「eurAUD」「ユーロ」でも見つかるように）
  const norm = (s) => String(s).normalize('NFKC').toUpperCase().replace(/[\s/\-_]/g, '');

  return openSheet({
    title: '通貨ペア',
    content: (finish) => {
      const listBody = h('div', { class: 'list-group__body' });
      const renderList = (query) => {
        const q = norm(query);
        const hits = all.filter((p) => !q || norm(p).includes(q) || norm(getPairSpec(p).nameJa).includes(q));
        listBody.replaceChildren(...(hits.length ? hits.map((p) => h('button', {
          type: 'button', class: 'list-row pair-option', 'aria-pressed': p === selected ? 'true' : 'false', onClick: () => finish(p),
        },
        h('span', { class: 'list-row__label num' }, p),
        h('span', { class: 'list-row__value' }, getPairSpec(p).nameJa),
        p === selected ? icon('check', { size: 'sm', className: 'pair-option__check' }) : null)) : [
          h('p', { class: 'list-row pair-option__empty' }, '該当する通貨ペアがありません'),
        ]));
      };
      const search = h('input', {
        class: 'sheet-search__input', type: 'search', placeholder: 'EUR/AUD など', 'aria-label': '通貨ペアを検索',
        autocomplete: 'off', autocorrect: 'off', autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'search',
        onInput: (e) => renderList(e.target.value),
      });
      renderList('');
      return h('div', {},
        h('label', { class: 'sheet-search' }, icon('search', { size: 'sm', className: 'sheet-search__icon' }), search),
        h('section', { class: 'list-group' }, listBody));
    },
  });
}

/* ---------------------------------------------------------
   画面の組み立てと操作
   --------------------------------------------------------- */

/**
 * 画面の中身を作り、操作の係を返す。
 * @param {HTMLElement} root
 * @param {object} nav router.js の移動の道具
 * @param {object|null} draft 復元する下書き（なければ null）
 */
function buildScreen(root, nav, draft) {
  const defaults = defaultFields();
  const initial = { ...defaults }; // 「初期値から変わったか」の比べる相手（開いた時刻の日時を含む：architecture 9.2）
  const fields = draft ? fieldsFromDraft(draft, defaults) : { ...defaults };
  const tradeId = (draft && typeof draft.tradeId === 'string' && draft.tradeId) || newId(); // 開いた時点で採番（architecture 8章 ①・11.5）
  const ui = { detailsOpen: Boolean(draft && draft.uiState && draft.uiState.detailsOpen), returnTo: '#/' };
  const favorites = settingsStore.get('favoritePairs');
  const gridPairs = favorites.slice(0, GRID_PAIRS);

  let finished = false;      // 保存した・破棄した（もう下書きを作らない）
  let saving = false;
  let draftFailed = false;   // 下書きの保存に失敗している（design 14.7.6）
  let restored = Boolean(draft);
  const shown = new Set();   // エラー・警告の文を出してよい欄（欄から離れた・選んだ・保存を押した欄：design 14.1.8）

  const isChanged = () => FIELD_ORDER.some((k) => fields[k] !== initial[k]);

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
  // ロットは T-17 の時点で最後の文字入力欄なので「完了」（design 8.4。T-18 で SL・TP が続くようになったら見直す）
  const lots = numberRow({
    label: 'ロット', name: 'lots', value: fields.lots, unit: 'lot', placeholder: '0.1', enterkeyhint: 'done',
    onInput: (e) => { fields.lots = e.target.value; changed(); },
    onBlur: () => { if (fields.lots !== '') touched('lots'); else refresh(); },
  });
  const dt = dateTimeRow({
    label: '日時', name: 'entryAt', value: fields.entryAt,
    onNow: () => { dt.input.value = nowInputValue(); fields.entryAt = dt.input.value; touched('entryAt'); },
    onChange: () => { fields.entryAt = dt.input.value; touched('entryAt'); },
  });
  dt.input.addEventListener('input', () => { fields.entryAt = dt.input.value; changed(); });
  // PC の Enter キー：価格 → ロット → 入力を終える（iPhone の数字キーボードには Enter がないので、PC での確認用）
  price.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lots.input.focus(); } });
  lots.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lots.input.blur(); } });

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
      dt.row,
    ],
  });

  // 「詳細（任意）」：T-17 では開閉する入れ物だけ（中身は T-18・T-24）。毎回閉じた状態で開き、下書きの復元時だけ開閉状態を戻す
  const detailsId = uniqueId('details');
  const detailsBody = h('div', { class: 'entry-details__body', id: detailsId },
    h('p', { class: 'list-row placeholder-note' }, 'SL・TP、根拠、感情、タグ、メモ、画像は T-18 以降で追加します。'));
  const detailsToggle = h('button', {
    type: 'button', class: 'list-row entry-details__toggle', 'aria-controls': detailsId, onClick: () => toggleDetails(),
  },
  h('span', { class: 'entry-details__text' },
    h('span', { class: 'entry-details__title' }, '詳細（任意）'),
    h('span', { class: 'entry-details__sub' }, 'SL・TP、根拠、感情、タグ、メモ、画像')),
  icon('chevronRight', { size: 'sm', className: 'entry-details__chevron' }));
  const details = h('section', { class: 'list-group entry-details' }, h('div', { class: 'list-group__body' }, detailsToggle, detailsBody));

  const topSave = textButton('保存', { strong: true, onClick: () => save() });
  const saveBtn = button(saveLabel(fields.accountType), { variant: 'primary', block: true, onClick: () => save() });

  root.append(
    navbar({ left: textButton('キャンセル', { onClick: () => nav.back(ui.returnTo) }), title: '新規エントリー', right: topSave }),
    accountLine,
    h('div', { class: 'screen__body entry-body' }, notices, required, details),
    actionBar(saveBtn),
  );

  /* ----- 下書きの自動保存（architecture 9.2） ----- */
  const autosaver = createDraftAutosaver({
    key: DRAFT_KEY,
    hasStored: Boolean(draft),
    isChanged,
    build: () => ({
      kind: DRAFT_KIND.NEW, tradeId, fields: { ...fields }, uiState: { ...ui }, addedImageIds: [], removedImageIds: [],
    }),
    onStatus: (ok) => { if (draftFailed === ok) { draftFailed = !ok; renderNoticeRows(); } },
  });

  /* ----- 表示の更新 ----- */
  function renderAccount() {
    accountLine.dataset.account = fields.accountType || 'none';
    const label = saveBtn.querySelector('.btn__label');
    if (label && !saving) label.textContent = saveLabel(fields.accountType);
  }

  function renderPair() {
    const other = fields.pair && !gridPairs.includes(fields.pair);
    otherValue.replaceChildren(...(other ? [fields.pair, icon('check', { size: 'xs', className: 'other-pair__check' })] : []));
    otherRow.setAttribute('aria-label', other ? `その他の通貨ペア、${fields.pair}を選択中` : 'その他の通貨ペア');
    price.input.placeholder = pricePlaceholder(fields.pair);
  }

  function renderDetails() {
    detailsToggle.setAttribute('aria-expanded', ui.detailsOpen ? 'true' : 'false');
    detailsBody.hidden = !ui.detailsOpen;
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

  /** エラー・警告の文を出し直す（出してよい欄の分だけ）。戻り値は全項目の判定結果 */
  function refresh() {
    const issues = checkFields(fields);
    const targetOf = { accountType: account.el, pair: pairChips.el, side: side.el, entryPrice: price.input, lots: lots.input, entryAt: dt.input };
    setGroupMessages(required, issues.filter((i) => shown.has(i.field)).map((i) => ({ type: i.type, text: i.text, target: targetOf[i.field] })));
    return issues;
  }

  /* ----- 操作 ----- */
  function changed() {
    if (!finished) autosaver.schedule();
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
    // 入力済みの価格の桁数を新しいペアの上限でその場で再チェックする（design 14.1.8）
    if (fields.entryPrice !== '') shown.add('entryPrice');
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
    const el = {
      accountType: account.el.querySelector('input'), pair: pairChips.el.querySelector('button'),
      side: side.el.querySelector('input'), entryPrice: price.input, lots: lots.input, entryAt: dt.input,
    }[field];
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
  }

  function setSaving(on) {
    saving = on;
    setBusy(saveBtn, on);
    topSave.disabled = on;
    if (!on) renderAccount();
  }

  /** 保存（design 14.1.6・architecture 8章） */
  async function save() {
    if (saving || finished) return;
    FIELD_ORDER.forEach((k) => shown.add(k));
    const issues = refresh();
    const firstError = issues.find((i) => i.type === 'error');
    if (firstError) {
      focusField(firstError.field);
      return;
    }
    setSaving(true);
    // 自動保存を止め、保存中の下書きが書き終わるのを待つ（後から下書きが作り直されないように）
    await autosaver.stop();
    const input = {
      id: tradeId,
      accountType: fields.accountType,
      pair: fields.pair,
      side: fields.side,
      entryPrice: parsePrice(fields.entryPrice, fields.pair).value,
      lots: parseLots(fields.lots).value,
      entryAt: fromInputValue(fields.entryAt),
    };
    try {
      await saveNewTrade(input, { draftKey: DRAFT_KEY });
    } catch (e) {
      if (!isAppError(e, 'DUPLICATE')) {
        console.error('記録を保存できませんでした', e);
        setSaving(false);
        // 下書きは残す（もう一度保存できるよう、自動保存を再開して今の内容をすぐ書いておく：design 14.1.6）
        autosaver.resume();
        autosaver.flush();
        const choice = await showAlert({
          title: '保存できませんでした',
          message: '端末の空き容量が不足している可能性があります。入力内容はこの画面に残っています。',
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
    rememberLastInput(input.accountType, input.pair, normalizeNumberText(fields.lots));
    showToast('保存しました');
    nav.back(ui.returnTo);
  }

  /** 「入力途中の内容を復元しました［破棄］」（design 14.1.10）：確認して、下書きを消し、初期値に戻して画面に留まる */
  async function onDiscardRestored() {
    const ok = await actionSheet({
      title: '入力途中の内容を破棄しますか？',
      actions: [{ label: '入力内容を破棄', value: true, danger: true }],
    });
    if (ok !== true || finished) return;
    await discardAll();
    root.replaceChildren();
    window.scrollTo(0, 0);
    ctrl = buildScreen(root, nav, null);
  }

  /** 下書きを消し、この画面ではもう下書きを作らない（キャンセルの破棄・復元の破棄で使う） */
  async function discardAll() {
    finished = true;
    await autosaver.stop();
    autosaver.dispose();
    await discardDraft(DRAFT_KEY);
  }

  renderAccount();
  renderPair();
  renderDetails();
  renderNoticeRows();

  return {
    hasUnsavedChanges: () => !finished && isChanged(),
    discardChanges: () => discardAll(),
    /** 画面を離れる：保存も破棄もしていなければ、待たずに下書きを保存する（architecture 9.2） */
    leave() {
      if (!finished) autosaver.flush();
      autosaver.dispose();
    },
  };
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
    let draft = null;
    try {
      draft = await Promise.race([getDraft(DRAFT_KEY), new Promise((resolve) => { setTimeout(() => resolve(null), 2000); })]);
    } catch (e) {
      console.error('下書きを読み込めませんでした', e);
    }
    ctrl = buildScreen(root, nav, draft);
  },

  unmount() {
    if (ctrl) ctrl.leave();
    ctrl = null;
  },

  hasUnsavedChanges() {
    return Boolean(ctrl && ctrl.hasUnsavedChanges());
  },

  discardChanges() {
    return ctrl ? ctrl.discardChanges() : undefined;
  },
};
