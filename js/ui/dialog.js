/* =========================================================
   js/ui/dialog.js
   確認（アクションシート：design.md 9.7・14.7.4）と、失敗の知らせ（アラート：design 9.15 ③・14.7.3）。

   ・どちらも HTML 標準の <dialog> と showModal() で作る（背後の画面の操作を自動で止めてくれる：design 9.7）。
   ・読み上げ：role="alertdialog"、開いたらタイトルと説明を読み上げる（aria-labelledby / aria-describedby）。
   ・閉じたら、開く前にフォーカスがあった場所へ戻す（キーボード・VoiceOver の利用者が迷子にならないように）。
   ・開いている間は背後の画面をスクロールさせない（design 8.4）。

   【なぜ ::backdrop（標準の背景）を使わないのか】
   古い iOS Safari では ::backdrop の中で CSS 変数（--color-scrim）が使えないことがあるため、
   <dialog> 自体を画面いっぱいの半透明の黒にし、中に白いまとまりを置く形にしている。
   この形だと「背景（まとまりの外）を押した」も「<dialog> 自体を押した」で判定できる。

   使い方：
     const ok = await confirmAction({ title: 'この記録を削除しますか？', message: '本番 USD/JPY ▲買い 10/15 21:30 の記録', confirmLabel: '削除' });
     const v = await showAlert({ title: '保存できませんでした', message: '…', buttons: [{ label: '閉じる', value: 'close' }, { label: 'もう一度保存', value: 'retry', primary: true }] });
   ========================================================= */
import { h, uniqueId } from './dom.js';

/** 今開いているもの（同時に1つだけ） */
let openEntry = null;

/** 背後の画面のスクロールを止める／戻す */
function lockScroll(on) {
  document.documentElement.classList.toggle('is-modal-open', on);
}

/**
 * <dialog> を開いて、閉じられたときの値を Promise で返す共通部分。
 * @param {HTMLDialogElement} dlg
 * @param {HTMLElement} initialFocus 最初にフォーカスを置くボタン
 * @param {*} cancelValue Esc・背景タップなどで閉じたときの値
 * @param {boolean} closeOnBackdrop 背景のタップで閉じるか（アラートは閉じない：design 14.7.3）
 */
function open(dlg, initialFocus, cancelValue, closeOnBackdrop) {
  // 前のものが開いていたら「何もしない」で閉じる（二重に重ならないように）
  if (openEntry) openEntry.finish(openEntry.cancelValue);

  const returnFocus = document.activeElement;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      lockScroll(false);
      openEntry = null;
      // 開く前の場所へフォーカスを戻す（その要素が画面から消えていたら何もしない）
      if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
      resolve(value);
    };
    openEntry = { finish, cancelValue };

    dlg._finish = finish;
    // Esc キー（Android の戻る操作も cancel になる）
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (closeOnBackdrop) finish(cancelValue); // アクションシートは「何もしない」で閉じる。アラートはボタンでだけ閉じる
    });
    // 何かの理由で閉じられた場合も、必ず Promise を終わらせる
    dlg.addEventListener('close', () => finish(cancelValue));
    if (closeOnBackdrop) {
      // 半透明の背景（<dialog> 自体）を押したとき。中のまとまりを押したときは target が中の要素になる
      dlg.addEventListener('click', (e) => { if (e.target === dlg) finish(cancelValue); });
    }

    document.body.append(dlg);
    lockScroll(true);
    dlg.showModal();
    initialFocus.focus();
  });
}

/**
 * アクションシート（選択肢が下から出る確認）。design 9.7・14.7.4。
 * 操作の文言は具体的な動詞にする（「削除」「決済を取り消す」「入力内容を破棄」。「OK」「はい」は使わない）。
 * 初期フォーカスは「キャンセル」側（うっかり Enter で危険な操作をしないように）。
 * @param {{ title: string, message?: string, actions: {label:string, value:*, danger?:boolean}[], cancelLabel?: string }} opts
 * @returns {Promise<*>} 選んだ action の value。キャンセル・背景タップ・Esc なら null
 */
