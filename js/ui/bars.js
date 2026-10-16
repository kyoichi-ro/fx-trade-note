/* =========================================================
   js/ui/bars.js
   画面の骨組みになる部品：大タイトル（型A）、ナビゲーションバー（型B・型C）、
   下部操作バー（型B・型C）、ナビゲーションバー用の文字ボタン（design.md 2.2・9.11）。

   どの画面でも同じ形にするために1か所にまとめた。見た目は css/layout.css。
   ※ architecture.md 4.1 のファイル一覧にはないファイル（T-10 で追加）。
   T-11：「‹」と新規エントリーボタンの「＋」を線画アイコン（ui/icons.js）に置き換え、newEntryButton() を追加。
   文字は ui/dom.js の h() を通すので、必ずテキストとして入る（XSS 対策）。
   ========================================================= */
import { h } from './dom.js';
import { icon } from './icons.js';

/**
 * 型A（タブ画面）の大タイトル。
 * @param {string} title 画面名（例「一覧」）
 * @param {Node} [right] 右側に置く部品（一覧の「絞り込み」ボタンなど）
 */
export function largeTitle(title, right = null) {
  return h('header', { class: 'large-title' },
    h('h1', { class: 'large-title__text' }, title),
    right,
  );
}

/**
 * 型B・型C のナビゲーションバー。左＝キャンセル／‹ 戻る、中央＝画面名、右＝保存／編集。
 * @param {{ left?: Node, title: string, right?: Node }} parts
 */
export function navbar({ left = null, title, right = null }) {
  return h('header', { class: 'navbar' },
    h('div', { class: 'navbar__left' }, left),
    h('h1', { class: 'navbar__title' }, title),
    h('div', { class: 'navbar__right' }, right),
  );
}

/**
 * 「‹ 戻る先の画面名」ボタン（型C）。
 * ホーム画面版の iPhone にはブラウザの戻るボタンがないため、全画面に必ず置く（design.md 2.2）。
 * @param {string} label 戻る先の画面名（例「一覧」「設定」）
 * @param {() => void} onClick
 */
export function backButton(label, onClick) {
  return h('button', { type: 'button', class: 'btn btn--text', onClick },
    // 「‹」は線画アイコン（design 9.17）。飾りなので読み上げない（読み上げは「一覧」などの画面名だけで足りる）
    icon('chevronLeft', { className: 'btn__chevron' }),
    label,
  );
}

/**
 * ナビゲーションバー用の文字ボタン（「キャンセル」「保存」など）。
 * @param {string} label
 * @param {{ onClick?: () => void, disabled?: boolean, strong?: boolean }} [opts]
 *   strong：太字にする（ナビゲーションバーの「保存」だけ：design.md 9.1）
 */
export function textButton(label, { onClick, disabled = false, strong = false } = {}) {
  return h('button', {
    type: 'button',
    class: strong ? 'btn btn--text btn--strong' : 'btn btn--text',
    disabled,
    onClick,
  }, label);
}

/**
 * 下部操作バー（幅いっぱいの主要ボタン1つを画面下に固定）。
 * @param {Node} child 中に置くボタンまたはリンク
 */
export function actionBar(child) {
  return h('div', { class: 'action-bar' }, child);
}

/**
 * ＋新規エントリーボタン（S-01 のみ。右下・タブバーの上に浮かぶカプセル型：design 9.10）。
 * 一覧から入力画面へは「進む」移動なので、普通のリンク（履歴が1つ増える）にする。
 * 「＋」は線画アイコン（20px・線2px）。ボタン内の文字で意味が伝わるので、アイコンは読み上げない（aria-label も不要）。
 */
export function newEntryButton(href = '#/new') {
  return h('a', { class: 'fab', href }, icon('plus', { size: 'sm', className: 'fab__icon' }), '新規エントリー');
}
