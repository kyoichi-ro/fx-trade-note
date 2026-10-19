/* =========================================================
   js/events.js
   アプリ内の変更通知の仕組み（architecture.md 3.3・4.2・8章：T-12）。

   なぜ必要か：
   ・trades.js（業務処理）が「記録が変わった」と知らせるだけにしておけば、
     一覧の再描画（T-19）や Phase 2 の送信（sync.js）を、trades.js を書き換えずに後から足せる。
     trades.js は「誰が聞いているか」を知らなくてよい（architecture 3.3）。

   使い方：
     const off = on('trades-changed', (detail) => { … });   // 受け取る（戻り値の関数で解除）
     emit('trades-changed', { type: 'add', id });            // 知らせる

   通知の名前（今あるもの）：
     'trades-changed' … detail = { type: 'add' | 'update' | 'delete' | 'restore', id, trade }
                        CSV の読み込み（T-44）だけは1回にまとめて detail = { type: 'imported', ids }（id・trade はない）

   ・ここは「基礎」の層（architecture 4.3）。window や document を使わない（Node.js でも動く）。
   ========================================================= */

/** 通知の名前 → 受け取る関数の集まり */
const listeners = new Map();

/**
 * 通知を受け取る関数を登録する。
 * @param {string} name 通知の名前
 * @param {(detail: any) => void} fn
 * @returns {() => void} 登録を解除する関数（画面の unmount で呼ぶ）
 */
export function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => off(name, fn);
}

/** 登録を解除する */
export function off(name, fn) {
  const set = listeners.get(name);
  if (set) set.delete(fn);
}

/**
 * 通知を出す。
 * 受け取る側の1つが失敗しても、他の受け取り手と、通知を出した側（＝保存処理）は止めない。
 * 保存はすでに完了しているので、再描画の失敗で「保存できなかった」ように見せないため。
 * 失敗はコンソールに出し、app.js の想定外のエラーの受け止め（architecture 15.1）に任せる。
 * @param {string} name
 * @param {any} [detail]
 */
export function emit(name, detail) {
  const set = listeners.get(name);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(detail);
    } catch (e) {
      console.error(`通知「${name}」の受け取りで問題が起きました`, e);
      // 想定外のエラーとして扱わせる（画面に「予期しない問題」を出す）。保存処理の流れは止めない
      setTimeout(() => { throw e; }, 0);
    }
  }
}
