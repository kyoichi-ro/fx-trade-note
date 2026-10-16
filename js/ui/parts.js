/* =========================================================
   js/ui/parts.js
   表示用の小さな共通部品（design.md 9章）：
     ・ボタン（主要・副・危険・文字・アイコン）と「保存中」の表示  … 9.1
     ・バッジ（デモ/本番・買い/売り・保有中/決済済み・手入力・未同期） … 9.5
     ・グループ化されたリスト・行・危険な操作の行              … 9.13・9.1
     ・空状態                                                  … 9.14
     ・読み込み中（回転アイコン）                              … 9.15
   見た目は css/components.css。文字はすべて ui/dom.js の h() を通す（必ずテキストとして入る：XSS 対策）。

   ※ architecture.md 4.1 のファイル一覧にはないファイル（T-11 で追加）。入力部品は fields.js、
     トースト・確認・お知らせは toast.js / dialog.js / notice.js と役割で分け、ここには「表示の部品」を集めた。
   ========================================================= */
import { h, uniqueId } from './dom.js';
import { icon } from './icons.js';

/* ---------------------------------------------------------
   ボタン（design 9.1）
   --------------------------------------------------------- */

/**
 * ボタンを作る。href を渡すと見た目がボタンのリンク（<a>）になる（画面の移動は「リンク」にする約束：router.js）。
 * @param {string} label ボタンの文字（「保存」「編集」など。感嘆符は付けない：design 10.1 #8）
 * @param {{ variant?: 'primary'|'secondary'|'text'|'danger', block?: boolean, strong?: boolean,
 *   iconName?: string, href?: string, onClick?: Function, disabled?: boolean, type?: string }} [opts]
 *   primary  … 1画面に1つだけ（保存・決済を保存）
 *   secondary… 編集・条件を解除・一覧を見る
 *   text     … ナビゲーションバーの「キャンセル」「保存」、「今にする」など
 *   danger   … 「この記録を削除」。グループ化されたリストの1行の形（dangerRow() を使う）
 *   block    … 幅いっぱい（下部操作バーなど）
 * @returns {HTMLButtonElement|HTMLAnchorElement}
 */
export function button(label, {
  variant = 'secondary', block = false, strong = false, iconName = '', href = '', onClick, disabled = false, type = 'button',
} = {}) {
  const cls = ['btn', `btn--${variant}`];
  if (block) cls.push('btn--block');
  if (strong) cls.push('btn--strong');
  const content = [iconName ? icon(iconName, { size: 'sm' }) : null, h('span', { class: 'btn__label' }, label)];
  if (href) return h('a', { class: cls.join(' '), href }, content);
  return h('button', { type, class: cls.join(' '), disabled, onClick }, content);
}

/**
 * アイコンだけのボタン（絞り込み・閉じるなど）。見た目は 22〜24px、押せる範囲は 44×44px（design 8.1・9.1）。
 * 文字がないので、読み上げ用の名前（label）を必ず付ける。
 */
export function iconButton(iconName, label, { onClick, disabled = false, className = '' } = {}) {
  return h('button', {
    type: 'button', class: `btn btn--icon${className ? ` ${className}` : ''}`, 'aria-label': label, disabled, onClick,
  }, icon(iconName));
}

/**
 * ボタンを「処理中」にする／戻す（design 9.1・9.15）。
 * 文字を「保存中」に変え、左に小さな回転アイコンを出し、押せなくする（連打で2件保存されるのを防ぐ）。
 * 元の文字は覚えておき、戻すときに元どおりにする。
 * @param {HTMLButtonElement} btn button() で作ったボタン
 * @param {boolean} busy
 * @param {string} [busyLabel] 処理中の文字（例「保存中」「作成中」）
 */
export function setBusy(btn, busy, busyLabel = '保存中') {
  if (busy) {
    if (btn.classList.contains('is-busy')) return;
    btn._idleChildren = [...btn.childNodes];
    btn._idleDisabled = btn.disabled;
    btn.replaceChildren(spinnerIcon(), h('span', { class: 'btn__label' }, busyLabel));
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
  } else {
    if (!btn.classList.contains('is-busy')) return;
    btn.replaceChildren(...(btn._idleChildren || []));
    btn.disabled = Boolean(btn._idleDisabled);
    btn.classList.remove('is-busy');
    btn.removeAttribute('aria-busy');
  }
}

/* ---------------------------------------------------------
   バッジ（design 9.5）。押せない小さなラベル。色だけでなく文字・記号でも区別する（design 5.1）
   --------------------------------------------------------- */

/** バッジの種類と文字（▲▼ は色以外の区別のための記号：design 5.1） */
const BADGES = {
  demo: 'デモ',
  real: '本番',
  buy: '▲買い',
  sell: '▼売り',
  open: '保有中',
  closed: '決済済み',
  manual: '手入力',
  unsynced: '未同期',
};

