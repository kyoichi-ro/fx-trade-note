/* =========================================================
   js/screens/detail.js
   S-04 トレード詳細。型C（詳細画面）。URL：#/trades/{id}

   【T-10 の段階】ナビゲーションバー（‹ 一覧／編集）と下部の「決済する」の入れ物だけ。
   記録の表示・画像の拡大・決済の取り消し・削除は T-20・T-22・T-24 で作る。
   記録が見つからないときの「この記録は見つかりません」表示（architecture.md 5.1）も、
   記録を読み込めるようになる T-20 で作る。
   ========================================================= */
import { h } from '../ui/dom.js';
import { navbar, backButton, actionBar } from '../ui/bars.js';

export default {
  layout: 'detail',
  tab: null,
  title: '詳細',

  mount(root, { params, nav }) {
    // URL に戻すときは encodeURIComponent で符号化する（ID に / や # などが混ざっていても URL が壊れないように）
    const base = `#/trades/${encodeURIComponent(params.id)}`;

    root.append(
      navbar({
        left: backButton('一覧', () => nav.back('#/')),
        title: '詳細',
        // 編集・決済は「進む」移動なので普通のリンクにする（履歴が1つ増える）
        right: h('a', { class: 'btn btn--text', href: `${base}/edit` }, '編集'),
      }),
      h('div', { class: 'screen__body' },
        h('section', { class: 'list-group' },
          h('div', { class: 'list-group__body' },
            h('p', { class: 'list-row placeholder-note' }, '記録の内容は T-20 で表示します。'),
            // URL から取り出した ID は誰でも書き換えられる文字なので、h() でテキストとして表示する（XSS 対策）
            h('div', { class: 'list-row' },
              h('span', { class: 'list-row__label' }, '記録ID'),
              h('span', { class: 'list-row__value placeholder-value' }, params.id),
            ),
          ),
        ),
      ),
      // 「決済する」は保有中の記録だけに出す（T-20 で状態を見て出し分ける）
      actionBar(h('a', { class: 'btn btn--primary', href: `${base}/close` }, '決済する')),
    );
  },

  unmount() {
    // T-24 で画像の表示用URLの解放（architecture.md 11.3）をここに足す
  },

  hasUnsavedChanges() {
    return false;
  },
};
