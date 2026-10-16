/* =========================================================
   js/ui/sortable.js
   並べ替えのつまみ（≡）をドラッグして行を並べ替える部品（design.md 14.6.3・14.6.4）。T-16 で作成。

   ・つまみを押したまま上下に動かす。動かしている行は「浮かせたコピー」（ゴースト）が指に付いてきて、元の行の場所は空けておく。
     ほかの行は、動かしている行が越えたぶんだけ上下にずれる（行き先が見える）。離した位置で onMove を呼ぶ。
     ドラッグ中の行の背景は --color-fill、影は付けない（design 14.6.3）。
   ・キーボード・外付けキーボード：つまみにフォーカスして ↑↓ キー（design 14.6.3）。
   ・なぜ「コピーを浮かせる」のか：行を入れ物（角丸・はみ出し隠し）ごと動かすと、グループの外へ出た部分が切れて見えなくなる。
     よく使う通貨ペアは2つのグループをまたいで動かせるので、画面に固定したコピーを使う。
   ・なぜ pointer イベントか：マウスと指（iPhone）を同じ書き方で扱えるため。つまみには CSS の touch-action: none を付けてあり、
     つまみを触っている間だけ画面のスクロールを止める（css/screens.css）。画面の端に近づいたら自動でスクロールする。
   ・並べ替えの結果の保存・描き直しは呼び出し側（onMove）の仕事。この部品は「何番目を何番目へ」を伝えるだけ。
   ・行の動かし方の計算は choice-list.js の dropIndex（純粋な関数。テストあり）。
   ========================================================= */
import { dropIndex } from '../choice-list.js';

/** 画面の端からこの距離（px）以内にくると自動スクロールを始める（上側はナビゲーションバーの下から数える） */
const EDGE = 56;
/** 自動スクロールの最大の速さ（1コマあたりの px） */
const MAX_SPEED = 14;

/**
 * 並べ替えを使えるようにする。
 * @param {HTMLElement} container 行を含む入れ物（画面を描き直しても残る要素。イベントはここで受ける）
 * @param {{
 *   rowSelector: string,     行を見つけるセレクタ。入れ物の中の順番（上から）がそのまま並び順の番号になる
 *   handleSelector: string,  つまみのセレクタ（行の中）
 *   onMove: (from: number, to: number, info: { viaKeyboard: boolean }) => void  並べ替えが決まったとき
 * }} opts
 * @returns {() => void} 後片付け（画面を離れるときに呼ぶ）
 */