/**
 * バッジを作る。
 * @param {'demo'|'real'|'buy'|'sell'|'open'|'closed'|'manual'|'unsynced'} kind
 */
export function badge(kind) {
  const text = BADGES[kind];
  if (!text) throw new Error(`badge(): 未対応の種類 ${kind}`);
  return h('span', { class: `badge badge--${kind}` }, text);
}

/* ---------------------------------------------------------
   グループ化されたリスト（design 9.13）
   --------------------------------------------------------- */

/**
 * グループ（見出し → 角丸の白いまとまり → 下の説明文）。
 * 見出しがあるときは、まとまりに見出しの名前を付ける（読み上げで「どのグループか」が分かるように）。
 * @param {{ header?: string, footer?: (string|Node), rows?: Node[], className?: string }} opts
 * @returns {HTMLElement} <section class="list-group">。中の body / footer は .list-group__body / __footer
 */
export function listGroup({ header = '', footer = null, rows = [], className = '' } = {}) {
  const headerId = header ? uniqueId('grp') : null;
  return h('section', { class: `list-group${className ? ` ${className}` : ''}`, 'aria-labelledby': headerId },
    header ? h('h2', { class: 'list-group__header', id: headerId }, header) : null,
    h('div', { class: 'list-group__body' }, rows),
    // 下の説明文・エラー文・警告文の置き場（fields.js の setGroupMessages がここに文を入れる）
    h('div', { class: 'list-group__footer' }, footer),
  );
}

/**
 * 表示用の行（ラベル左・値右）。href を渡すと次の画面へ進む行（右端に灰色の ›）。
 * @param {{ label: string, value?: (string|Node), href?: string, numeric?: boolean }} opts
 *   numeric：値が数字（等幅数字で桁をそろえる：design 6.1）
 */
export function listRow({ label, value = null, href = '', numeric = false }) {
  const parts = [
    h('span', { class: 'list-row__label' }, label),
    value !== null ? h('span', { class: `list-row__value${numeric ? ' num' : ''}` }, value) : null,
  ];
  if (href) {
    return h('a', { class: 'list-row list-row--link', href }, parts, h('span', { class: 'list-row__chevron' }, icon('chevronRight', { size: 'sm' })));
  }
  return h('div', { class: 'list-row' }, parts);
}

/**
 * 危険な操作の行（「この記録を削除」「決済を取り消す」）。design 9.1 の .btn--danger。
 * 押したらアクションシートで確認する（dialog.js の confirmAction）。詳細画面の最下部の独立したグループに置く（design 8.2）。
 */
export function dangerRow(label, onClick) {
  return h('button', { type: 'button', class: 'btn btn--danger', onClick }, label);
}

/* ---------------------------------------------------------
   空状態（design 9.14・14.7.2）
   --------------------------------------------------------- */

/**
 * 空状態：小さな線画アイコン＋短い見出し＋説明1行＋ボタン1つ（任意）。装飾のイラスト・絵文字は使わない。
 * @param {{ iconName?: string, title: string, text?: string, action?: Node }} opts
 */
export function emptyState({ iconName = 'notebook', title, text = '', action = null }) {
  return h('div', { class: 'empty' },
    icon(iconName, { size: 'lg', className: 'empty__icon' }),
    h('p', { class: 'empty__title' }, title),
    text ? h('p', { class: 'empty__text' }, text) : null,
    action,
  );
}

/* ---------------------------------------------------------
   読み込み中（design 9.15・14.7.7）
   --------------------------------------------------------- */

/** 回転アイコンだけ（ボタンの中などで使う） */
function spinnerIcon() {
  return icon('spinner', { size: 'sm', className: 'spinner__icon' });
}

/**
 * 回転アイコン＋「読み込み中」の文字。
 * 文字は普段は読み上げ専用で、「視差効果を減らす」設定の人には回転を止めて文字を見せる（design 9.15。CSS で切替）。
 * @param {string} [label]
 */
export function spinner(label = '読み込み中') {
  return h('span', { class: 'spinner', role: 'status' }, spinnerIcon(), h('span', { class: 'spinner__label' }, label));
}

/**
 * 「0.3秒以上かかるときだけ」読み込み中を出す（design 9.15。すぐ終わるときにちらつかせない）。
 * 使い方：const loading = showLoadingAfter(container); await 読み込み; loading.stop();
 * @param {HTMLElement} container 回転アイコンを入れる場所
 * @param {{ delay?: number, label?: string }} [opts]
 * @returns {{ stop: () => void }}
 */
export function showLoadingAfter(container, { delay = 300, label = '読み込み中' } = {}) {
  let el = null;
  const timer = setTimeout(() => {
    el = h('div', { class: 'loading' }, spinner(label));
    container.append(el);
  }, delay);
  return {
    stop() {
      clearTimeout(timer);
      if (el) el.remove();
    },
  };
}
