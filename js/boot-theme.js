/* =========================================================
   js/boot-theme.js
   テーマ（ライト/ダーク）を「最初の描画より前に」適用する小さなスクリプト。

   なぜ別ファイル・モジュールにしないのか：
   ・type="module" のスクリプトは描画の後に実行されるため、ダークを選んでいる人の画面が
     一瞬白く光ってから黒くなる（ちらつく）。<head> で同期読み込みすれば描画前に間に合う。
   ・HTML に直接 <script> を書く方法は CSP（architecture.md 14.3）で禁止しているため、別ファイルにした。
   モジュールではないので import は使えない。そのため保存キーの接頭辞 "fxnote:" はここに直接書いている
   （config.js の LS_PREFIX と同じ値。変えるときは両方を直す）。

   保存値は設定画面（T-15。保存は js/settings-store.js）で変える。読み方（light / dark 以外・壊れた値は「端末に合わせる」）は
   settings-store.js と同じ。theme-color（ブラウザのバーの色）は CSS を読んだ後でないと色が分からないため、
   ここではなく起動処理（app.js ③）と設定画面で js/ui/theme.js の applyTheme() がそろえる。
   ========================================================= */
(function () {
  'use strict';
  try {
    // 値は JSON 文字列で保存する約束（architecture.md 7.1）。例："\"dark\""
    var raw = window.localStorage.getItem('fxnote:theme');
    var theme = raw === null ? 'auto' : JSON.parse(raw);
    // light / dark のときだけ <html data-theme> を付ける。auto（端末に合わせる）や壊れた値のときは付けない
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch (e) {
    // localStorage が使えない（プライベートブラウズ等）・値が壊れている場合は、端末の設定に従う（画面は止めない）
  }
})();
