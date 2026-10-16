/* =========================================================
   js/screens/install-guide.js
   S-06 の下位画面「ホーム画面への追加方法」。型C。URL：#/settings/install

   【T-10 の段階】ナビゲーションバー（‹ 設定）の入れ物だけ。
   説明文（Safari とホーム画面版でデータが別であること、アイコン削除でデータが消えることなど：
   architecture.md 17章 #2・20.2）は、T-07 のワイヤーフレームを受けて T-29 で作る。
   ========================================================= */
import { h } from '../ui/dom.js';
import { navbar, backButton } from '../ui/bars.js';

export default {
  layout: 'detail',
  tab: null,
  title: 'ホーム画面への追加方法',

  mount(root, { nav }) {
    root.append(
      navbar({
        left: backButton('設定', () => nav.back('#/settings')),
        title: 'ホーム画面への追加方法',
      }),
      h('div', { class: 'screen__body' },
        h('section', { class: 'list-group' },
          h('div', { class: 'list-group__body' },
            h('p', { class: 'list-row placeholder-note' }, '追加方法の説明は T-29 で作ります。'),
          ),
        ),
      ),
    );
  },

  unmount() {},

  hasUnsavedChanges() {
    return false;
  },
};
