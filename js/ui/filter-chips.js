/* =========================================================
   js/ui/filter-chips.js
   一覧の絞り込みまわりの小さな部品（design.md 14.3.1・14.3.7）。T-23 で作成。
     ・大タイトル右の絞り込みボタン（線画のじょうご＋条件があるときだけ条件の数）
     ・適用中の条件チップ（タップで確認なしにその条件だけ解除。2つ以上あれば末尾に「すべて解除」）
   どちらも「見せて、押されたら知らせる」だけ。条件そのものの扱い（解除・保存）は js/screens/list.js と js/filter.js。
   文字はすべて ui/dom.js の h() を通す（キーワードのチップも textContent 相当：XSS 対策）。
   ========================================================= */
import { h } from './dom.js';
import { icon } from './icons.js';

/**
 * 絞り込みボタン。記録が1件もないときは押せない（薄く表示：design 14.3.9）。
 * @param {() => void} onClick シートを開く
 * @returns {{ el: HTMLButtonElement, update: (state: { count: number, disabled: boolean }) => void }}
 */
export function createFilterButton(onClick) {
  const countEl = h('span', { class: 'filter-button__count num' });
  const el = h('button', { type: 'button', class: 'filter-button', onClick }, icon('filter'), countEl);
  return {
    el,
    update({ count, disabled }) {
      countEl.textContent = count > 0 ? String(count) : '';
      countEl.hidden = count === 0;
      el.disabled = disabled;
      // 数字だけだと何の数か分からないので、読み上げでは文にする
      el.setAttribute('aria-label', count > 0 ? `絞り込み、${count}件の条件を適用中` : '絞り込み');
    },
  };
}

/**
 * 適用中の条件チップを並べ直す。チップは1つずつ <button>（読み上げ「本番の条件を解除」）。
 * @param {HTMLElement} container チップを入れる場所（空になると CSS で場所ごと消える）
 * @param {{ key: string, label: string, ariaLabel: string }[]} chips filter.js の describeFilter の結果
 * @param {{ onClear: (key: string) => void, onClearAll: () => void }} handlers
 */
export function renderFilterChips(container, chips, { onClear, onClearAll }) {
  const nodes = chips.map((c) => h('button', {
    type: 'button', class: 'filter-chip', 'aria-label': c.ariaLabel, onClick: () => onClear(c.key),
  }, h('span', { class: 'filter-chip__label' }, c.label), icon('close', { size: 'xs' })));
  if (chips.length >= 2) nodes.push(h('button', { type: 'button', class: 'btn btn--text', onClick: onClearAll }, 'すべて解除'));
  container.replaceChildren(...nodes); // null を渡すと「null」という文字が入ってしまうので、配列に入れる時点で作ったものだけにしている
}
