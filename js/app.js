/* =========================================================
   js/app.js
   アプリの起動処理（入口）。index.html から type="module" で読み込まれる。

   完成時の起動の順番（architecture.md 4.2）：
     ① 想定外のエラーの受け止め  ← T-10
     ② DB を開く                   ← T-12（db.js）
     ③ 設定の読み込み・テーマ監視   ← T-15（settings-store.js）
     ④ キーボード表示の監視         ← T-11（ui/keyboard.js）
     ⑤ Service Worker の登録        ← T-28（sw.js）
     ⑥ 永続化リクエスト・案内       ← T-29
     ⑦ 下書きの確認（30分以内なら入力画面を自動で開く） ← T-17（drafts.js）
     ⑧ ルーター開始                 ← T-10
   いまは ①・②・③・④・⑦・⑧ を行う。他の処理は各タスクで、この順番どおりに足していく。
   T-11：お知らせ行を共通部品 ui/notice.js（#notice-area に出す showAppNotice）に置き換えた（design 9.16）。
   T-15：③ 設定の読み込み・テーマ監視を追加（テーマを当て直し、theme-color をそろえる）。
   T-17：⑦ 下書きの確認を追加（30分以内の新規エントリーの下書きがあれば、一覧 → 入力画面の順に履歴を作って入力画面を開く）。
   ========================================================= */
import { startRouter } from './router.js';
import { openDb, setHandlers } from './db.js';
import { showAppNotice } from './ui/notice.js';
import { startKeyboardWatch, startInputModalityWatch } from './ui/keyboard.js';
import { settingsStore } from './settings-store.js';
import { applyTheme } from './ui/theme.js';
import { getAllDrafts, pickLaunchDraft, DRAFT_KIND } from './drafts.js';

/**
 * アプリ全体の問題を、画面上部の #notice-area にお知らせ行として出す（architecture 4.5・15.1、design 9.16）。
 * 部品は ui/notice.js。同じ種類のお知らせは1つだけ。文言は固定の文字だけで、エラーの中身は画面に出さない
 * （詳しい内容は開発者ツールのコンソールに出す）。どれも「消えない」お知らせなので × は付けない。
 * @param {string} kind お知らせの種類（重複表示を防ぐ目印）
 * @param {string} text 表示する文
 * @param {string|null} buttonLabel ボタンの文字（押すと再読み込み）。null ならボタンなし
 */
function showAppProblem(kind, text, buttonLabel) {
  showAppNotice(kind, {
    iconName: 'warning',
    tone: 'error',
    text,
    action: buttonLabel ? { label: buttonLabel, onClick: () => location.reload() } : null,
  });
}

/**
 * ① 想定外のエラーを受け止める（architecture.md 15.1）。
 * どこかで予期しない問題が起きても真っ白な画面のまま黙らず、
 * 「何が起きたか＋どうすればよいか」を日本語で画面上部に出す。詳しい内容は開発者ツールのコンソールに出す。
 */
function installGlobalErrorHandlers() {
  window.addEventListener('error', (event) => {
    console.error('予期しない問題が起きました', event.error || event.message);
    showUnexpectedErrorNotice();
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('予期しない問題が起きました（Promise）', event.reason);
    showUnexpectedErrorNotice();
  });
}

function showUnexpectedErrorNotice() {
  showAppProblem('unexpected', '予期しない問題が起きました。アプリを再読み込みしてください。', '再読み込み');
}

/**
 * ② DB を開く（architecture 6.10・6.11・15.1）。
 * ・開けない（DB_OPEN）・古いアプリで新しい DB を開いた（VERSION）は、消えないお知らせ行で知らせる。
 * ・他の画面が古い版の DB を開いたまま（onBlocked）、他の画面で新しい版が開かれた（onVersionChange）ときも知らせる。
 * ・ルーターの開始は待たせない。onBlocked のとき DB はいつまでも開き終わらないので、
 *   待つと画面が真っ白のままになるため。保存・読み込みは db.js 側が自分で「開き終わるまで待つ」。
 */
