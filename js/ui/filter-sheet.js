/* =========================================================
   js/ui/filter-sheet.js
   一覧の絞り込みシート（design.md 14.3.10、analytics.md 4.2〜4.5）。T-23 で作成。

   ・ボトムシート（ui/sheet.js）に、上部の「すべて解除」と、下部に固定した主要ボタン「12件を表示」を足した形。
   ・項目の順は キーワード → 口座 → 期間 → 勝敗 → 状態 → 売買方向 → 通貨ペア（週末の振り返りでよく使う順。上の4つはスクロールせずに見える）。
   ・シートの中で触るのは条件の「写し」だけ。「n件を表示」を押すまで一覧は変わらず、「キャンセル」・背景タップ・Esc なら写しを捨てる
     （確認は出さない：絞り込み条件は失っても困らないため）。
   ・条件を変えるたびに、ボタンの件数をメモリ上の全件から数え直す（数ミリ秒。キーワードだけ入力が0.25秒止まってから：analytics 4.5.2）。
     0件になる条件のときはボタンを押せなくして「該当する記録がありません」と出す（0件の一覧を開かせない）。
   ・「状態＝保有中」にすると勝敗は選べない（必ず0件になる組み合わせを作らせない：analytics 4.2）。
   ・キーワード欄で「検索」キーを押すと「n件を表示」と同じ（日本語入力の変換を確定するだけの Enter では適用しない）。
   ・文字はすべて ui/dom.js の h() を通す（キーワードも textContent 相当：XSS 対策）。

   使い方：const next = await openFilterSheet({ trades, filter, nowMs, favorites });  // 適用なら新しい条件、やめたら null
   ========================================================= */
import { h } from './dom.js';
import { icon } from './icons.js';
import { openSheet } from './sheet.js';
import { button, listGroup } from './parts.js';
import { textButton } from './bars.js';
import { segment, chips } from './fields.js';
import {
  PERIOD_PRESETS, PERIOD_LABELS, OUTCOMES, OUTCOME_LABELS, KEYWORD_MAX_LENGTH,
  cloneFilter, defaultFilter, fixConflicts, countMatches, countActiveConditions, pairOptions, describePeriodRange, formatYmdLabel,
} from '../filter.js';

/** キーワードの入力が止まってから件数を数え直すまでの待ち（analytics 4.5.2：打つたびに毎回数えない） */
const KEYWORD_DEBOUNCE_MS = 250;

const ALL = { value: 'all', label: 'すべて' };

/** グループ（見出し＋白いまとまり＋下の説明）。中身は1つの `.filter-row` に入れる */
function section(header, child, footer = null) {
  return listGroup({ header, rows: [h('div', { class: 'filter-row' }, child)], footer, className: 'filter-group' });
}

/** グループの下の説明文を書き換える（空なら CSS の :empty で場所ごと消える） */
function setFooter(group, text) {
  group.querySelector('.list-group__footer').textContent = text;
}

/**
 * 日付を選ぶ行（開始日・終了日）。行のどこを押しても端末標準の日付選択が開くよう、本物の <input type="date"> を
 * 透明にして行いっぱいに重ねる。見えている文字は「10/13(火)」または灰色の「指定なし」。
 * iPhone の日付選択には「空に戻す」操作がないことがあるので、値があるときは「クリア」も出す。
 */
function dateRow({ label, nowMs, onChange }) {
  const text = h('span', { class: 'date-row__value num' });
  const input = h('input', {
    class: 'date-row__input', type: 'date', 'aria-label': label,
    onChange: (e) => set(e.target.value || null, true),
    // PC のブラウザは文字の部分を押すと入力欄の中の編集になるので、押したら日付選択を開く（iPhone では不要だが害もない）
    onClick: (e) => { try { e.target.showPicker(); } catch (err) { /* 非対応・開けない環境では何もしない */ } },
  });
  const clear = h('button', { type: 'button', class: 'btn btn--text date-row__clear', 'aria-label': `${label}を空にする`, onClick: () => set(null, true) }, 'クリア');
  const row = h('div', { class: 'form-row date-row' }, h('span', { class: 'form-row__label' }, label), text, clear, input);

  /** 値を入れる（'YYYY-MM-DD' か null）。notify が true のときだけ呼び出し元に知らせる（「すべて解除」の巻き戻しでは知らせない） */
  function set(value, notify) {
    input.value = value ?? '';
    const shown = value ? formatYmdLabel(value, nowMs) : '';
    text.textContent = shown || '指定なし';
    text.classList.toggle('is-empty', !shown);
    clear.hidden = !shown;
    if (notify) onChange(value);
  }
  return { row, set };
}

/**
 * 絞り込みシートの中身を作る（openSheet の content）。
 * @returns {{ body: Node, headerRight: Node, footer: Node }}
 */
