/* =========================================================
   js/ui/image-viewer.js
   画像の拡大表示（design.md 14.4.6）。S-04 のサムネイル、S-02/S-03/S-05 の入力中のサムネイルのどれから開いても同じ表示。

   ・背景は常に黒（写真を見る画面の標準。ライトでも黒）。上に「閉じる」と「1 / 2」、下に添付したタイミングと「削除」。
   ・左右スワイプで前後の画像へ（CSS の scroll-snap：指に合わせて動き、最初と最後で止まる）。キーボードの ← → も使える。
   ・「削除」は S-04 から開いたときだけ（onDelete を渡したときだけ出す）。確認のアクションシート → 物理削除 → トースト「画像を削除しました」→
     次の画像を表示。最後の1枚なら拡大表示を閉じる。
   ・閉じる：「閉じる」・Esc・Android の戻る。HTML 標準の <dialog> と showModal() で作るので、背後の画面は操作できない。
   ・拡大表示が自分で表示用 URL（Blob URL）を発行し、閉じたときに必ず解放する。呼び出し元の画面が描き直されて自分の URL を
     解放しても、開いている拡大表示の画像は消えない（URL を共有しない）。
   ・フェード 0.25 秒（prefers-reduced-motion では即時：CSS）。スワイプの動きも reduced-motion では滑らかに動かさない。

   文字はすべて ui/dom.js の h() を通す（innerHTML は使わない：architecture 14.1）。画像は <img> の src に Blob URL。
   ========================================================= */
import { h } from './dom.js';
import { confirmAction, showAlert, setPageScrollLock } from './dialog.js';
import { showToast } from './toast.js';
import { createUrlPool, imageAlt, imageKindLabel, viewerCounter, IMAGE_TEXT } from '../images.js';

/** キー操作での滑らかなスクロールが終わるまでの目安（ミリ秒） */
const SMOOTH_SCROLL_MS = 450;

/** 今開いている拡大表示（1つだけ） */
let openViewer = null;

/** 動きを減らす設定か（スワイプ以外の移動を滑らかにしない） */
function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 拡大表示を開く。
 * @param {object} opts
 * @param {{id?: string, kind: ('entry'|'exit'), blob: Blob}[]} opts.items 表示する画像（読み出せるものだけ）
 * @param {number} [opts.index] 最初に表示する画像（0 始まり）
 * @param {((item: object) => Promise<void>)|null} [opts.onDelete] 渡すと「削除」を出す。成功したら解決し、失敗したら例外を投げる
 *   （S-04 の詳細から開いたときだけ。入力画面からは渡さない：design 14.4.6）
 * @returns {{ close: () => void, closed: Promise<void> }}
 */
