/* =========================================================
   js/screens/analysis.js
   S-08 分析。型A（タブ画面）。URL：#/analytics
   ※ 集計の計算を受け持つ js/analytics.js（Phase 3）とは役割が違う別ファイル。

   Phase 1〜2 は「準備中」の案内だけを出す（design.md 3.2 S-08・9.14、13章 判断事項①）。
   分析の中身は Phase 3（T-52 以降）で作る。
   ========================================================= */
import { h } from '../ui/dom.js';
import { largeTitle } from '../ui/bars.js';

export default {
  layout: 'tab',
  tab: 'analytics',
  title: '分析',

  mount(root) {
    root.append(
      largeTitle('分析'),
      h('div', { class: 'empty' },
        // 文言は design.md 3.2 S-08「Phase 1〜2 の表示」のとおり
        h('p', { class: 'empty__text' }, '分析は今後のアップデートで追加します。合計損益は一覧で確認できます。'),
        // タブを切り替えるのと同じ動きなので、履歴を増やさない移動（data-nav="replace"）にする
        h('a', { class: 'btn btn--secondary', href: '#/', dataset: { nav: 'replace' } }, '一覧を見る'),
      ),
    );
  },

  unmount() {},

  hasUnsavedChanges() {
    return false;
  },
};
