/* =========================================================
   js/sw-update.js
   Service Worker（sw.js）の登録と「新しいバージョンがあります［更新］」の仕組み（architecture.md 12.1・12.3・18.4、T-28）。

   流れ：
     ① 起動時に sw.js を登録する（このとき、ブラウザが新しい sw.js が無いかも確かめる）
     ② 前面に戻ったときにも新しい版を確かめる（1時間に1回まで）。iPhone のホーム画面版は、裏から戻っても
        ページを開き直さないため、自分で確かめないと更新に気づけない（architecture 17章 #15）
     ③ 新しい版が「待機中」になったら UPDATE_READY を知らせる → 一覧のお知らせ行・設定の「新しいバージョンに更新」が出る
     ④ 利用者が［更新］を押したら（applyUpdate）待機中の版に切り替えを頼み、切り替わったら1回だけ再読み込みする
   勝手に切り替えない・勝手に再読み込みしないのは、入力の途中で画面が読み込み直されて入力が消えるのを防ぐため。
   ［更新］を押さなくても、アプリを完全に閉じて開き直せば新しい版になる（ブラウザの決まり）。

   登録に失敗しても（古いブラウザ・プライベートブラウズなど）アプリは普通に動く（オフラインで開けないだけ）。
   判定だけの関数（swMode・isUpdateCheckDue）は window を使わないので Node.js でもテストできる。
   ========================================================= */
import { emit } from './events.js';

/** 新しい版が待機中になったときの通知の名前（events.js）。detail はなし */
export const UPDATE_READY = 'app-update-ready';

/** 前面に戻ったときに新しい版を確かめる最短の間隔（1時間：architecture 12.3） */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** パソコンの中で動かしている開発用サーバーの名前（architecture 18.4） */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** 登録した結果（ServiceWorkerRegistration）。登録していない・失敗したときは null */
let registration = null;
/** 最後に新しい版を確かめた時刻（ミリ秒） */
let lastCheckedAt = 0;
/** ［更新］が押されたか（このタブで頼んだ切り替えのときだけ再読み込みするための目印） */
let updateRequested = false;
/** 再読み込みを始めたか（切り替えの知らせが重なっても再読み込みは1回だけにする：architecture 12.3） */
let reloading = false;

/**
 * この URL で Service Worker をどう扱うか（architecture 18.4）。
 * ・localhost（開発中）：?sw=1 が付いているときだけ登録。付いていなければ解除する
 *   （ファイルを直したら再読み込みですぐ反映されるように。キャッシュが残ると直したはずの画面が古いままになる）
 * ・それ以外（公開版の github.io）：いつも登録する
 * @param {{ hostname: string, search: string }} loc location と同じ形
 * @returns {'register'|'unregister'}
 */
export function swMode({ hostname, search }) {
  if (!LOCAL_HOSTS.includes(hostname)) return 'register';
  return new URLSearchParams(search).get('sw') === '1' ? 'register' : 'unregister';
}

/**
 * 前面に戻ったときに、新しい版を確かめてよいか（前回から1時間以上たったか）。
 * 何度も前面と裏を行き来しても、そのたびに通信しないようにするため。
 * @param {number} last 前回確かめた時刻（ミリ秒）
 * @param {number} now 今の時刻（ミリ秒）
 */
export function isUpdateCheckDue(last, now) {
  return now - last >= UPDATE_CHECK_INTERVAL_MS;
}

/** 新しい版が待機中か（一覧・設定が、画面を開いたときに読む） */
export function isUpdateWaiting() {
  return Boolean(registration && registration.waiting && navigator.serviceWorker.controller);
}

/**
 * ［更新］：待機中の新しい版に切り替えて、画面を再読み込みする。
 * 実際の再読み込みは、切り替えが終わった知らせ（controllerchange）を受けてから行う（startServiceWorker の中）。
 * 待機中の版がもう無い（別の画面で切り替え済みなど）ときは、そのまま再読み込みする。
 */
export function applyUpdate() {
  const waiting = registration && registration.waiting;
  if (!waiting) {
    reloadOnce();
    return;
  }
  updateRequested = true;
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

function reloadOnce() {
  if (reloading) return;
  reloading = true;
  location.reload();
}

/** 「最新のバージョンを確認」で、新しい版のファイルの保存（インストール）を待つ最長の時間 */
export const UPDATE_INSTALL_TIMEOUT_MS = 30 * 1000;

/**
 * 設定の「最新のバージョンを確認」：今すぐ新しい版を確かめる（2026-10-26 オーナー要望）。
 * 前面に戻ったときの自動の確認（1時間おき）を待たずに確かめるためのもの。見つかったら保存し終えて待機中になるまで待つ。
 * @returns {Promise<'waiting'|'latest'|'offline'|'unavailable'>}
 *   waiting … 新しい版が待機中（［更新］で切り替えられる）／latest … いまの版が最新
 *   offline … 確かめられなかった（電波がないなど）／unavailable … Service Worker を使っていない（開発中・古いブラウザ）
 */
export async function checkForUpdateNow() {
  if (!registration) return 'unavailable';
  if (isUpdateWaiting()) return 'waiting';
  lastCheckedAt = Date.now();
  try {
    await registration.update();
  } catch (err) {
    console.info('新しい版を確かめられませんでした（オフラインなど）', err);
    return 'offline';
  }
  if (registration.installing) await waitUntilInstalled(registration.installing);
  return isUpdateWaiting() ? 'waiting' : 'latest';
}

/** 新しい版の保存（インストール）が終わる（待機中・失敗のどちらか）まで待つ。長くかかるときは見切る */
function waitUntilInstalled(worker) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', onChange);
      resolve();
    };
    const onChange = () => { if (worker.state !== 'installing') done(); };
    const timer = setTimeout(done, UPDATE_INSTALL_TIMEOUT_MS);
    worker.addEventListener('statechange', onChange);
    onChange();
  });
}

