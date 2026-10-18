/* =========================================================
   js/ui/sheet.js
   ボトムシート（design.md 9.8）：画面の下からせり上がる、選択肢のまとまり。

   【T-17 で作成（architecture 4.2 では T-23 の予定だった）】
   エントリー画面の「その他の通貨ペア」（design 14.1.6）で必要になったため、「選ぶだけで閉じるシート」の形
   （上部は「キャンセル」だけ）を先に作った。
   【T-23 で拡張】絞り込みシート（design 14.3.10）のために、上部の右（「すべて解除」）と下部に固定する主要ボタン（「12件を表示」）を
   足せるようにした。content が { body, headerRight, footer } を返すと使える（Node だけを返す従来の形もそのまま使える）。
   本文だけがスクロールし、題名・「キャンセル」・下部のボタンは常に見える。
   【T-33】content が { initialFocus } も返せるようにした（最初にフォーカスを置く要素。「その他の通貨ペア」は検索欄：T-32 の U-09）。

   ・開く・閉じる・フォーカスを戻す・背後のスクロールを止める仕組みは、アクションシートと同じ dialog.js の openModal を使う
     （同時に開くのは1つだけ、という約束をアプリ全体で守るため）。
   ・背景（半透明の部分）を押す・Esc キーでも「キャンセル」と同じく何もせずに閉じる。
   ・中身は呼び出し側が作る。選んだら finish(値) を呼ぶと閉じて、openSheet の Promise がその値で終わる。
   ・文字はすべて ui/dom.js の h() を通す（必ずテキストとして入る：XSS 対策）。見た目は css/components.css の .sheet。
   ========================================================= */
import { h, uniqueId } from './dom.js';
import { openModal } from './dialog.js';

/**
 * ボトムシートを開く。
 * @param {{ title: string, cancelLabel?: string,
 *   content: (finish: (value: any) => void) => (Node | { body: Node, headerRight?: Node|null, footer?: Node|null, initialFocus?: HTMLElement|null }) }} opts
 *   content … シートの中身を作る関数。引数の finish(値) を呼ぶとシートを閉じる。
 *     返すもの：本文の Node、または { body: 本文, headerRight: 上部の右に置く部品（「すべて解除」など）, footer: 下部に固定する部品（主要ボタン）,
 *       initialFocus: 最初にフォーカスを置く要素（省略すると「キャンセル」） }
 * @returns {Promise<any>} finish に渡した値。キャンセル・背景タップ・Esc なら null
 */
export function openSheet({ title, cancelLabel = 'キャンセル', content }) {
  const titleId = uniqueId('sheet');
  const dlg = h('dialog', { class: 'dialog dialog--bottom', 'aria-modal': 'true', 'aria-labelledby': titleId });
  const finish = (value) => dlg._finish(value);
  const cancelBtn = h('button', { type: 'button', class: 'btn btn--text', onClick: () => finish(null) }, cancelLabel);
  const built = content(finish);
  const { body, headerRight = null, footer = null, initialFocus = null } = built instanceof Node ? { body: built } : built;
  dlg.append(h('div', { class: 'sheet' },
    // 上端の「つまみ」は見た目だけ（iOS と同じ形。ドラッグで閉じる操作は作らない：キャンセル・背景タップで閉じられる）
    h('div', { class: 'sheet__grip', 'aria-hidden': 'true' }),
    h('div', { class: 'sheet__header' },
      h('div', { class: 'sheet__header-side' }, cancelBtn),
      h('h2', { class: 'sheet__title', id: titleId }, title),
      h('div', { class: 'sheet__header-side' }, headerRight)),
    h('div', { class: 'sheet__body' }, body),
    // 下部に固定する主要ボタン。キーボードが出ている間は隠す（キーボードに隠れて押せないため。css の .keyboard-open）
    footer ? h('div', { class: 'sheet__footer' }, footer) : null,
  ));
  // 最初のフォーカスは、指定がなければ「キャンセル」（検索欄にすると iPhone ではすぐキーボードが出て一覧が隠れるため）。
  // 「その他の通貨ペア」は、開いた目的がほぼ検索なので検索欄（T-33 U-09：タップが1つ減る）
  return openModal(dlg, initialFocus || cancelBtn, null, true);
}
