/* =========================================================
   js/ui/theme.js
   テーマ（端末に合わせる／ライト／ダーク）を画面に当てる部品（design.md 12章「テーマ切替の仕組み」）。T-15 で追加。
     ・<html data-theme>   … light / dark のときだけ付ける。auto（端末に合わせる）は付けない（CSS が端末の設定に従う）
     ・<meta name="theme-color"> … ブラウザのバー（Safari の上下のバーなど）の色。--color-bg と同じ値にそろえる

   なぜ別ファイルなのか：
   ・起動時（app.js）と設定画面（screens/settings.js）の両方から使うため。画面ファイルは app.js を import できない
     （層のルール：architecture 4.3）ので、共通部品の層に置いた。
   ・最初の描画前のテーマの適用は js/boot-theme.js（モジュールでない小さなスクリプト）が受け持つ。ここはその後の
     「設定で変えたとき」と「theme-color の切り替え」を受け持つ。
   ・保存（localStorage）はしない。保存は settings-store.js、どの値を当てるかは呼び出し側が決める。
   ========================================================= */

/**
 * index.html の theme-color（ライト用・ダーク用の2つ。media 付き）。
 * 「端末に合わせる」に戻したとき元の色に戻せるよう、最初に見た色を data-auto-color に覚えておく。
 */
function themeColorMetas() {
  const metas = [...document.querySelectorAll('meta[name="theme-color"]')];
  for (const m of metas) {
    if (m.dataset.autoColor === undefined) m.dataset.autoColor = m.getAttribute('content') || '';
  }
  return metas;
}

/**
 * テーマを画面に当てる。
 * @param {'auto'|'light'|'dark'} theme
 */
export function applyTheme(theme) {
  const html = document.documentElement;
  if (theme === 'light' || theme === 'dark') {
    html.setAttribute('data-theme', theme);
  } else {
    html.removeAttribute('data-theme');
  }
  syncThemeColor(theme);
}

/**
 * theme-color を今のテーマの背景色（--color-bg）にそろえる（design 12章）。
 * ・ライト／ダークを選んだとき：2つの meta の両方を、その色にする（端末の設定がどちらでも同じ色になる）。
 *   色は CSS 変数から読む（値を JavaScript に二重に書かない。デザインの正は design 12章 → variables.css）。
 * ・端末に合わせるとき：index.html に書かれた元の色（media でライト/ダークを切り替える）に戻す。
 *   こうしておくと、アプリを開いたまま端末の設定を切り替えても、ブラウザが自動でバーの色を切り替える。
 */
function syncThemeColor(theme) {
  const metas = themeColorMetas();
  if (theme === 'light' || theme === 'dark') {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim();
    if (!bg) return; // CSS がまだ読めていないときは変えない（誤った色を出すより元の色のままの方がよい）
    for (const m of metas) m.setAttribute('content', bg);
  } else {
    for (const m of metas) m.setAttribute('content', m.dataset.autoColor);
  }
}