/**
 * Service Worker を登録する（app.js の起動処理 ⑤）。待たなくてよい（失敗しても例外を外に出さない）。
 * @param {{ onUpdatedElsewhere?: () => void }} [opts]
 *   onUpdatedElsewhere … 別の画面（タブ）で［更新］が押されて、この画面も新しい版の担当に切り替わったとき。
 *   この画面を勝手に再読み込みすると入力中の内容が消えるかもしれないので、再読み込みは利用者に任せる（app.js がお知らせ行を出す）
 */
export async function startServiceWorker({ onUpdatedElsewhere = () => {} } = {}) {
  // Service Worker が使えない環境（https でも localhost でもない・古いブラウザ）では何もしない
  if (!('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  try {
    if (swMode(location) === 'unregister') {
      await unregisterForDevelopment();
      return;
    }

    // 登録した時点で担当していた版。null なら初めてのインストール（このとき担当が移っても「更新」ではない）
    const hadController = Boolean(sw.controller);
    sw.addEventListener('controllerchange', () => {
      if (updateRequested) {
        reloadOnce();
      } else if (hadController) {
        onUpdatedElsewhere();
      }
    });

    // updateViaCache: 'none' … sw.js 自体の更新確認でブラウザの一時保存を使わない（いつもサーバーの最新を見る）
    registration = await sw.register('./sw.js', { updateViaCache: 'none' });
    lastCheckedAt = Date.now();
    // 担当中の版に「アプリのファイルの箱が消えていたら作り直して」と頼む（sw.js の ensureShellCache）。
    // 初めてのインストールの途中（active がまだ無い）はインストールで保存するので頼まない
    if (registration.active) registration.active.postMessage({ type: 'ENSURE_CACHE' });
    watchForUpdates(registration);
    document.addEventListener('visibilitychange', checkWhenVisible);
  } catch (err) {
    // 登録に失敗してもアプリは普通に使える（オフラインで開けないだけ）。画面には出さない
    console.warn('Service Worker を登録できませんでした（オフラインでは開けません）', err);
  }
}

/** 新しい版が待機中になるのを見張り、なったら UPDATE_READY を知らせる */
function watchForUpdates(reg) {
  // すでに待機中（前回の起動で見つかったまま［更新］されていない）
  if (isUpdateWaiting()) emit(UPDATE_READY);
  reg.addEventListener('updatefound', () => {
    const installing = reg.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      // 'installed' ＝ 新しい版のファイルを全部保存し終えて待機中になった。
      // 担当している版（controller）が無いときは初めてのインストールなので、お知らせは出さない
      if (installing.state === 'installed' && navigator.serviceWorker.controller) emit(UPDATE_READY);
    });
  });
}

/** 前面に戻ったとき、前回から1時間以上たっていれば新しい版を確かめる（電波がなくて失敗しても何もしない） */
function checkWhenVisible() {
  if (document.visibilityState !== 'visible' || !registration) return;
  const now = Date.now();
  if (!isUpdateCheckDue(lastCheckedAt, now)) return;
  lastCheckedAt = now;
  registration.update().catch((err) => console.info('新しい版を確かめられませんでした（オフラインなど）', err));
}

/**
 * 開発中（localhost で ?sw=1 なし）：登録済みの Service Worker を解除し、このアプリのキャッシュ（fxnote-）を消す。
 * 記録（IndexedDB）と設定（localStorage）には触らない。
 */
async function unregisterForDevelopment() {
  // このアプリの担当範囲（sw.js を置いたフォルダ）のものだけ解除する（同じ localhost の別のアプリには触らない）
  const scope = new URL('./', location.href).href;
  const regs = (await navigator.serviceWorker.getRegistrations()).filter((r) => r.scope === scope);
  await Promise.all(regs.map((r) => r.unregister()));
  if (typeof caches === 'undefined') return;
  const names = await caches.keys();
  await Promise.all(names.filter((n) => n.startsWith('fxnote-')).map((n) => caches.delete(n)));
  if (regs.length > 0) console.info('開発中のため Service Worker を解除しました（使うときは ?sw=1 を付けて開く）');
}
