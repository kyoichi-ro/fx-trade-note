/* =========================================================
   js/screens/choices.js
   S-06 の下位画面「選択肢の編集」。型C。URL：#/settings/choices/{kind}（design.md 14.6.3・14.6.4）
   kind は pairs（よく使う通貨ペア）／entryReasons（エントリー根拠）／emotions（感情）／tags（タグ）。
   それ以外の kind は router.js が「一覧にない URL」として一覧へ戻すので、ここには来ない。

   【T-16 で作った範囲】
   ・4種類とも「常に編集できる状態」で開く（iOS の「編集」ボタンを押す手間を省く：design 14.6.3）。
   ・追加：末尾の「＋ 追加」→ 入力欄の行（キーボードを出す）。「完了」か欄から離れると追加。空のまま離れたら行を閉じる。
           名前のチェックは choice-list.js（空白だけ・20文字以内・同じ名前は不可）。通貨ペアは「通貨ペアを追加」のボトムシート。
   ・削除：行の左の ⊖ → 右に赤い「削除」ボタン → もう一度押して確定（確認ダイアログは出さない）。他の場所を押すと引っ込む。
           通貨ペアは最後の1つだけ削除できない（⊖ を無効表示）。
   ・並べ替え：右の ≡ を押したまま上下に動かす（ui/sortable.js）。キーボードは ≡ にフォーカスして ↑↓。
   ・名前の変更はできない（変えると過去の記録の文字と食い違い、分析で別の項目として数えられるため：design 14.6.3）。
   ・変えた時点で localStorage に保存する（settings-store.js の窓口。トーストなし：画面の変化で分かるため：design 14.6.2）。
     保存できなかったら「設定を保存できませんでした」のアラートを出し、画面は保存済みの値のまま（保存されていない値を見せない）。

   【削除しても過去の記録は変わらない】記録は選択肢の名前を文字のまま持っているので、設定から消しても一覧・詳細の表示は変わらない。
   決済画面は、選択肢にない選択済みの値をチップに足して見せる（close.js の withSelected）。

   文字はすべて ui/dom.js の h() を通す（利用者が入れた名前も必ずテキストとして入る：architecture 14.1）。
   ========================================================= */
import { h } from '../ui/dom.js';
import { navbar, backButton } from '../ui/bars.js';
import { listGroup } from '../ui/parts.js';
import { messageLine, setGroupMessages } from '../ui/fields.js';
import { icon } from '../ui/icons.js';
import { openSheet } from '../ui/sheet.js';
import { alertSettingsWriteFailed } from '../ui/dialog.js';
import { attachDragSort } from '../ui/sortable.js';
import { getSetting, setSetting } from '../settings-store.js';
import { CHOICE_KIND_LABELS, getPairSpec } from '../master.js';
import { CHOICE_NAME_MAX_LENGTH, FAVORITE_GRID_COUNT } from '../config.js';
import {
  addChoice, removeChoice, moveItem, addFavoritePair, removeFavoritePair, searchPairCandidates, CHOICE_NAME_ERROR_TEXTS,
} from '../choice-list.js';
import { FLASH_DURATION_MS } from '../row-flash.js';
import { isAppError } from '../util.js';

/* ---------------------------------------------------------
   文言（design 14.6.3・14.6.4。通貨ペアのエラーは fx-rules 10.4 のメッセージ例に、E-12 は design の例に合わせた）
   --------------------------------------------------------- */

// 名前のチェックの文言は choice-list.js の CHOICE_NAME_ERROR_TEXTS（入力画面のタグ追加と共通）
const NAME_ERRORS = CHOICE_NAME_ERROR_TEXTS;

