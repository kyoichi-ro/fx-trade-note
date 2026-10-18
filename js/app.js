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
     ⑨ 孤立画像の掃除（画面の表示が終わったあと） ← T-24（images.js の sweepOrphans：architecture 11.6）
   ①〜⑨ をすべて行う（⑤ は T-28 で追加）。
   T-11：お知らせ行を共通部品 ui/notice.js（#notice-area に出す showAppNotice）に置き換えた（design 9.16）。
   T-15：③ 設定の読み込み・テーマ監視を追加（テーマを当て直し、theme-color をそろえる）。
   T-17：⑦ 下書きの確認を追加（30分以内の新規エントリーの下書きがあれば、一覧 → 入力画面の順に履歴を作って入力画面を開く）。
   T-21：⑦ に決済の下書きも加えた（対象の記録が削除・決済済みになっていた決済の下書きは、黙って消して次の候補を見る）。
   T-24：⑨ 孤立画像の掃除を追加（どの記録にも下書きにも使われず、作成から1日以上たった画像を、画面の表示が終わった3秒後に削除する）。
   T-22：⑦ に編集の下書きも加えた。決済・編集の下書きは、対象の記録を見て judgeDraftTarget（draft-notice.js）で判定する
   （対象が無い・削除済み・決済済みの決済 → 黙って消す／元の記録が下書きのあとに変わっていた → 自動では開かず、消さずに一覧のお知らせ行へ任せる）。
   T-29：⑥ 永続化リクエストを追加（記録が1件以上あるときだけ。画面の表示を始めたあとに行う）。
   T-28：⑤ Service Worker の登録を追加（中身は sw-update.js。localhost では ?sw=1 のときだけ登録：architecture 18.4）。
   ========================================================= */
import { startRouter } from './router.js';
import { openDb, setHandlers } from './db.js';
import { showAppNotice } from './ui/notice.js';
import { startKeyboardWatch, startInputModalityWatch } from './ui/keyboard.js';
import { settingsStore } from './settings-store.js';
import { applyTheme } from './ui/theme.js';
import { getAllDrafts, pickLaunchDraft, discardDraft, DRAFT_KIND } from './drafts.js';
import { getTrade, getAllTrades } from './trades.js';
import { requestPersistenceOnce } from './data-protection.js';
import { judgeDraftTarget, draftTargetHash, keepsGoneDraft } from './draft-notice.js';
import { sweepOrphans } from './images.js';
import { startServiceWorker } from './sw-update.js';

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
 * 別の画面（タブ）でアプリが新しい版になったとき（DB の版が上がった／Service Worker が切り替わった）。
 * どちらも同じ文言なので、同じ種類のお知らせとして1行だけ出す（両方が同時に起きても2行にしない）。
 * この画面を勝手に再読み込みしないのは、入力の途中かもしれないため（再読み込みは利用者がボタンで行う）。
 */
function showUpdatedElsewhere() {
  showAppProblem('updated-elsewhere', 'アプリが別の画面で更新されました。再読み込みしてください。', '再読み込み');
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
    onVersionChange: showUpdatedElsewhere,
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
 * ・復元できる入力画面は、新規エントリー（T-17）・決済（T-21）・編集（T-22）。
 * ・決済・編集の下書きは、対象の記録がまだ開いてよい状態のときだけ自動で開く（judgeDraftTarget：draft-notice.js）。
 *   - 'gone'（削除済み・存在しない・すでに決済済みの決済）：下書きを黙って消して、次の候補（30分以内でいちばん新しいもの）を見る（design 14.2.10）
 *   - 'stale'（下書きを作ったあとに元の記録が変更された）：古い内容で上書きしないよう自動では開かない。下書きは消さず、
 *     一覧を表示したときにお知らせ行が「元の記録が変更されたため、入力途中の編集を破棄しました」と知らせて消す（list.js。architecture 9.3）。
 *     ここで消さないのは、知らせる前に消すと利用者が気づけないため
 *   記録を読めなかった（DB のエラー）ときは、下書きを消さずに自動で開くのをやめる（一覧のお知らせ行や［決済］［編集］から開き直せる）。
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
  const kinds = [DRAFT_KIND.NEW, DRAFT_KIND.CLOSE, DRAFT_KIND.EDIT];
  let draft = pickLaunchDraft(drafts, { kinds });
  while (draft && draft.kind !== DRAFT_KIND.NEW) {
    let target;
    try {
      target = await getTrade(draft.tradeId);
    } catch (err) {
      console.error('下書きの対象の記録を確認できませんでした', err);
      return;
    }
    const verdict = judgeDraftTarget(draft, target);
    if (verdict === 'ok') break;
    if (verdict === 'gone' && !keepsGoneDraft(draft, target)) {
      // 対象が無くなった下書き：黙って消して、次の候補へ（削除して1分以内の記録の下書きは、取り消しに備えて消さずに候補から外すだけ：T-33 R-10）
      try {
        await discardDraft(draft.key);
      } catch (err) {
        console.error('下書きを消せませんでした', err);
      }
    }
    // 'stale' は消さずに、この起動では自動で開く候補から外すだけ（知らせて消すのは一覧）
    const dropped = draft.key;
    drafts = drafts.filter((d) => d.key !== dropped);
    draft = pickLaunchDraft(drafts, { kinds });
  }
  if (!draft) return;
  history.replaceState({ fxnoteIdx: 0 }, '', '#/');
  history.pushState({ fxnoteIdx: 1 }, '', draftTargetHash(draft));
}