function openDatabase() {
  setHandlers({
    onBlocked: () => showAppProblem('db-blocked', 'アプリを開いている他の画面を閉じてください。', null),
    onVersionChange: () => showAppProblem('db-version-change', 'アプリが別の画面で更新されました。再読み込みしてください。', '再読み込み'),
  });
  openDb().catch((err) => {
    console.error('DB を開けませんでした', err);
    if (err && err.code === 'VERSION') {
      showAppProblem('db-version', 'アプリを最新版に更新してください。', '更新');
    } else {
      showAppProblem('db-open', 'データを保存できない状態です。プライベートブラウズを使っていないか確認してください。', null);
    }
  });
}

/**
 * ③ 設定の読み込み・テーマ監視（architecture 4.2、design 12章）。
 * ・テーマ：boot-theme.js が最初の描画前に <html data-theme> を付けているが、theme-color（ブラウザのバーの色）は
 *   CSS を読んだ後でないと色が分からないため、ここで改めて当てる（applyTheme が両方をそろえる）。
 * ・監視：同じ端末の別のタブ（Safari とホーム画面版は保存場所が別なので、主に PC のブラウザの別タブ）で
 *   テーマが変わったら、このタブにも反映する（storage イベントは「他のタブ」で変わったときだけ届く）。
 *   key が null は「全部消された」の合図なので、そのときも当て直す（初期値＝端末に合わせる に戻る）。
 * ・端末の設定（ライト/ダーク）の切り替えは、CSS（prefers-color-scheme）と theme-color の media が自動で追従するので、
 *   ここで監視する必要はない。
 * ・設定値は localStorage が使えない環境でも初期値で返る（settings-store.js）ので、ここで画面が止まることはない。
 */
function loadSettingsAndWatchTheme() {
  applyTheme(settingsStore.get('theme'));
  const themeKey = settingsStore.storageKey('theme');
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === themeKey) applyTheme(settingsStore.get('theme'));
  });
}

/**
 * ⑦ 下書きの確認（architecture 9.3・design 14.1.10）。
 * iPhone のホーム画面版は、閉じられると次は必ず一覧（#/）から始まる。そのとき最終更新から30分以内の下書きがあれば、
 * 「一覧 → 入力画面」の順に履歴を作ってから入力画面を開く（入力画面の「キャンセル」で一覧に戻れるように）。
 * 入力画面は開いたときに自分で下書きを読み込んで復元する（entry.js）。30分を過ぎた下書きは一覧のお知らせ行で案内する（list.js）。
 * ・一覧以外の URL で開いた（再読み込みなど）ときは、その画面を優先して何もしない。
 * ・T-17 の時点で復元できる入力画面は新規エントリーだけ。決済（T-21）・編集（T-22）の下書きもここで開くようにする。
 * ・DB が開けない・遅い（他の画面が古い版を開いたまま）ときに画面が出ないままにならないよう、1.5秒で見切ってルーターを始める。
 */
async function openRecentDraft() {
  const hash = location.hash;
  if (hash !== '' && hash !== '#' && hash !== '#/') return;
  let drafts = [];
  try {
    drafts = await Promise.race([getAllDrafts(), new Promise((resolve) => { setTimeout(() => resolve([]), 1500); })]);
  } catch (err) {
    console.error('下書きを確認できませんでした', err);
    return;
  }
  const draft = pickLaunchDraft(drafts, { kinds: [DRAFT_KIND.NEW] });
  if (!draft) return;
  history.replaceState({ fxnoteIdx: 0 }, '', '#/');
  history.pushState({ fxnoteIdx: 1 }, '', '#/new');
}

async function main() {
  installGlobalErrorHandlers();
  openDatabase();

  // ③ 設定の読み込み・テーマ監視
  loadSettingsAndWatchTheme();

  // ④ キーボード表示の監視（入力画面の下部の保存ボタンを隠す：design 8.4）と、Tab キー操作の判定（フォーカス枠）
  startKeyboardWatch();
  startInputModalityWatch();

  // ⑦ 下書きの確認（30分以内なら入力画面を自動で開く）
  await openRecentDraft();

  // ⑧ ルーター開始：URL の # に合わせて最初の画面を表示し、以後の切り替えを受け持つ
  startRouter({
    root: document.getElementById('app'),
    tabbar: document.querySelector('.tabbar'),
  });
}

main();
