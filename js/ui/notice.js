/* =========================================================
   js/ui/notice.js
   お知らせ行（design.md 9.16・14.3.8・14.7.6、architecture.md 4.5・15.1）。

   グループ化されたリストの1行の形：左に線画アイコン、本文 15px（＋2行目 13px・灰）、右に文字ボタンと ×（44px）。
   色は付けない（エラーのアイコンだけ赤、「下書きを保存できません」の ⚠ は琥珀）。目立たせすぎない。

   置き場所は2つ（design 9.16 の「置き場所の決まり」）：
     ① 画面の中     … 各画面が createNotice() / renderNotices() で、S-01 は大タイトルの下、入力画面は口座色の線の下に置く
     ② 画面の一番上 … どの画面でも起こりうるアプリ全体の問題（予期しない問題・DB_OPEN・VERSION）は
                       showAppNotice() で index.html の #notice-area に出す（画面の中身を描けない状態でも必ず見える）
   部品（見た目・ボタン・×）はどちらも同じ createNotice() を使う。
   ========================================================= */
import { h } from './dom.js';
import { icon } from './icons.js';

/**
 * お知らせ行を1つ作る。
 * @param {{ iconName?: string, tone?: 'normal'|'error'|'warning', text: string, subtext?: string,
 *   action?: { label: string, onClick: Function }, onClose?: Function, closeLabel?: string }} opts
 *   tone    … error＝アイコンを赤（読み込みエラーなど）、warning＝アイコンを琥珀（下書きを保存できない）
 *   onClose … 渡したときだけ × を出す（消えてはいけないお知らせには渡さない：design 14.3.8）
 * @returns {HTMLDivElement}
 */
export function createNotice({ iconName = '', tone = 'normal', text, subtext = '', action = null, onClose = null, closeLabel = 'このお知らせを閉じる' }) {
  // エラーは読み上げ機能にすぐ伝える（alert）。それ以外は控えめに（status）
  const role = tone === 'error' ? 'alert' : 'status';
  return h('div', { class: `notice notice--${tone}`, role },
    iconName ? icon(iconName, { className: 'notice__icon' }) : null,
    h('div', { class: 'notice__body' },
      h('p', { class: 'notice__text' }, text),
      subtext ? h('p', { class: 'notice__sub num' }, subtext) : null),
    action ? h('button', { type: 'button', class: 'btn btn--text notice__action', onClick: action.onClick }, action.label) : null,
    onClose ? h('button', { type: 'button', class: 'btn btn--icon notice__close', 'aria-label': closeLabel, onClick: onClose }, icon('close', { size: 'sm' })) : null,
  );
}

/**
 * 画面の中に、お知らせを優先順に最大 max 行まで並べる（design 9.16「同時に出すのは最大2行」・14.3.8）。
 * items は優先順（上ほど優先）に並べて渡す。上のものが解決したら、次に呼んだときに次のものが出る。
 * @param {HTMLElement} container 置き場（中身を入れ替える）
 * @param {object[]} items createNotice() の引数の並び
 * @param {{ max?: number }} [opts]
 */
export function renderNotices(container, items, { max = 2 } = {}) {
  container.classList.add('notice-list');
  container.replaceChildren(...items.slice(0, max).map((it) => createNotice(it)));
}

/* ---------------------------------------------------------
   アプリ全体のお知らせ（#notice-area）
   --------------------------------------------------------- */

/** #notice-area（なければ作る：確認用ページなど index.html 以外でも使えるように） */
function appArea() {
  let el = document.getElementById('notice-area');
  if (!el) {
    el = h('div', { id: 'notice-area' });
    document.body.prepend(el);
  }
  el.classList.add('notice-list');
  return el;
}

/**
 * 画面の一番上（#notice-area）にアプリ全体のお知らせを出す。同じ key のお知らせは1つだけ（重ねて出さない）。
 * 消えないお知らせ（DB_OPEN など）は onClose を渡さない。
 * @param {string} key お知らせの種類（例 'unexpected'・'db-open'）
 * @param {object} opts createNotice() の引数
 */
export function showAppNotice(key, opts) {
  const area = appArea();
  if (area.querySelector(`[data-notice="${CSS.escape(key)}"]`)) return;
  const el = createNotice(opts);
  el.dataset.notice = key;
  area.append(el);
}

/** #notice-area のお知らせを消す */
export function hideAppNotice(key) {
  const area = document.getElementById('notice-area');
  const el = area && area.querySelector(`[data-notice="${CSS.escape(key)}"]`);
  if (el) el.remove();
}