export function actionSheet({ title, message = '', actions, cancelLabel = 'キャンセル' }) {
  const titleId = uniqueId('dlg');
  const msgId = message ? uniqueId('dlg') : null;
  const dlg = h('dialog', {
    class: 'dialog dialog--sheet', role: 'alertdialog', 'aria-modal': 'true',
    'aria-labelledby': titleId, 'aria-describedby': msgId,
  });
  const cancelBtn = h('button', { type: 'button', class: 'action-sheet__button action-sheet__button--cancel', onClick: () => dlg._finish(null) }, cancelLabel);
  dlg.append(h('div', { class: 'action-sheet' },
    h('div', { class: 'action-sheet__group' },
      h('div', { class: 'action-sheet__header' },
        h('p', { class: 'action-sheet__title', id: titleId }, title),
        message ? h('p', { class: 'action-sheet__message', id: msgId }, message) : null),
      actions.map((a) => h('button', {
        type: 'button',
        class: `action-sheet__button${a.danger ? ' action-sheet__button--danger' : ''}`,
        onClick: () => dlg._finish(a.value),
      }, a.label))),
    // 「キャンセル」は独立したまとまり（iOS と同じ：design 9.7）
    h('div', { class: 'action-sheet__group' }, cancelBtn),
  ));
  return open(dlg, cancelBtn, null, true);
}

/**
 * 危険な操作の確認（アクションシートの短縮形）。
 * @param {{ title: string, message?: string, confirmLabel: string, cancelLabel?: string, danger?: boolean }} opts
 * @returns {Promise<boolean>} 実行するなら true
 */
export async function confirmAction({ title, message = '', confirmLabel, cancelLabel = 'キャンセル', danger = true }) {
  const v = await actionSheet({ title, message, cancelLabel, actions: [{ label: confirmLabel, value: true, danger }] });
  return v === true;
}

/**
 * アラート（画面中央の小さな確認窓）。保存の失敗など「自動で消えてはいけない」知らせに使う（design 9.15 ③・14.7.3）。
 * 背景を押しても閉じない（見落としを防ぐため）。初期フォーカスは右（勧める方）のボタン。
 * @param {{ title: string, message?: string, buttons?: {label:string, value:*, primary?:boolean}[] }} opts
 *   buttons は左から順。勧める方（「もう一度保存」）に primary: true（太字）。省略時は［閉じる］だけ
 * @returns {Promise<*>} 押したボタンの value
 */
export function showAlert({ title, message = '', buttons = [{ label: '閉じる', value: 'close' }] }) {
  const titleId = uniqueId('dlg');
  const msgId = message ? uniqueId('dlg') : null;
  const dlg = h('dialog', {
    class: 'dialog dialog--alert', role: 'alertdialog', 'aria-modal': 'true',
    'aria-labelledby': titleId, 'aria-describedby': msgId,
  });
  const btnEls = buttons.map((b) => h('button', {
    type: 'button',
    class: `alert__button${b.primary ? ' alert__button--primary' : ''}`,
    onClick: () => dlg._finish(b.value),
  }, b.label));
  dlg.append(h('div', { class: 'alert' },
    h('div', { class: 'alert__body' },
      h('p', { class: 'alert__title', id: titleId }, title),
      message ? h('p', { class: 'alert__message', id: msgId }, message) : null),
    h('div', { class: 'alert__buttons' }, btnEls),
  ));
  // 何かの理由で閉じられた（ボタン以外）ときは、いちばん左（閉じる側）を押したことにする
  return open(dlg, btnEls[btnEls.length - 1], buttons[0].value, false);
}

/**
 * ボトムシート（ui/sheet.js）も、アクションシート・アラートと同じ「同時に1つだけ・閉じたらフォーカスを戻す・背後を止める」
 * 仕組みで開くため、共通部分 open() を部品の中だけで使える名前で出す（T-17 で追加）。画面からは直接使わない。
 */
export { open as openModal };
