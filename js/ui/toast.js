/* =========================================================
   js/ui/toast.js
   トースト：画面の下に数秒だけ出る短い通知（design.md 9.6・14.7.5）。

   ・成功の通知だけに使う。保存の失敗などは自動で消えると見逃すので、dialog.js の showAlert を使う（design 9.6）。
   ・同時に出すのは1つだけ。新しいものが来たら入れ替える（取り消しの機会もそこで終わる）。
   ・表示時間：成功 3秒、「取り消す」付き 6秒。タップで即閉じる。
   ・「取り消す」にフォーカスがある間（キーボード・VoiceOver 操作中）と、トーストを指で押している間は
     6秒のカウントを止める（読み上げ利用者が間に合わない問題を防ぐ：design 14.7.5）。
   ・置き場所は index.html の #toast-area（role="status"＝読み上げ機能に「お知らせ」として伝わる）。
     位置（タブバー・下部操作バー・新規エントリーボタンの上）は css/components.css が画面の型に合わせて決める。

   【画面を移ったとき】「取り消す」付きのトーストは、別の画面へ移ったら消す（design 14.7.5）。
   router.js が画面を表示し終えるたびに syncToastWithRoute() を呼ぶ。トーストは出した時点の URL を覚えていて、
   URL が変わっていたら消す。成功だけのトースト（「保存しました」）は、保存して一覧へ戻る動きの途中で
   消えないよう、3秒のまま残す。
   ※ 削除の取り消し（T-22）は「一覧に戻って表示し終えてから」showToast を呼ぶこと（先に出すと、戻った時点で消える）。
   ========================================================= */
import { h } from './dom.js';
import { icon } from './icons.js';

const DURATION_PLAIN = 3000;  // 成功（design 9.6）
const DURATION_ACTION = 6000; // 「取り消す」付き（design 9.6・14.7.5）

/** 今出しているトースト（1つだけ） */
let current = null;

/** トーストの置き場。index.html にあればそれを使い、なければ（確認用ページなど）作る */
function area() {
  let el = document.getElementById('toast-area');
  if (!el) {
    el = h('div', { id: 'toast-area', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  return el;
}

/**
 * 残り時間を数えるタイマー。止めた（pause）ときは残り時間を覚えておき、再開（resume）で続きから数える。
 */
function createTimer(ms, onDone) {
  let remaining = ms;
  let startedAt = 0;
  let id = null;
  const api = {
    resume() {
      if (id !== null || remaining <= 0) return;
      startedAt = Date.now();
      id = setTimeout(() => { id = null; onDone(); }, remaining);
    },
    pause() {
      if (id === null) return;
      clearTimeout(id);
      id = null;
      remaining -= Date.now() - startedAt;
    },
    cancel() {
      if (id !== null) clearTimeout(id);
      id = null;
      remaining = 0;
    },
  };
  return api;
}

/**
 * トーストを出す。文言は短く具体的に・感嘆符なし（design 9.6・10.1 #8）。
 * @param {string} message 例「保存しました」「削除しました」
 * @param {{ action?: { label: string, onClick: Function }, duration?: number, iconName?: (string|null) }} [opts]
 *   action   … 右端の文字ボタン（現在は「取り消す」のみ）。押すとトーストを閉じてから onClick を呼ぶ
 *   iconName … 先頭の線画アイコン（既定は ✓ 成功）。null で出さない
 * @returns {{ dismiss: () => void }}
 */
export function showToast(message, { action = null, duration, iconName = 'check' } = {}) {
  hideToast();
  const box = area();
  const ms = duration ?? (action ? DURATION_ACTION : DURATION_PLAIN);

  const el = h('div', { class: 'toast' },
    iconName ? icon(iconName, { className: 'toast__icon' }) : null,
    h('span', { class: 'toast__text' }, message,
      // 読み上げ文「削除しました。取り消すボタンがあります」（design 14.7.5）
      action ? h('span', { class: 'visually-hidden' }, `。${action.label}ボタンがあります`) : null),
    action ? h('button', {
      type: 'button',
      class: 'toast__action',
      onClick: (e) => {
        e.stopPropagation(); // トースト自体のタップ（閉じる）と二重に動かないように
        hideToast();
        action.onClick();
      },
    }, action.label) : null,
  );

  const entry = { el, timer: null, hash: location.hash, hasAction: Boolean(action) };
  entry.timer = createTimer(ms, () => { if (current === entry) hideToast(); });

  // タップで即閉じる（「取り消す」ボタンは上で止めている）
  el.addEventListener('click', () => { if (current === entry) hideToast(); });
  // 押している間・フォーカスがある間はカウントを止める（design 14.7.5）
  el.addEventListener('pointerdown', () => entry.timer.pause());
  el.addEventListener('pointerup', () => { if (!el.contains(document.activeElement)) entry.timer.resume(); });
  el.addEventListener('pointercancel', () => entry.timer.resume());
  el.addEventListener('focusin', () => entry.timer.pause());
  el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) entry.timer.resume(); });

  current = entry;
  box.replaceChildren(el);
  entry.timer.resume();
  return { dismiss: () => { if (current === entry) hideToast(); } };
}

/** 今のトーストを消す */
export function hideToast() {
  if (!current) return;
  current.timer.cancel();
  current.el.remove();
  current = null;
}

/**
 * 画面を移ったときに呼ぶ（router.js）。「取り消す」付きのトーストを、出したときと違う画面なら消す（design 14.7.5）。
 */
export function syncToastWithRoute() {
  if (current && current.hasAction && current.hash !== location.hash) hideToast();
}
