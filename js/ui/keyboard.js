/* =========================================================
   js/ui/keyboard.js
   ① 画面のキーボード（iPhone のソフトウェアキーボード）が出ているかを判定し、<body> に .keyboard-open を付け外しする
      （design.md 8.4、architecture.md 4.2）。
   ② PC のキーボード（Tab キー）で操作しているかを判定し、<html> に .kbd-nav を付け外しする（T-11 で追加）。

   ①なぜ必要か：iOS Safari はキーボードが出ても画面の高さが縮まず、画面の下に固定した「保存」ボタンが
     キーボードの裏に隠れたり位置がずれたりする。そこで、キーボード表示中は下部操作バーを隠し（css/layout.css）、
     ナビゲーションバー右上の「保存」を使ってもらう（design 8.4）。
     判定：visualViewport（今実際に見えている範囲）の高さが、画面の高さより 150px 以上小さいときをキーボード表示中とする。
     ピンチで拡大しているときも見える範囲は小さくなるため、拡大率（scale）を掛け戻してから比べる。
     さらに「文字を入力する欄にフォーカスがある」ことも条件にして、誤判定を減らす。

   ②なぜ必要か：入力欄（<input>）はタップで選んでも :focus-visible（キーボード操作の印）が付いてしまうブラウザがある。
     design 9.2 は「フォーカス時は iOS と同じくカーソルのみ。キーボード操作時だけ行に枠」なので、
     Tab キーが押されたら .kbd-nav を付け、画面に触れたら外す。行の枠は .kbd-nav のときだけ出す（components.css）。
   ========================================================= */

const KEYBOARD_THRESHOLD = 150; // px（design 8.4 の目安）

/** 文字を入力する欄か（チェックボックスやボタンではキーボードは出ない） */
function isTextEntry(el) {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(el.type);
}

/**
 * キーボード表示の監視を始める（app.js から1回だけ呼ぶ）。
 * @returns {() => void} 監視をやめる関数
 */
export function startKeyboardWatch() {
  const vv = window.visualViewport;
  if (!vv) return () => {}; // 古いブラウザ：判定しない（下部の保存ボタンは出たまま。右上の保存も使える）

  const update = () => {
    const visible = vv.height * vv.scale;
    const open = window.innerHeight - visible > KEYBOARD_THRESHOLD && isTextEntry(document.activeElement);
    document.body.classList.toggle('keyboard-open', open);
  };
  vv.addEventListener('resize', update);
  document.addEventListener('focusin', update);
  // フォーカスが外れた直後はまだキーボードが閉じ切っていないことがあるので、少し待ってから判定し直す
  const onFocusOut = () => setTimeout(update, 100);
  document.addEventListener('focusout', onFocusOut);
  update();
  return () => {
    vv.removeEventListener('resize', update);
    document.removeEventListener('focusin', update);
    document.removeEventListener('focusout', onFocusOut);
    document.body.classList.remove('keyboard-open');
  };
}

/**
 * Tab キーでの操作中かどうかの監視を始める（app.js・確認用ページから1回だけ呼ぶ）。
 */
export function startInputModalityWatch() {
  const root = document.documentElement;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') root.classList.add('kbd-nav');
  }, true);
  document.addEventListener('pointerdown', () => root.classList.remove('kbd-nav'), true);
}
