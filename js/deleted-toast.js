/* =========================================================
   js/deleted-toast.js
   「削除しました［取り消す］」のトーストを、一覧に戻って表示が終わってから出すための受け渡し（T-22。
   roadmap T-22・architecture 4.2・design 14.7.5）。

   【なぜ必要か】
   ui/toast.js は、「取り消す」付きのトーストを画面を移ったときに消す（出したときと別の URL になったら消す）。
   詳細画面で削除を確定して先にトーストを出すと、一覧に戻った時点で消えてしまう。
   そこで詳細画面は「このトーストを出して」と預けて（requestDeletedToast）一覧へ戻り、
   一覧が表示を終えたところで受け取って出す（takeDeletedToast）。row-flash.js と同じ作り（このアプリの中の変数で受け渡す）。

   ・預けてから一定時間（WAIT_MS）を過ぎたものは受け取れない（預けたまま一覧に戻らなかったとき、
     ずっとあとに一覧を開いて突然「削除しました」と出る事故を防ぐ）。
   ・DOM に触れない（Node.js でもテストできる）。トーストを出して「取り消す」を押したときの処理は screens/list.js。
   ========================================================= */

/** 預けてから受け取れる時間（ミリ秒）。一覧に戻って描き終わるまでには十分で、あとから出る事故を防げる長さ */
export const DELETED_TOAST_WAIT_MS = 5000;

/** 預かっている { id, deletedAt, until }（なければ null） */
let pending = null;

/**
 * 一覧に戻ったあとに出す「削除しました［取り消す］」を預ける。
 * @param {{ id: string, deletedAt: string }} deleted 削除した記録の ID と、deleteTrade が返した削除日時（取り消しに必要）
 * @param {number} [nowMs] 今（テスト用に差し替えられる）
 */
export function requestDeletedToast({ id, deletedAt }, nowMs = Date.now()) {
  pending = typeof id === 'string' && id !== '' && typeof deletedAt === 'string' && deletedAt !== ''
    ? { id, deletedAt, until: nowMs + DELETED_TOAST_WAIT_MS }
    : null;
}

/**
 * 預かっているものを1度だけ渡す（渡したら空に戻す）。期限を過ぎていたら null。
 * @param {number} [nowMs]
 * @returns {{ id: string, deletedAt: string }|null}
 */
export function takeDeletedToast(nowMs = Date.now()) {
  const p = pending;
  pending = null;
  return p && nowMs <= p.until ? { id: p.id, deletedAt: p.deletedAt } : null;
}
