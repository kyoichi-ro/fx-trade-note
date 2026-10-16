/* =========================================================
   js/screens/edit.js
   S-05 編集。型B（入力画面）。URL：#/trades/{id}/edit

   【T-10 の段階】ナビゲーションバー（キャンセル／保存）と下部の保存ボタンの入れ物だけ。
   入力欄（S-02/S-03 と共通の trade-form.js）・再計算・保存は T-22 で作る。
   ========================================================= */
import { h } from '../ui/dom.js';
import { navbar, textButton, actionBar } from '../ui/bars.js';

export default {
  layout: 'form',
  tab: null,
  title: '編集',

  mount(root, { params, nav }) {
    // 履歴がないときの戻り先はその記録の詳細（architecture.md 5.1）
    const detailHash = `#/trades/${encodeURIComponent(params.id)}`;

    root.append(
      navbar({
        left: textButton('キャンセル', { onClick: () => nav.back(detailHash) }),
        title: '編集',
        right: textButton('保存', { disabled: true, strong: true }),
      }),
      h('div', { class: 'screen__body' },
        h('section', { class: 'list-group' },
          h('div', { class: 'list-group__body' },
            h('p', { class: 'list-row placeholder-note' }, '編集の入力欄は T-22 で作ります。'),
            // URL から取り出した ID は h() でテキストとして表示する（XSS 対策）
            h('div', { class: 'list-row' },
              h('span', { class: 'list-row__label' }, '記録ID'),
              h('span', { class: 'list-row__value placeholder-value' }, params.id),
            ),
          ),
        ),
      ),
      actionBar(h('button', { type: 'button', class: 'btn btn--primary', disabled: true }, '変更を保存')),
    );
  },

  unmount() {
    // T-22 で下書きの即時保存をここに足す
  },

  hasUnsavedChanges() {
    return false;
  },
};
