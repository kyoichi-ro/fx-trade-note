/* =========================================================
   js/router.js
   ハッシュルーティング（URL の # 以降を見て画面を切り替える仕組み：architecture.md 5章）。

   なぜハッシュ（#/…）なのか：
   ・どの画面を開いていてもサーバーが返すのは index.html だけなので、GitHub Pages で
     「ページが見つからない（404）」にならない。サーバー側の設定も要らない。
   ・ページを読み込み直さないので切り替えが速い。

   流れ（architecture.md 5.2）：
   ① URL の # 以降を下の ROUTES と照らし合わせ、画面ファイルとパラメータ（{id} など）を取り出す
   ② 今の画面の後片付け（unmount）を呼ぶ
   ③ 次の画面ファイルを import() で読み込み（使うときに読み込む＝起動を速くするため）、mount で中身を作る
   ④ 画面の型（A/B/C）に合わせて、タブバーの表示・選択中の項目を切り替える

   各画面ファイルは次の形の部品として作る（architecture.md 5.2）：
     export default {
       layout: 'tab' | 'form' | 'detail',   // 型A | 型B | 型C
       tab: 'list' | 'analytics' | 'settings' | null,  // 型Aのとき選択中にするタブ
       title: '画面名',                     // またはパラメータを受け取る関数
       mount(root, { params, nav }) {},     // 画面を作る
       unmount() {},                        // 後片付け
       hasUnsavedChanges() { return false } // 入力画面だけ意味を持つ
       discardChanges() {}                  // 入力画面だけ：「入力内容を破棄」を選んだとき（下書きを消す。T-17）
     };

   この層（起動・画面切替）は画面ファイルを読み込むが、画面ファイルからは router.js を import しない。
   画面には mount の引数 nav（go / replace / back）を渡す（循環 import を作らないため：architecture.md 4.3）。
   ========================================================= */
import { h } from './ui/dom.js';
import { syncToastWithRoute } from './ui/toast.js';
import { actionSheet } from './ui/dialog.js';

/**
 * 選択肢の編集画面で使える種類（architecture.md 5.1）。これ以外の kind は「一覧にない URL」として扱う。
 * ※ 選択肢の種類は T-16 で master.js に移し、そこから読み込む形にする予定
 */
const CHOICE_KINDS = ['pairs', 'entryReasons', 'emotions', 'tags'];

/** 一覧にない URL のときに置き換える先（S-01 一覧） */
const HOME = '#/';

/**
 * URL 一覧（architecture.md 5.1 で確定したもの）。
 * path の「:id」「:kind」はパラメータ（その部分の文字を取り出す）。
 * load は画面ファイルの読み込み。import() の中を文字列で直接書いておくと、
 * どのファイルを使うかが一目で分かり、Service Worker（T-28）のファイル一覧とも照合しやすい。
 * 相対パスは router.js の場所（js/）から見た位置（architecture.md 4.4）。
 *
 * S-07 同期状態（#/settings/sync）は Phase 2 で追加する。それまでは「一覧にない URL」として一覧へ戻す。
 */
const ROUTES = [
  { path: [], load: () => import('./screens/list.js') },                              // S-01 一覧
  { path: ['new'], load: () => import('./screens/entry.js') },                        // S-02 エントリー記録
  { path: ['trades', ':id'], load: () => import('./screens/detail.js') },             // S-04 トレード詳細
  { path: ['trades', ':id', 'close'], load: () => import('./screens/close.js') },     // S-03 決済記録
  { path: ['trades', ':id', 'edit'], load: () => import('./screens/edit.js') },       // S-05 編集
  { path: ['settings'], load: () => import('./screens/settings.js') },                // S-06 設定
  {
    path: ['settings', 'choices', ':kind'],                                           // S-06 選択肢の編集
    load: () => import('./screens/choices.js'),
    // 種類は決まった4つだけ受け付ける
    check: (params) => CHOICE_KINDS.includes(params.kind),
  },
  { path: ['settings', 'install'], load: () => import('./screens/install-guide.js') }, // S-06 ホーム画面への追加方法
  { path: ['analytics'], load: () => import('./screens/analysis.js') },               // S-08 分析
];

/* ---------- 内部の状態 ---------- */

let root = null;        // 画面を描く場所 <main id="app">
let tabbar = null;      // タブバー <nav class="tabbar">
let current = null;     // 今表示している画面の部品
let renderSeq = 0;      // 何回目の画面切替か（素早く続けて切り替えたとき、古い切替の結果を捨てるため）

/**
 * アプリ内で何画面進んだか（履歴の位置）。
 * 各履歴に { fxnoteIdx: 番号 } を記録しておき、「‹ 戻る」で history.back() してよいか判断する。
 * 0 のとき（アプリを開いた直後など）に history.back() すると、アプリの外（前に見ていたページ）へ出たり
 * 何も起きなかったりするため、決めておいた戻り先へ置き換えで移動する（architecture.md 5.3）。
 */
let currentIdx = 0;