function buildSheet({ trades, filter, nowMs, favorites, finish }) {
  const draft = cloneFilter(filter); // シートの中で触る写し

  // 通貨ペアの選択肢：記録にあるペアだけ。ただし今の条件で選んでいるペアは、記録が消えていても出す（シートの中で外せるように）
  const pairs = pairOptions(trades, favorites);
  for (const p of draft.pairs) if (!pairs.includes(p)) pairs.push(p);

  /* ---------- キーワード ---------- */
  const keywordInput = h('input', {
    class: 'sheet-search__input', type: 'search', value: draft.keyword, maxlength: KEYWORD_MAX_LENGTH,
    placeholder: 'メモ・根拠・タグを検索', 'aria-label': 'キーワード',
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search',
    onInput: () => { syncKeyword(); scheduleRefresh(); },
    onKeydown: (e) => {
      // 日本語入力の変換を確定する Enter（isComposing／keyCode 229）では適用しない
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      if (!apply()) keywordInput.blur(); // 0件のときは適用できない。キーボードを閉じて、ボタンの「該当する記録がありません」を見せる
    },
  });
  const keywordClear = h('button', {
    type: 'button', class: 'sheet-search__clear', 'aria-label': '入力を消す',
    onClick: () => { keywordInput.value = ''; syncKeyword(); refresh(); keywordInput.focus(); },
  }, icon('close', { size: 'xs' }));
  const search = h('label', { class: 'sheet-search' }, icon('search', { size: 'sm', className: 'sheet-search__icon' }), keywordInput, keywordClear);

  /** 入力欄の文字を条件の写しに反映し、「すべて解除」の押せる・押せないと、× の出し入れを合わせる */
  function syncKeyword() {
    draft.keyword = keywordInput.value;
    keywordClear.hidden = keywordInput.value === '';
    resetBtn.disabled = countActiveConditions(draft) === 0;
  }

  /* ---------- 口座・状態・売買方向（セグメント） ---------- */
  const account = segment({
    name: 'filter-account', label: '口座', variant: 'account', value: draft.accountType,
    options: [ALL, { value: 'real', label: '本番' }, { value: 'demo', label: 'デモ' }],
    onChange: (v) => { draft.accountType = v; refresh(); },
  });
  const status = segment({
    name: 'filter-status', label: '状態', value: draft.status,
    options: [ALL, { value: 'open', label: '保有中' }, { value: 'closed', label: '決済済み' }],
    onChange: (v) => {
      draft.status = v;
      if (v === 'open') { // 保有中の記録には勝敗がない。選んでいた勝敗は外す
        draft.outcomes = [];
        outcomeChips.setSelected([]);
      }
      syncOutcomes();
      refresh();
    },
  });
  const side = segment({
    name: 'filter-side', label: '売買方向', value: draft.side, // 選択中も汎用の見た目（買い/売りの色の塗りは入力画面だけ：design 14.3.10）
    options: [ALL, { value: 'buy', label: '▲ 買い' }, { value: 'sell', label: '▼ 売り' }],
    onChange: (v) => { draft.side = v; refresh(); },
  });

  /* ---------- 期間 ---------- */
  const periodChips = chips({
    label: '期間', required: true, className: 'chips--grid-4', selected: [draft.period.preset],
    options: PERIOD_PRESETS.map((v) => ({ value: v, label: PERIOD_LABELS[v] })),
    onChange: ([v]) => {
      draft.period = { preset: v, from: null, to: null }; // 「指定」から他に切り替えたら、入れた日付は捨てる（design 14.3.10）
      syncPeriod();
      refresh();
    },
  });
  const fromRow = dateRow({ label: '開始日', nowMs, onChange: (v) => { draft.period.from = v; refresh(); } });
  const toRow = dateRow({ label: '終了日', nowMs, onChange: (v) => { draft.period.to = v; refresh(); } });
  const periodGroup = listGroup({
    header: '期間', className: 'filter-group',
    rows: [h('div', { class: 'filter-row' }, periodChips.el), fromRow.row, toRow.row],
    footer: '',
  });

  /** 期間の選択に合わせて、日付の行と下の説明を出し入れする */
  function syncPeriod() {
    const { preset, from, to } = draft.period;
    const custom = preset === 'custom';
    fromRow.row.hidden = !custom;
    toRow.row.hidden = !custom;
    fromRow.set(from, false);
    toRow.set(to, false);
    if (custom) setFooter(periodGroup, 'その日を含みます。片方だけでも絞り込めます。');
    else if (preset === 'all') setFooter(periodGroup, '');
    else setFooter(periodGroup, `${describePeriodRange(draft.period, nowMs)}。決済済みは決済日、保有中はエントリー日で判定します。`);
  }

  /* ---------- 勝敗 ---------- */
  const outcomeChips = chips({
    label: '勝敗', multiple: true, className: 'chips--grid-3', selected: draft.outcomes,
    options: OUTCOMES.map((o) => ({ value: o, label: OUTCOME_LABELS[o] })),
    onChange: (sel) => { draft.outcomes = OUTCOMES.filter((o) => sel.includes(o)); syncOutcomes(); refresh(); },
  });
  const outcomeGroup = section('勝敗', outcomeChips.el, '');

  /** 状態が「保有中」のときは勝敗のチップを押せなくする（薄く表示）。説明も状態に合わせて変える */
  function syncOutcomes() {
    const openOnly = draft.status === 'open';
    for (const btn of outcomeChips.el.querySelectorAll('button')) btn.disabled = openOnly;
    if (openOnly) setFooter(outcomeGroup, '保有中の記録には勝敗がありません');
    else if (draft.outcomes.length > 0) setFooter(outcomeGroup, '勝敗で絞り込むと、保有中の記録は表示されません。');
    else setFooter(outcomeGroup, '');
  }

  /* ---------- 通貨ペア（記録が1件もなければ項目ごと出さない） ---------- */
  const pairChips = pairs.length === 0 ? null : chips({
    label: '通貨ペア', multiple: true, className: 'chips--grid-3', selected: draft.pairs,
    options: pairs.map((p) => ({ value: p, label: p })),
    onChange: (sel) => { draft.pairs = pairs.filter((p) => sel.includes(p)); refresh(); }, // 選んだ順ではなく、並び順どおりに持つ
  });

  /* ---------- 上部「すべて解除」・下部「n件を表示」 ---------- */
  const resetBtn = textButton('すべて解除', {
    disabled: countActiveConditions(draft) === 0,
    onClick: () => {
      Object.assign(draft, defaultFilter());
      keywordInput.value = '';
      account.setValue('all');
      status.setValue('all');
      side.setValue('all');
      periodChips.setSelected(['all']);
      outcomeChips.setSelected([]);
      if (pairChips) pairChips.setSelected([]);
      syncKeyword();
      syncPeriod();
      syncOutcomes();
      refresh(); // シートは開いたまま、件数だけ更新する
    },
  });
  const applyBtn = button('', { variant: 'primary', block: true, onClick: () => apply() });
  const applyLabel = applyBtn.querySelector('.btn__label');
  applyLabel.setAttribute('aria-live', 'polite'); // 件数が変わったことを読み上げる

  /** 今の写しを、一覧に渡せる形にする（勝敗の矛盾を直し、「指定」で日付が空なら全期間に、キーワードの前後の空白を除く） */
  function currentFilter() {
    const f = fixConflicts(draft);
    f.keyword = f.keyword.trim();
    if (f.period.preset === 'custom' && !f.period.from && !f.period.to) f.period = { preset: 'all', from: null, to: null };
    return f;
  }

  /** 件数を数え直して、ボタンと「すべて解除」に反映する */
  function refresh() {
    clearTimeout(timer);
    const n = countMatches(trades, currentFilter(), nowMs);
    applyLabel.textContent = n === 0 ? '該当する記録がありません' : `${n}件を表示`;
    applyBtn.disabled = n === 0;
    resetBtn.disabled = countActiveConditions(draft) === 0;
  }

  let timer = null;
  function scheduleRefresh() {
    clearTimeout(timer);
    timer = setTimeout(refresh, KEYWORD_DEBOUNCE_MS);
  }

  /** 適用してシートを閉じる。0件の条件では何もしない（false を返す） */
  function apply() {
    syncKeyword(); // 入力欄の最新の文字を条件に入れる（待ち時間の途中で押されても取りこぼさない）
    const f = currentFilter();
    if (countMatches(trades, f, nowMs) === 0) return false;
    finish(f);
    return true;
  }

  /* ---------- 組み立て ---------- */
  syncKeyword();
  syncPeriod();
  syncOutcomes();
  refresh();

  const body = h('div', { class: 'filter-sheet' },
    search,
    section('口座', account.el),
    periodGroup,
    outcomeGroup,
    section('状態', status.el),
    section('売買方向', side.el),
    pairChips ? section('通貨ペア', pairChips.el, '記録のある通貨ペアだけを表示しています。') : null,
  );
  return { body, headerRight: resetBtn, footer: applyBtn };
}

/**
 * 絞り込みシートを開く。
 * @param {{ trades: object[], filter: object, nowMs: number, favorites: string[] }} opts
 *   trades … 一覧で読み込み済みの全記録（件数を数えるため。論理削除は filter.js が除く）
 *   filter … 今の条件（シートの最初の状態）
 *   nowMs … 今（ミリ秒）。「今月」などの範囲の説明と件数に使う
 *   favorites … 設定の「よく使う通貨ペア」（通貨ペアの並び順）
 * @returns {Promise<object|null>} 「n件を表示」で適用した新しい条件。キャンセル・背景タップ・Esc なら null
 */
export function openFilterSheet({ trades, filter, nowMs, favorites }) {
  return openSheet({
    title: '絞り込み',
    content: (finish) => buildSheet({ trades, filter, nowMs, favorites, finish }),
  });
}