export function attachDragSort(container, { rowSelector, handleSelector, onMove }) {
  /** ドラッグ中の状態（なければ null） */
  let drag = null;

  const rowsOf = () => [...container.querySelectorAll(rowSelector)];

  /* ----- ゴースト（浮かせたコピー）と、ほかの行のずれ ----- */

  /** 動かしている行を今の位置に合わせ、ほかの行をずらす */
  function update(clientY) {
    drag.lastClientY = clientY;
    drag.ghost.style.top = `${drag.startTop + (clientY - drag.startClientY)}px`;
    // 行の位置は「ページ全体」での位置で比べる（自動スクロールで画面が動いても同じ基準で比べられるように）
    const pageDelta = (clientY + window.scrollY) - (drag.startClientY + drag.startScrollY);
    const to = dropIndex(drag.centers, drag.from, drag.centers[drag.from] + pageDelta);
    if (to === drag.to) return;
    drag.to = to;
    const shift = drag.heights[drag.from];
    drag.rows.forEach((row, i) => {
      if (i === drag.from) return;
      let dy = 0;
      if (to < drag.from && i >= to && i < drag.from) dy = shift;   // 上へ動かす：間の行は1つ分下へ
      if (to > drag.from && i > drag.from && i <= to) dy = -shift;  // 下へ動かす：間の行は1つ分上へ
      row.style.transform = dy ? `translateY(${dy}px)` : '';
    });
  }

  /** 画面の端に近いとき、近さに応じてスクロールする（コマごとに呼ぶ） */
  function autoScroll() {
    if (!drag) return;
    const bar = document.querySelector('.navbar');
    const top = (bar ? bar.getBoundingClientRect().bottom : 0) + EDGE;
    const bottom = window.innerHeight - EDGE;
    let speed = 0;
    if (drag.lastClientY < top) speed = -Math.min(1, (top - drag.lastClientY) / EDGE) * MAX_SPEED;
    else if (drag.lastClientY > bottom) speed = Math.min(1, (drag.lastClientY - bottom) / EDGE) * MAX_SPEED;
    if (speed) {
      window.scrollBy(0, speed);
      update(drag.lastClientY); // 画面が動いたぶん、行き先を取り直す
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  /** ドラッグを終える。commit が true で行き先が変わっていれば onMove を呼ぶ */
  function finish(commit) {
    if (!drag) return;
    const d = drag;
    drag = null;
    cancelAnimationFrame(d.raf);
    d.ghost.remove();
    d.row.classList.remove('is-drag-origin');
    d.rows.forEach((row) => { row.style.transform = ''; });
    container.classList.remove('is-sorting');
    try { d.handle.releasePointerCapture(d.pointerId); } catch (e) { /* すでに外れている */ }
    if (commit && d.to !== d.from) onMove(d.from, d.to, { viaKeyboard: false });
  }

  /* ----- イベント ----- */

  function onPointerDown(e) {
    if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const handle = e.target.closest(handleSelector);
    if (!handle || !container.contains(handle)) return;
    const rows = rowsOf();
    const row = handle.closest(rowSelector);
    const from = rows.indexOf(row);
    if (from < 0) return;

    const rects = rows.map((r) => r.getBoundingClientRect());
    const scrollY = window.scrollY;
    const ghost = row.cloneNode(true);
    ghost.classList.add('is-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    // 位置と大きさは CSSOM（el.style.xxx）で指定する（style 属性を直接書くのは CSP で禁止：architecture 14.3）
    ghost.style.top = `${rects[from].top}px`;
    ghost.style.left = `${rects[from].left}px`;
    ghost.style.width = `${rects[from].width}px`;
    ghost.style.height = `${rects[from].height}px`;
    document.body.append(ghost);

    drag = {
      pointerId: e.pointerId, handle, row, rows, from, to: from, ghost, raf: 0,
      startClientY: e.clientY, startScrollY: scrollY, lastClientY: e.clientY, startTop: rects[from].top,
      centers: rects.map((r) => r.top + scrollY + r.height / 2),
      heights: rects.map((r) => r.height),
    };
    row.classList.add('is-drag-origin');
    container.classList.add('is-sorting');
    handle.setPointerCapture(e.pointerId); // つまみから指が外れても、離すまで動きを受け取る
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function onPointerMove(e) {
    if (drag && e.pointerId === drag.pointerId) update(e.clientY);
  }

  function onPointerUp(e) {
    if (drag && e.pointerId === drag.pointerId) finish(true);
  }

  function onPointerCancel(e) {
    if (drag && e.pointerId === drag.pointerId) finish(false);
  }

  /** つまみにフォーカスして ↑↓：1つ上／下へ動かす（design 14.6.3 のキーボード操作） */
  function onKeyDown(e) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const handle = e.target.closest(handleSelector);
    if (!handle || !container.contains(handle)) return;
    e.preventDefault(); // 矢印キーで画面がスクロールしないように
    const rows = rowsOf();
    const from = rows.indexOf(handle.closest(rowSelector));
    const to = from + (e.key === 'ArrowUp' ? -1 : 1);
    if (from < 0 || to < 0 || to >= rows.length) return;
    onMove(from, to, { viaKeyboard: true });
  }

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('pointercancel', onPointerCancel);
  container.addEventListener('keydown', onKeyDown);

  return () => {
    finish(false);
    container.removeEventListener('pointerdown', onPointerDown);
    container.removeEventListener('pointermove', onPointerMove);
    container.removeEventListener('pointerup', onPointerUp);
    container.removeEventListener('pointercancel', onPointerCancel);
    container.removeEventListener('keydown', onKeyDown);
  };
}