/** 画面に渡す移動の道具（画面ファイルが router.js を import しなくて済むように） */
const nav = { go, replace, back };

/* ---------- 公開する関数 ---------- */

/**
 * ルーターを開始する（app.js から1回だけ呼ぶ）。
 * @param {{ root: HTMLElement, tabbar: HTMLElement }} elements
 */
export function startRouter(elements) {
  root = elements.root;
  tabbar = elements.tabbar;

  // ブラウザの自動スクロール復元を止める（ハッシュルーティングでは自動復元が不安定なため。
  // 画面ごとに必要なら自分で復元する：architecture.md 5.5）
  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }

  // 今の履歴に番号が付いていなければ 0 を付ける（再読み込みしたときは前の番号をそのまま使う）
  const idx = readIdx(history.state);
  if (idx === null) {
    history.replaceState({ fxnoteIdx: 0 }, '');
    currentIdx = 0;
  } else {
    currentIdx = idx;
  }

  window.addEventListener('hashchange', onHashChange);
  document.addEventListener('click', onDocumentClick);

  render();
}

/**
 * 画面を進める（履歴に1つ足す）。例：一覧 → 詳細
 * @param {string} hash '#/trades/…' の形
 */
export function go(hash) {
  if (hash === location.hash) return;
  currentIdx += 1;
  // pushState は hashchange を起こさないので、自分で render する
  history.pushState({ fxnoteIdx: currentIdx }, '', hash);
  render();
}

/**
 * 今の画面を置き換える（履歴を増やさない）。タブの切り替え、履歴がないときの戻る、に使う。
 * @param {string} hash
 */
export function replace(hash) {
  if (hash === location.hash) {
    // 同じタブをもう一度押したときは、iOS と同じく画面の先頭までスクロールする
    window.scrollTo({ top: 0 });
    return;
  }
  history.replaceState({ fxnoteIdx: currentIdx }, '', hash);
  render();
}

/**
 * 「‹ 戻る」「キャンセル」と、保存後に呼び出し元へ戻るとき（architecture.md 5.3）。
 * アプリ内で1画面以上進んでいれば history.back()、そうでなければ fallback へ置き換えで移動する。
 *
 * 入力中に離れるときの確認（architecture 5.4・design 14.1.6。T-17 で追加）：
 * 今の画面の hasUnsavedChanges() が true なら、アクションシート「入力内容を破棄しますか？」を出す。
 * ［入力内容を破棄］を選んだら画面の discardChanges()（下書きと追加した画像の削除）を待ってから戻り、
 * ［編集を続ける］なら何もしない。保存に成功した後は、画面側が hasUnsavedChanges() を false にしてから呼ぶので確認は出ない。
 * @param {string} fallback 履歴がないときの戻り先（architecture.md 5.1 の「戻り先」）
 * @returns {Promise<void>}
 */
export async function back(fallback = HOME) {
  const screen = current;
  if (screen && screen.hasUnsavedChanges?.()) {
    const choice = await actionSheet({
      title: '入力内容を破棄しますか？',
      actions: [{ label: '入力内容を破棄', value: 'discard', danger: true }],
      cancelLabel: '編集を続ける',
    });
    if (choice !== 'discard') return;
    try {
      await screen.discardChanges?.();
    } catch (err) {
      // 下書きを消せなくても画面は離れる（残った下書きは一覧のお知らせ行から続きを開ける：design 14.3.8）
      console.error('下書きを消せませんでした', err);
    }
    // 確認を出している間に別の画面へ移っていたら、ここでは動かない
    if (current !== screen) return;
  }
  if (currentIdx > 0) {
    history.back();
  } else {
    replace(fallback);
  }
}

/* ---------- 内部の処理 ---------- */

/** 履歴に付けた番号を読む。付いていなければ null */
function readIdx(state) {
  return state && typeof state.fxnoteIdx === 'number' ? state.fxnoteIdx : null;
}

/**
 * URL の # 以降が変わったとき（リンクを押した・ブラウザの戻る/進む・アドレス欄に入力した）。
 * 戻る/進むなら履歴の番号がそのまま残っているのでそれを使い、
 * 番号がない＝新しく増えた履歴なら、今の番号＋1 を付ける。
 */
function onHashChange() {
  const idx = readIdx(history.state);
  if (idx === null) {
    currentIdx += 1;
    history.replaceState({ fxnoteIdx: currentIdx }, '');
  } else {
    currentIdx = idx;
  }
  render();
}

/**
 * data-nav="replace" の付いたリンク（タブバーなど）は、履歴を増やさない移動にする。
 * 普通のリンク（<a href="#/new">）はブラウザに任せる（hashchange で受け取る）。
 */