export function openImageViewer({ items, index = 0, onDelete = null }) {
  closeImageViewer(); // 同時に開くのは1つだけ
  const pool = createUrlPool();
  let list = items.filter((x) => x && x.blob);
  let idx = Math.min(Math.max(0, index), Math.max(0, list.length - 1));
  let busy = false;
  let closedAlready = false;
  const returnFocus = document.activeElement;

  const dlg = h('dialog', { class: 'img-viewer', 'aria-label': '画像の拡大表示' });
  const closeBtn = h('button', { type: 'button', class: 'img-viewer__close', onClick: () => close() }, '閉じる');
  const counter = h('span', { class: 'img-viewer__count num', 'aria-live': 'polite' });
  const track = h('div', { class: 'img-viewer__track', tabindex: '0' });
  const kindLabel = h('span', { class: 'img-viewer__kind' });
  const deleteBtn = onDelete
    ? h('button', { type: 'button', class: 'img-viewer__delete', 'aria-label': 'この画像を削除', onClick: () => remove() }, '削除')
    : null;
  dlg.append(
    h('div', { class: 'img-viewer__bar' }, closeBtn, counter, h('span', { 'aria-hidden': 'true' })),
    track,
    h('div', { class: 'img-viewer__foot' }, kindLabel, deleteBtn),
  );

  // 表示用 URL は画像ごとに1回だけ発行する（スワイプのたびに作り直さない）
  const urls = new Map();
  const urlOf = (item) => {
    if (!urls.has(item)) urls.set(item, pool.urlOf(item.blob));
    return urls.get(item);
  };

  function slide(item, i) {
    const img = h('img', { class: 'img-viewer__img', src: urlOf(item), alt: imageAlt(item.kind, i, list.length), decoding: 'async' });
    // 読み出せなかったときは、その1枚だけ「読み込めません」にする（ほかの画像の表示は壊さない）
    img.addEventListener('error', () => img.replaceWith(h('p', { class: 'img-viewer__broken' }, IMAGE_TEXT.broken)));
    return h('figure', { class: 'img-viewer__slide' }, img);
  }

  /** 今の位置に合わせて、上の「1 / 2」と下の「エントリー時」を更新する */
  function updateMeta() {
    const item = list[idx];
    counter.textContent = viewerCounter(idx, list.length);
    kindLabel.textContent = item ? imageKindLabel(item.kind) : '';
  }

  // キー操作などで滑らかに動かしている間は、スクロール量から「何枚目か」を求め直さない（動いている途中の位置で、
  // 行き先を前の画像に戻してしまうのを防ぐ）。動き終わる頃に一度だけ合わせ直す
  let settleUntil = 0;
  let settleTimer = 0;
  function scrollToIndex(i, smooth) {
    const w = track.clientWidth;
    const animate = smooth && !prefersReducedMotion();
    track.scrollTo({ left: i * w, behavior: animate ? 'smooth' : 'auto' });
    if (!animate) return;
    settleUntil = performance.now() + SMOOTH_SCROLL_MS;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(syncFromScroll, SMOOTH_SCROLL_MS + 50);
  }

  function renderSlides() {
    track.replaceChildren(...list.map(slide));
    updateMeta();
  }

  /** スワイプで動いたあとの位置（スクロール量÷幅）から、何枚目かを求める */
  function syncFromScroll() {
    const w = track.clientWidth;
    if (!w || list.length === 0 || closedAlready) return;
    const i = Math.min(list.length - 1, Math.max(0, Math.round(track.scrollLeft / w)));
    if (i !== idx) {
      idx = i;
      updateMeta();
    }
  }
  let frame = 0;
  track.addEventListener('scroll', () => {
    if (performance.now() < settleUntil) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(syncFromScroll);
  });

  // 左右キーで前後へ（最初と最後で止まる。ループしない）
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = Math.min(list.length - 1, Math.max(0, idx + (e.key === 'ArrowRight' ? 1 : -1)));
    if (next === idx) return;
    idx = next;
    updateMeta();
    scrollToIndex(idx, true);
  });

  // トースト「画像を削除しました」を、拡大表示の上（<dialog> は最前面なので、画面の外に置いたままだと隠れる）に出すため、
  // 開いている間だけトーストの置き場を拡大表示の中へ移す
  const toastArea = document.getElementById('toast-area');
  const toastHome = toastArea ? { parent: toastArea.parentNode, next: toastArea.nextSibling } : null;
  function moveToastIn() {
    if (toastArea) dlg.append(toastArea);
  }
  function moveToastBack() {
    if (!toastArea || !toastHome) return;
    const next = toastHome.next && toastHome.next.parentNode === toastHome.parent ? toastHome.next : null;
    toastHome.parent.insertBefore(toastArea, next);
  }

  let resolveClosed = () => {};
  const closed = new Promise((resolve) => { resolveClosed = resolve; });

  function cleanup() {
    if (closedAlready) return;
    closedAlready = true;
    cancelAnimationFrame(frame);
    clearTimeout(settleTimer);
    moveToastBack();
    dlg.remove();
    pool.revokeAll(); // 表示用 URL を必ず解放する（architecture 11.3）
    urls.clear();
    setPageScrollLock(false);
    if (openViewer === handle) openViewer = null;
    if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus({ preventScroll: true });
    resolveClosed();
  }

  function close() {
    if (dlg.open) dlg.close(); // 'close' イベントで cleanup が呼ばれる
    else cleanup();
  }
  dlg.addEventListener('close', cleanup); // Esc・Android の戻るで閉じたときもここに来る

  /** 「削除」：確認 → 物理削除 → トースト → 次の画像（最後の1枚なら閉じる）。design 14.4.6 */
  async function remove() {
    if (busy || !onDelete || list.length === 0) return;
    busy = true;
    const item = list[idx];
    const ok = await confirmAction({ title: 'この画像を削除しますか？', message: '削除した画像は元に戻せません。', confirmLabel: '画像を削除' });
    setPageScrollLock(true); // シートを閉じると背後のスクロール止めが解けるので、拡大表示が開いている間は止め直す
    if (!ok || closedAlready) {
      busy = false;
      return;
    }
    try {
      await onDelete(item);
    } catch (e) {
      console.error('画像を削除できませんでした', e);
      busy = false;
      if (closedAlready) return;
      await showAlert({ title: '画像を削除できませんでした', message: '画像はそのまま残っています。' });
      setPageScrollLock(true);
      return;
    }
    busy = false;
    if (closedAlready) {
      showToast('画像を削除しました');
      return;
    }
    list = list.filter((x) => x !== item);
    const url = urls.get(item);
    if (url) pool.revoke(url);
    urls.delete(item);
    if (list.length === 0) {
      close(); // 最後の1枚なら拡大表示を閉じる（画像グループは詳細の描き直しで消える）
      showToast('画像を削除しました');
      return;
    }
    idx = Math.min(idx, list.length - 1);
    renderSlides();
    scrollToIndex(idx, false);
    showToast('画像を削除しました');
  }

  const handle = { close, closed };
  openViewer = handle;
  document.body.append(dlg);
  moveToastIn();
  setPageScrollLock(true);
  renderSlides();
  dlg.showModal();
  scrollToIndex(idx, false); // 開いたときに選んだ画像の位置へ（アニメーションなし）
  closeBtn.focus({ preventScroll: true });
  return handle;
}

/** 開いている拡大表示を閉じる（画面を離れるとき・別の拡大表示を開くとき） */
export function closeImageViewer() {
  if (openViewer) openViewer.close();
}
