/* =========================================================
   js/screens/close.js
   S-03 決済記録。型B（入力画面）。URL：#/trades/{id}/close

   【T-10 の段階】ナビゲーションバー（キャンセル／保存）と下部の保存ボタンの入れ物だけ。
   対象トレードの要約・決済価格の入力・損益の自動計算・保存は T-21 で作る。
   ========================================================= */
import { h } from '../ui/dom.js';
import { navbar, textButton, actionBar } from '../ui/bars.js';

export default {
  layout: 'form',
  tab: null,
  title: '決済',

  mount(root, { params, nav }) {
    root.append(
      navbar({
        // 戻り先は呼び出し元（一覧 or 詳細）。履歴がないときは一覧へ（architecture.md 5.1）
        left: textButton('キャンセル', { onClick: () => nav.back('#/') }),
        title: '決済',
        right: textButton('保存', { disabled: true, strong: true }),
      }),
      h('div', { class: 'screen__body' },
        h('section', { class: 'list-group' },
          h('div', { class: 'list-group__body' },
            h('p', { class: 'list-row placeholder-note' }, '決済の入力欄は T-21 で作ります。'),
            // URL から取り出した ID は誰でも書き換えられる文字なので、h() でテキストとして表示する（XSS 対策）
            h('div', { class: 'list-row' },
              h('span', { class: 'list-row__label' }, '記録ID'),
              h('span', { class: 'list-row__value placeholder-value' }, params.id),
            ),
          ),
        ),
      ),
      actionBar(h('button', { type: 'button', class: 'btn btn--primary', disabled: true }, '決済を保存')),
    );
  },

  unmount() {
    // T-21 で下書きの即時保存をここに足す
  },

  hasUnsavedChanges() {
    return false;
  },
};