function onDocumentClick(event) {
  // 新しいタブで開く操作（Ctrl・⌘ を押しながらのクリックなど）は邪魔しない
  if (event.defaultPrevented || event.button !== 0 ||
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  const link = event.target.closest('a[data-nav="replace"]');
  if (!link) return;
  event.preventDefault();
  replace(link.getAttribute('href'));
}

/**
 * ハッシュを ROUTES と照らし合わせる。
 * @param {string} hash 例 '#/trades/abc/close'
 * @returns {{ route: object, params: object } | null} 一致しなければ null
 */
function matchRoute(hash) {
  // 「#/」で始まらないもの（空・「#」だけ・「#new」など）は一覧にない URL
  if (!hash.startsWith('#/')) return null;

  // '#/trades/abc/close' → ['trades', 'abc', 'close']、'#/' → []
  const rest = hash.slice(2);
  const rawSegments = rest === '' ? [] : rest.split('/');

  let segments;
  try {
    // %E3%81%82 のように符号化された文字を元に戻す。壊れた符号は一覧にない URL として扱う
    segments = rawSegments.map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }

  for (const route of ROUTES) {
    if (route.path.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < route.path.length; i += 1) {
      const part = route.path[i];
      const seg = segments[i];
      if (part.startsWith(':')) {
        // パラメータは空でないこと（'#/trades//close' のような URL は受け付けない）
        if (seg === '') { ok = false; break; }
        params[part.slice(1)] = seg;
      } else if (part !== seg) {
        ok = false;
        break;
      }
    }
    if (ok && (!route.check || route.check(params))) {
      return { route, params };
    }
  }
  return null;
}

/** 今の URL に合わせて画面を描き直す */
async function render() {
  const seq = ++renderSeq;

  let match = matchRoute(location.hash);
  if (!match) {
    // ハッシュが空（開いた直後）や一覧にない URL は、一覧（#/）に置き換える（architecture.md 5.1）。
    // 設計書では location.replace と書いているが、replaceState でも「履歴を増やさない」点は同じで、
    // 余計な hashchange（＝二重の描画）が起きないのでこちらを使う。
    history.replaceState({ fxnoteIdx: currentIdx }, '', HOME);
    match = matchRoute(HOME);
  }

  // 前の画面の後片付け（イベントの解除・画像URLの解放・下書きの即時保存など。中身は各画面で作る）
  if (current) {
    const prev = current;
    current = null;
    try {
      prev.unmount?.();
    } catch (err) {
      console.error('画面の後片付けに失敗しました', err);
    }
  }

  let screen;
  try {
    screen = (await match.route.load()).default;
  } catch (err) {
    console.error('画面ファイルを読み込めませんでした', err);
    if (seq === renderSeq) showLoadError();
    return;
  }

  // 読み込みを待っている間に、別の画面へ切り替えられていたら、この結果は捨てる
  if (seq !== renderSeq) return;

  applyLayout(screen);
  root.replaceChildren();
  window.scrollTo(0, 0);
  document.title = `${resolveTitle(screen, match.params)} - FXトレードノート`;

  try {
    await screen.mount(root, { params: match.params, nav });
  } catch (err) {
    console.error('画面を表示できませんでした', err);
    if (seq === renderSeq) showLoadError();
    return;
  }

  if (seq !== renderSeq) {
    // 表示の準備中に別の画面へ移っていた場合は、すぐ後片付けする
    try { screen.unmount?.(); } catch (err) { console.error(err); }
    return;
  }
  current = screen;
  // 「取り消す」付きのトーストは、別の画面へ移ったら消す（design 14.7.5。ui/toast.js）
  syncToastWithRoute();
}

/** 画面名を求める（パラメータで変わる画面は関数で持っている） */
function resolveTitle(screen, params) {
  return typeof screen.title === 'function' ? screen.title(params) : (screen.title || '');
}

/**
 * 画面の型に合わせて、<body data-layout> とタブバーを切り替える（architecture.md 5.1 の「タブバー」列）。
 * タブバーを出すのは型A（一覧・分析・設定）だけ。入力画面で出さないのは、うっかりタブを押して
 * 入力内容を失う事故を防ぐため（design.md 2.2）。
 */
function applyLayout(screen) {
  document.body.dataset.layout = screen.layout;
  const showTabbar = screen.layout === 'tab';
  tabbar.hidden = !showTabbar;
  for (const item of tabbar.querySelectorAll('[data-tab]')) {
    if (showTabbar && item.dataset.tab === screen.tab) {
      item.setAttribute('aria-current', 'page'); // 選択中（読み上げ機能にも伝わる）
    } else {
      item.removeAttribute('aria-current');
    }
  }
}

/**
 * 画面ファイルの読み込みや表示に失敗したとき（通信が切れていて読み込めない等）。
 * 何も出ない真っ白な画面にせず、「何が起きたか＋どうすればよいか」を日本語で出す（design.md 9.15）。
 * 固定の文言だけを h()（文字はテキストとして入る）で作る。
 */
function showLoadError() {
  document.body.dataset.layout = 'detail';
  tabbar.hidden = true;

  const box = h('div', { class: 'empty', role: 'alert' },
    h('p', { class: 'empty__title' }, '画面を表示できませんでした'),
    h('p', { class: 'empty__text' }, '通信状態を確認してから、もう一度読み込んでください。'),
    h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => location.reload() }, '再読み込み'),
  );

  root.replaceChildren(box);
}
