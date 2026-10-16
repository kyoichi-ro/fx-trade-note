/* =========================================================
   js/screens/choices.js
   S-06 の下位画面「選択肢の編集」。型C。URL：#/settings/choices/{kind}
   kind は pairs（よく使う通貨ペア）／entryReasons（エントリー根拠）／emotions（感情）／tags（タグ）。
   それ以外の kind は router.js が「一覧にない URL」として一覧へ戻すので、ここには来ない。

   【T-10 の段階】ナビゲーションバー（‹ 設定）と画面名の切り替えだけ。
   追加・削除・並び替えは T-16 で作る。
   ========================================================= */
import { h } from '../ui/dom.js';
import { navbar, backButton } from '../ui/bars.js';

/** kind ごとの画面名（設定画面の行の名前と同じにする）。T-16 で master.js の表示名に置き換える予定 */
const KIND_LABELS = {
  pairs: 'よく使う通貨ペア',
  entryReasons: 'エントリー根拠',
  emotions: '感情',
  tags: 'タグ',
};

function labelOf(kind) {
  return KIND_LABELS[kind] || '選択肢';
}

export default {
  layout: 'detail',
  tab: null,
  title: (params) => labelOf(params.kind),

  mount(root, { params, nav }) {
    root.append(
      navbar({
        left: backButton('設定', () => nav.back('#/settings')),
        title: labelOf(params.kind),
      }),
      h('div', { class: 'screen__body' },
        h('section', { class: 'list-group' },
          h('div', { class: 'list-group__body' },
            h('p', { class: 'list-row placeholder-note' }, '選択肢の追加・削除・並び替えは T-16 で作ります。'),
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