const PAIR_MESSAGES = {
  'E-12': '通貨ペアは「USD/JPY」の形で入力してください',
  'E-13': 'このアプリはFXの通貨ペアのみ記録できます',
  'E-14': '2つの異なる通貨を入力してください',
  'E-15': '円が左側の通貨ペアは対象外です（例：USD/JPY の形で入力してください）',
  'E-16': 'この通貨ペアはすでに登録されています',
  'W-07': 'このアプリで確認していない通貨です。pips の値が業者の表示と異なる場合があります。損益（円）は手入力で上書きできます。',
};

/** グループの下の説明文（並べ替えと削除の説明は共通。種類ごとの補足は design 14.6.3 の表） */
const NOTES = {
  sort: '≡ を押したまま上下に動かすと並べ替えられます。削除しても、記録済みのトレードの内容は変わりません。',
  pairs: `≡ を押したまま上下に動かすと並べ替えられます。上の${FAVORITE_GRID_COUNT}つが新規エントリーの画面に、いつも同じ位置で並びます。`,
  pairsLast: '1つ以上必要です。',
  emotions: 'エントリー時と決済時の感情で共通の選択肢です。',
  tags: '新規エントリー・決済の画面からも追加できます。',
};

/** 今表示しているこの画面の操作の係（unmount から後片付けする） */
let ctrl = null;

/* ---------------------------------------------------------
   設定の読み書き（種類によって保存場所が違う：通貨ペア＝favoritePairs、ほか＝choices の中の1つ）
   --------------------------------------------------------- */

function readItems(kind) {
  return kind === 'pairs' ? getSetting('favoritePairs') : getSetting('choices')[kind];
}

/**
 * 保存する。成功したら true。保存できなかったら（容量不足など）アラートを出して false。
 * 保存する直前に他の種類の最新値を読み直して書くので、別の種類を巻き込んで古い値に戻すことはない。
 */
function writeItems(kind, list) {
  if (kind === 'pairs') setSetting('favoritePairs', list);
  else setSetting('choices', { ...getSetting('choices'), [kind]: list });
}

/* ---------------------------------------------------------
   通貨ペアを追加するボトムシート（design 14.6.4）
   --------------------------------------------------------- */

/**
 * 「通貨ペアを追加」シート：上に検索欄、下にマスタの一覧（登録済みは除く）。
 * 検索欄の文字がマスタにないペアの形なら、一覧の先頭に「SGD/JPY を追加」の行。
 * チェック E-12〜E-16 は検索欄の下に赤字、W-07 は琥珀の注意と「確認して追加」の行（判定は choice-list.js）。
 * @param {string[]} favorites 今の「よく使う通貨ペア」
 * @returns {Promise<string|null>} 追加するペア。キャンセルなら null
 */
