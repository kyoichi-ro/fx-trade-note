/* =========================================================
   js/ui/pair-chooser.js
   「その他の通貨ペア」のボトムシート（design 14.1.6）。エントリー画面（S-02）と編集画面（S-05）で共通。

   【なぜ共通の部品にしたか】
   T-17 では entry.js の中にあったが、編集画面（T-22）でも同じシートを同じ動きで出すため、2か所に同じ処理を書いて
   片方だけ直して食い違わないよう、ここに移した（中身は変えていない）。
   ========================================================= */
import { h } from './dom.js';
import { icon } from './icons.js';
import { openSheet } from './sheet.js';
import { PAIR_MASTER, getPairSpec } from '../master.js';

/**
 * 「その他の通貨ペア」のボトムシート：上に検索欄、下に全ペア（よく使うペアが先頭）。タップで選んで閉じる。
 * @param {string[]} favorites 設定の「よく使う通貨ペア」（全部）
 * @param {string} selected 今選んでいるペア
 * @returns {Promise<string|null>} 選んだペア。キャンセルなら null
 */
export function choosePair(favorites, selected) {
  // よく使うペア（設定で追加したペアを含む）→ マスタの残り、の順。同じペアは1回だけ
  const all = [...new Set([...favorites, ...PAIR_MASTER.map((p) => p.pair)])];
  // 検索は大文字小文字・全角半角・区切りの「/」を無視する（「eurAUD」「ユーロ」でも見つかるように）
  const norm = (s) => String(s).normalize('NFKC').toUpperCase().replace(/[\s/\-_]/g, '');

  return openSheet({
    title: '通貨ペア',
    content: (finish) => {
      const listBody = h('div', { class: 'list-group__body' });
      const renderList = (query) => {
        const q = norm(query);
        const hits = all.filter((p) => !q || norm(p).includes(q) || norm(getPairSpec(p).nameJa).includes(q));
        listBody.replaceChildren(...(hits.length ? hits.map((p) => h('button', {
          type: 'button', class: 'list-row pair-option', 'aria-pressed': p === selected ? 'true' : 'false', onClick: () => finish(p),
        },
        h('span', { class: 'list-row__label num' }, p),
        h('span', { class: 'list-row__value' }, getPairSpec(p).nameJa),
        p === selected ? icon('check', { size: 'sm', className: 'pair-option__check' }) : null)) : [
          h('p', { class: 'list-row pair-option__empty' }, '該当する通貨ペアがありません'),
        ]));
      };
      const search = h('input', {
        class: 'sheet-search__input', type: 'search', placeholder: 'EUR/AUD など', 'aria-label': '通貨ペアを検索',
        autocomplete: 'off', autocorrect: 'off', autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'search',
        onInput: (e) => renderList(e.target.value),
      });
      renderList('');
      return h('div', {},
        h('label', { class: 'sheet-search' }, icon('search', { size: 'sm', className: 'sheet-search__icon' }), search),
        h('section', { class: 'list-group' }, listBody));
    },
  });
}