/**
 * ⑥ 永続化リクエスト（architecture 12.5、requirements 8章）。
 * ブラウザに「このアプリの記録を、容量が足りないときなどに勝手に消さないで」と頼む（navigator.storage.persist()）。
 * ・頼むのは「記録が1件以上あるとき」だけ。PC の Firefox などは頼むと確認の画面を出すので、記録が無いうちに出しても
 *   何のことか伝わらないため（最初の1件は、保存した直後に entry.js から頼む）
 * ・すでに保護されていれば頼まない／1回の起動で1回だけ（data-protection.js の requestPersistenceOnce）
 * ・結果は設定画面の「データの保護」に出す（設定画面はそのときの状態を読み直すので、ここでは覚えない）
 * ・起動を遅らせないよう、画面の表示を始めたあとに行い、失敗しても何も出さない（保護は「あれば使う」機能のため）
 * 「ホーム画面に追加して使う」の案内は、一覧のお知らせ行（list.js）が出す。
 */
function requestPersistenceIfHasRecords() {
  getAllTrades()
    .then((trades) => (trades.length > 0 ? requestPersistenceOnce() : null))
    // 結果は開発者ツールで確かめられるようにだけ出す（null＝記録が無い・機能がない）
    .then((persisted) => { if (persisted != null) console.info(`データの保護：${persisted ? '有効' : 'ブラウザ任せ'}`); })
    .catch((err) => console.error('データの保護を確認できませんでした', err));
}

/**
 * ⑨ 孤立画像の掃除（architecture 11.6）。アプリを開くたびに、画面の表示が終わった少しあとで行う（起動を遅らせないため）。
 * 保存せずにアプリが閉じられて残った、どの記録にも下書きにも使われていない画像のうち、作成から1日以上たったものだけを消す
 * （1日未満のものは入力中の画像かもしれないので残す）。失敗しても画面には何も出さない（次に開いたときにもう一度やる）。
 */
function scheduleOrphanSweep() {
  setTimeout(() => {
    sweepOrphans()
      .then((removed) => { if (removed.length > 0) console.info(`孤立画像を ${removed.length} 枚削除しました`); })
      .catch((err) => console.error('孤立画像の掃除に失敗しました', err));
  }, 3000);
}

async function main() {
  installGlobalErrorHandlers();
  openDatabase();

  // ③ 設定の読み込み・テーマ監視
  loadSettingsAndWatchTheme();

  // ④ キーボード表示の監視（入力画面の下部の保存ボタンを隠す：design 8.4）と、Tab キー操作の判定（フォーカス枠）
  startKeyboardWatch();
  startInputModalityWatch();

  // ⑤ Service Worker の登録（オフライン対応・新しい版の確認）。待たずに先へ進む（起動を遅らせない。失敗してもアプリは動く）
  startServiceWorker({ onUpdatedElsewhere: showUpdatedElsewhere });

  // ⑦ 下書きの確認（30分以内なら入力画面を自動で開く）
  await openRecentDraft();

  // ⑧ ルーター開始：URL の # に合わせて最初の画面を表示し、以後の切り替えを受け持つ
  startRouter({
    root: document.getElementById('app'),
    tabbar: document.querySelector('.tabbar'),
  });

  // ⑥ 永続化リクエスト（順番の表では⑤の次だが、起動を遅らせないよう画面の表示を始めたあとに行う）
  requestPersistenceIfHasRecords();

  // ⑨ 孤立画像の掃除（画面の表示が終わったあと）
  scheduleOrphanSweep();
}

main();
