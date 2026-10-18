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

   【T-33：起動に失敗したときの案内（T-31 の S-03）】
   app.js と、そこから読み込まれるファイルのどれかが読めない・書き間違いがあると、app.js が動き出さず、
   app.js の「予期しない問題」の受け止めも登録されないので、画面が真っ白のままになっていた。
   そこで、モジュールでないこのファイルで先にエラーを受け止め、アプリが動き出す前（<html data-booted> が付く前）のエラーなら、
   index.html の #app に書いてある固定の文を「起動できませんでした［再読み込み］」に切り替える。
   ・<script> の読み込みの失敗（app.js から読み込むファイルが 404 など）は、その <script> の error（捕捉の段階で受ける）
   ・書き間違い（文法の誤り）・読み込み時の例外は window の error
   文は index.html に書いてある要素の hidden を切り替えるだけ（要素を文字から作らない。CSP の script-src 'self' のまま動く）。
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

  /** アプリ（app.js）が動き出したか。app.js の main() の最初に <html data-booted> を付ける */
  function booted() {
    return document.documentElement.hasAttribute('data-booted');
  }

  /** 起動に失敗した：#app の「読み込んでいます…」を「起動できませんでした［再読み込み］」に切り替える */
  function showBootFailure() {
    var box = document.getElementById('boot');
    if (!box) return; // すでに画面が描かれている（router が中身を入れ替えた）
    var loading = box.querySelector('[data-boot="loading"]');
    var failed = box.querySelector('[data-boot="failed"]');
    if (loading) loading.hidden = true;
    if (failed) failed.hidden = false;
    box.classList.add('is-failed'); // 1秒待たずにすぐ見せる（css/base.css）
    var button = document.getElementById('boot-reload');
    if (button && !button.dataset.ready) {
      button.dataset.ready = '1';
      button.addEventListener('click', function () { location.reload(); });
    }
  }

  window.addEventListener('error', function (event) {
    if (booted()) return; // 動き出したあとのエラーは app.js が受け止める（お知らせ行）
    var target = event.target;
    var isScriptLoad = target && target.tagName === 'SCRIPT';
    // 画像などの読み込みの失敗は対象にしない（起動とは関係ないため）。スクリプトの失敗と、文法の誤り・例外だけ
    if (isScriptLoad || target === window) showBootFailure();
  }, true);
})();
