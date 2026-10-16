/* =========================================================
   js/ui/dom.js
   画面の要素を「安全に」作る道具（architecture.md 4.2・14.1）。

   なぜこの道具を使うのか（XSS 対策）：
   ・メモやタグなど利用者が入力した文字を innerHTML で画面に入れると、
     文字の中に仕込まれた HTML やプログラムが動いてしまう（XSS）。
   ・h() は文字を必ず「テキストノード」（ただの文字）として入れるので、
     <script> などと書かれていても文字のまま表示され、動くことはない。
   ・画面を作るときは innerHTML / insertAdjacentHTML / outerHTML を使わず、必ずこの h() を使う。

   【T-10】h() と clear()。【T-11】uniqueId()・addIdRef()・removeIdRef()（読み上げ用の id のつなぎ）を追加。
   SVG アイコンは ui/icons.js が createElementNS で作る（h() は HTML の要素だけを作る）。
   ========================================================= */

/** 属性に入れてはいけない URL（javascript: で始まるものはクリックでプログラムが動くため） */
const DANGEROUS_URL = /^\s*javascript:/i;

/**
 * 要素を作る。
 * 例：h('a', { class: 'list-row', href: '#/settings' }, '設定', h('span', {}, '›'))
 *
 * @param {string} tag  タグ名（'div' など）
 * @param {object} [attrs] 属性。
 *   - class        … クラス名（文字列）
 *   - dataset      … data-* 属性のオブジェクト（例 { tab: 'list' } → data-tab="list"）
 *   - onClick など … 「on」で始まり値が関数のものは addEventListener で登録する
 *   - true         … 値なしの属性（disabled など）を付ける／false・null・undefined は付けない
 * @param {...(Node|string|number|null|false|Array)} children 子要素。文字は必ずテキストノードとして入れる
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);

  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === false || value === null || value === undefined) continue;

    if (name === 'class') {
      el.className = value;
    } else if (name === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (name.startsWith('on')) {
      // イベントは関数だけ受け付ける。onclick="..." のような文字列は XSS の入口になるため使わない
      if (typeof value !== 'function') {
        throw new TypeError(`h(): ${name} には関数を渡してください`);
      }
      el.addEventListener(name.slice(2).toLowerCase(), value);
    } else if (name === 'style') {
      // style="…" 属性は CSP（style-src 'self'）で無効になるため使わない（architecture.md 14.3）
      throw new TypeError('h(): style 属性は使えません。クラスの付け外しか el.style.xxx を使ってください');
    } else {
      if ((name === 'href' || name === 'src') && DANGEROUS_URL.test(String(value))) {
        throw new TypeError(`h(): ${name} に javascript: の URL は入れられません`);
      }
      el.setAttribute(name, value === true ? '' : String(value));
    }
  }

  appendChildren(el, children);
  return el;
}

/** 子要素を追加する。配列は平らにし、null / false / undefined は飛ばす。文字はテキストノードにする */
function appendChildren(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(el, child);
    } else if (child instanceof Node) {
      el.append(child);
    } else {
      // ここが XSS 対策の要：どんな文字でも「ただの文字」として入れる
      el.append(document.createTextNode(String(child)));
    }
  }
}

/** 要素の中身を空にする（innerHTML = '' の代わり） */
export function clear(el) {
  el.replaceChildren();
}

/* ---------- T-11 で追加 ---------- */

let idSeq = 0;

/**
 * ページの中で重ならない id を作る（例 'fx-err-3'）。
 * 入力欄とエラー文を aria-describedby で結びつける・見出しを aria-labelledby で指す、など
 * 読み上げ機能のための「つなぎ」に使う（design.md 8.5）。同じ部品を何個作っても id がぶつからない。
 * @param {string} [prefix]
 */
export function uniqueId(prefix = 'fx') {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

/**
 * aria-describedby などの「空白区切りの id の並び」に id を足す／外す。
 * 他の説明（例：単位の説明）が先に付いていても消さないように、文字の置き換えではなく足し引きで扱う。
 */
export function addIdRef(el, attr, id) {
  const ids = new Set((el.getAttribute(attr) || '').split(/\s+/).filter(Boolean));
  ids.add(id);
  el.setAttribute(attr, [...ids].join(' '));
}

export function removeIdRef(el, attr, id) {
  const ids = (el.getAttribute(attr) || '').split(/\s+/).filter((x) => x && x !== id);
  if (ids.length) el.setAttribute(attr, ids.join(' '));
  else el.removeAttribute(attr);
}