function choosePairToAdd(favorites) {
  return openSheet({
    title: '通貨ペアを追加',
    content: (finish) => {
      const messages = h('div', { class: 'sheet-messages', 'aria-live': 'polite' });
      const listBody = h('div', { class: 'list-group__body' });

      const renderList = (query) => {
        const { hits, custom, error } = searchPairCandidates(favorites, query);
        const warned = custom && custom.warn.includes('W-07');
        messages.replaceChildren(
          ...(error ? [messageLine('error', PAIR_MESSAGES[error])] : []),
          ...(warned ? [messageLine('warning', PAIR_MESSAGES['W-07'])] : []),
        );
        const rows = [];
        if (custom) {
          rows.push(h('button', { type: 'button', class: 'list-row pair-option pair-option--custom', onClick: () => finish(custom.pair) },
            icon('plus', { size: 'xs' }),
            h('span', { class: 'list-row__label num' }, warned ? `確認して ${custom.pair} を追加` : `${custom.pair} を追加`)));
        }
        for (const p of hits) {
          rows.push(h('button', { type: 'button', class: 'list-row pair-option', onClick: () => finish(p.pair) },
            h('span', { class: 'list-row__label num' }, p.pair),
            h('span', { class: 'list-row__value' }, p.nameJa)));
        }
        if (rows.length === 0 && !error) {
          rows.push(h('p', { class: 'list-row pair-option__empty' },
            query.trim() ? '該当する通貨ペアがありません' : '追加できる通貨ペアはありません'));
        }
        listBody.replaceChildren(...rows);
      };

      const search = h('input', {
        class: 'sheet-search__input', type: 'search', placeholder: 'EUR/AUD など', 'aria-label': '通貨ペアを検索または入力',
        autocomplete: 'off', autocorrect: 'off', autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'search',
        onInput: (e) => renderList(e.target.value),
      });
      renderList('');
      return h('div', {},
        h('label', { class: 'sheet-search' }, icon('search', { size: 'sm', className: 'sheet-search__icon' }), search),
        messages,
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
 * @param {string} kind 'pairs' | 'entryReasons' | 'emotions' | 'tags'
 */
function buildScreen(root, nav, kind) {
  const isPairs = kind === 'pairs';
  const label = CHOICE_KIND_LABELS[kind];

  let items = readItems(kind);   // 保存済みの値（画面に出しているものと必ず同じ）
  let armed = null;              // 右に「削除」ボタンを出している行の名前
  let adding = false;            // 追加の入力欄を開いているか
  let flash = null;              // 描き直したあと約1秒目立たせる行の名前（追加した行）
  let alerting = false;          // 保存失敗のアラートを出している間（欄から離れる動きが重ねて保存し直さないように）
  let addSlot = null;            // 「＋ 追加」／入力欄を入れる場所（行を描き直さずに入れ替えるため、独立させている）
  let addGroup = null;           // 入力欄のあるグループ（エラー文を出す場所）

  const body = h('div', { class: 'screen__body choice-edit' });
  root.append(
    navbar({ left: backButton('設定', () => nav.back('#/settings')), title: label }),
    body,
  );

  /* ----- 保存 ----- */

  /** 保存して items を更新する。失敗したら false（画面は変えない） */
  function persist(next) {
    try {
      writeItems(kind, next);
    } catch (e) {
      if (!isAppError(e, 'SETTINGS_WRITE')) throw e;
      console.error('選択肢を保存できませんでした', e);
      alerting = true;
      alertSettingsWriteFailed().finally(() => { alerting = false; });
      return false;
    }
    items = readItems(kind);
    return true;
  }

  /* ----- 行 ----- */

  /** 1行：左に ⊖（削除）、名前、右に ≡（並べ替え）。⊖ を押すと「削除」ボタンが ≡ の代わりに出る */
  function itemRow(name) {
    const isArmed = armed === name;
    const onlyOne = isPairs && items.length <= 1; // 最後の通貨ペアは削除できない（design 14.6.3）
    const sub = isPairs ? getPairSpec(name).nameJa : '';
    return h('div', { class: `choice-row${isArmed ? ' is-armed' : ''}`, dataset: { name } },
      h('button', {
        type: 'button', class: 'choice-row__remove', 'aria-label': `${name}を削除`,
        'aria-expanded': isArmed ? 'true' : 'false', 'aria-disabled': onlyOne ? 'true' : null,
        onClick: () => toggleArm(name),
      }, icon('minusCircle')),
      h('span', { class: 'choice-row__text' },
        h('span', { class: `choice-row__name${isPairs ? ' num' : ''}` }, name),
        sub && sub !== name ? h('span', { class: 'choice-row__sub' }, sub) : null),
      h('button', {
        type: 'button', class: 'choice-row__grip', 'aria-label': `${name}を並べ替え（上下の矢印キーで移動）`,
      }, icon('grip')),
      h('button', { type: 'button', class: 'choice-row__delete', 'aria-label': `${name}を削除する`, onClick: () => onDelete(name) }, '削除'),
    );
  }

  /** ⊖：「削除」ボタンを出す／引っ込める（同時に出すのは1行だけ） */
  function toggleArm(name) {
    if (isPairs && items.length <= 1) return;
    armed = armed === name ? null : name;
    for (const row of body.querySelectorAll('.choice-row')) {
      const on = row.dataset.name === armed;
      row.classList.toggle('is-armed', on);
      row.querySelector('.choice-row__remove').setAttribute('aria-expanded', on ? 'true' : 'false');
    }
  }

  /** 「削除」：その選択肢を消して保存（確認ダイアログは出さない。⊖ → 削除の2回が確認の代わり：design 14.6.3） */
  function onDelete(name) {
    const r = isPairs ? removeFavoritePair(items, name) : { ok: true, list: removeChoice(items, name) };
    if (!r.ok) return;
    // 保存できなかったときは「削除」ボタンを出したまま画面を変えない（armed を先に空にすると、見た目と状態が食い違う）
    if (!persist(r.list)) return;
    armed = null;
    render();
    // キーボード操作の人が迷子にならないよう、フォーカスを「追加」へ
    const add = body.querySelector('.choice-add');
    if (add) add.focus({ preventScroll: true });
  }

  /** 並べ替えが決まった（ドラッグで離した／矢印キー）。保存して描き直す */
  function onMove(from, to, { viaKeyboard }) {
    if (!persist(moveItem(items, from, to))) return;
    armed = null;
    render();
    if (viaKeyboard) {
      // 矢印キーで続けて動かせるよう、動かした行のつまみにフォーカスを戻す
      const grips = body.querySelectorAll('.choice-row__grip');
      if (grips[to]) grips[to].focus({ preventScroll: true });
    }
  }

  /* ----- 追加 ----- */

  /** 「＋ 追加」の行（通貨ペアは「＋ 通貨ペアを追加」） */
  function addButton() {
    return h('button', { type: 'button', class: 'list-row choice-add', onClick: () => (isPairs ? addPair() : startAdd()) },
      icon('plus', { size: 'sm' }),
      h('span', {}, isPairs ? '通貨ペアを追加' : '追加'));
  }

  /** 名前の入力欄の行。「完了」（Enter）で追加、欄から離れたときも追加（空なら行を閉じるだけ） */
  function addInputRow() {
    const input = h('input', {
      class: 'form-row__input choice-add__input', type: 'text', 'aria-label': `${label}の名前`,
      placeholder: `名前（${CHOICE_NAME_MAX_LENGTH}文字以内）`, enterkeyhint: 'done',
      autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false',
      // 文字を直し始めたら、前のエラーは消す（直したら消える：design 9.15）
      onInput: () => { if (addGroup) setGroupMessages(addGroup, []); },
      onKeydown: (e) => {
        // 日本語入力の変換を確定する Enter では追加しない（変換中は isComposing）
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); } // 「完了」＝欄から離れる（blur で追加する）
        if (e.key === 'Escape') { input.value = ''; input.blur(); }
      },
      onBlur: () => commitAdd(input),
    });
    return h('label', { class: 'form-row choice-add-row' }, icon('plus', { size: 'sm', className: 'choice-add-row__icon' }), input);
  }

  function renderAddSlot() {
    addSlot.replaceChildren(adding ? addInputRow() : addButton());
  }

  function startAdd() {
    armed = null;
    adding = true;
    render();
    const input = addSlot.querySelector('input');
    if (input) input.focus();
  }

  /** 入力欄から離れた：空なら行を閉じる／名前をチェックして追加する */
  function commitAdd(input) {
    if (!adding || alerting) return;
    const text = input.value;
    if (text.trim() === '') {
      adding = false;
      if (addGroup) setGroupMessages(addGroup, []);
      renderAddSlot(); // 行は描き直さず、入力欄だけ「＋ 追加」に戻す（同時に押した ⊖ などを消さないため）
      return;
    }
    const r = addChoice(items, text);
    if (!r.ok) {
      setGroupMessages(addGroup, [{ type: 'error', text: NAME_ERRORS[r.error], target: input }]);
      return;
    }
    if (!persist(r.list)) return;
    adding = false;
    flash = r.name;
    render();
  }

  /** 通貨ペアの追加：シートで選ぶ／入力する → 末尾に追加して保存 → 追加した行を約1秒強調 */
  async function addPair() {
    armed = null;
    const chosen = await choosePairToAdd(items);
    if (!chosen) return;
    const r = addFavoritePair(items, chosen);
    if (!r.ok) return; // シートで確かめ済み。ここに来るのは、シートを開いている間に登録が変わったときだけ
    if (!persist(r.list)) return;
    flash = r.pair;
    render();
  }

  /* ----- 描き直し ----- */

  function noteNodes(...texts) {
    return texts.filter(Boolean).map((t) => h('p', {}, t));
  }

  function render() {
    addSlot = h('div', { class: 'choice-add-slot' });
    renderAddSlot();
    if (isPairs) {
      const first = items.slice(0, FAVORITE_GRID_COUNT);
      const rest = items.slice(FAVORITE_GRID_COUNT);
      addGroup = listGroup({ rows: [addSlot], footer: noteNodes(NOTES.pairs, items.length <= 1 ? NOTES.pairsLast : '') });
      body.replaceChildren(
        listGroup({ header: `新規エントリーの画面に表示（上から${FAVORITE_GRID_COUNT}つ）`, rows: first.map(itemRow) }),
        ...(rest.length ? [listGroup({ header: '「その他の通貨ペア」の先頭に表示', rows: rest.map(itemRow) })] : []),
        addGroup,
      );
    } else {
      addGroup = listGroup({
        rows: [...items.map(itemRow), addSlot],
        footer: noteNodes(NOTES.sort, kind === 'emotions' ? NOTES.emotions : '', kind === 'tags' ? NOTES.tags : ''),
      });
      body.replaceChildren(addGroup);
    }
    if (flash) highlight(flash);
    flash = null;
  }

  /** 追加した行を約1秒目立たせ、画面の外なら見える位置までスクロールする（design 14.6.4。一覧の1秒ハイライトと同じ時間） */
  function highlight(name) {
    const row = [...body.querySelectorAll('.choice-row')].find((r) => r.dataset.name === name);
    if (!row) return;
    row.classList.add('is-flash');
    row.scrollIntoView({ block: 'nearest' });
    setTimeout(() => row.classList.remove('is-flash'), FLASH_DURATION_MS);
  }

  /* ----- 画面全体の操作 ----- */

  // 他の場所をタップしたら「削除」ボタンを引っ込める（その行の ⊖ と「削除」ボタンを押したときは除く：design 14.6.3）
  const onOutsidePointerDown = (e) => {
    if (armed === null) return;
    const row = e.target.closest('.choice-row');
    const onOwnButtons = row && row.dataset.name === armed && e.target.closest('.choice-row__remove, .choice-row__delete');
    if (onOwnButtons) return;
    armed = null;
    for (const r of body.querySelectorAll('.choice-row.is-armed')) {
      r.classList.remove('is-armed');
      r.querySelector('.choice-row__remove').setAttribute('aria-expanded', 'false');
    }
  };
  document.addEventListener('pointerdown', onOutsidePointerDown, true);
  const detachSort = attachDragSort(body, { rowSelector: '.choice-row', handleSelector: '.choice-row__grip', onMove });

  render();

  return {
    destroy() {
      document.removeEventListener('pointerdown', onOutsidePointerDown, true);
      detachSort();
    },
  };
}

export default {
  layout: 'detail',
  tab: null,
  title: (params) => CHOICE_KIND_LABELS[params.kind] || '選択肢',

  mount(root, { params, nav }) {
    ctrl = buildScreen(root, nav, params.kind);
  },

  unmount() {
    if (ctrl) ctrl.destroy();
    ctrl = null;
  },

  // 変えた時点で保存するので「保存していない変更」はない（design 14.6.2）
  hasUnsavedChanges() {
    return false;
  },
};
