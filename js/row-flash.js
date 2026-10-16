/* =========================================================
   js/row-flash.js
   一覧の「戻った直後の 1 秒ハイライト」の受け渡し（design.md 14.3.4、roadmap 7.8 #1、T-21）。

   保存・決済・削除の取り消しのあとに一覧へ戻ると、その行を約 1 秒だけ目立たせる（「どこに入ったか」が分かるように）。
   入力画面（決済など）が「この記録の行を目立たせて」と預け（requestRowFlash）、一覧が表示を終えたところで受け取る（takeRowFlash）。

   【なぜ URL や履歴ではなくこのファイルの変数で渡すのか】
   ・戻る操作は history.back() で、戻り先の画面に値を渡す仕組みがない。URL に入れると、リロードや共有で残ってしまう。
   ・トースト（ui/toast.js）も同じく、このアプリの中だけで生きる変数で受け渡している。それに合わせた。
   ・預けたまま一覧に戻らなかった場合（詳細に戻った場合など）に、あとで一覧を開いたときに突然光らないよう、
     預けてから一定時間（WAIT_MS）を過ぎたものは受け取れないことにしている。

   ・DOM に触れない（Node.js でもテストできる）。実際に行を光らせる処理は screens/list.js。
   ========================================================= */

/** 預けてから受け取れる時間（ミリ秒）。一覧に戻って描き終わるまでには十分で、あとから光る事故を防げる長さ */
export const FLASH_WAIT_MS = 4000;

/** 行を目立たせておく時間（ミリ秒）。design 14.3.4 の「約 1 秒」 */
export const FLASH_DURATION_MS = 1000;

/** 預かっている記録 { id, until }（なければ null） */
let pending = null;

/**
 * 一覧に戻ったとき目立たせる記録を預ける。
 * @param {string} id 記録の ID
 * @param {number} [nowMs] 今（テスト用に差し替えられる）
 */
export function requestRowFlash(id, nowMs = Date.now()) {
  pending = typeof id === 'string' && id !== '' ? { id, until: nowMs + FLASH_WAIT_MS } : null;
}

/**
 * 預かっている記録を 1 度だけ渡す（渡したら空に戻す）。期限を過ぎていたら null。
 * @param {number} [nowMs]
 * @returns {string|null}
 */
export function takeRowFlash(nowMs = Date.now()) {
  const p = pending;
  pending = null;
  return p && nowMs <= p.until ? p.id : null;
}
