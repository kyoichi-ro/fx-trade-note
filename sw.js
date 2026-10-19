/* =========================================================
   sw.js
   Service Worker（オフライン対応：architecture.md 12章、roadmap T-28）。
   アプリの全ファイルを端末（Cache Storage）に保存し、電波がなくてもアプリを開いて記録できるようにする。

   置き場所はリポジトリのルート（Service Worker は自分が置かれたフォルダ以下しか担当できないため）。
   ファイルの場所はすべて「sw.js からの相対パス」で書く。GitHub Pages ではアプリが /fx-trade-note/ の下に
   置かれるので、先頭が / のパスだと別の場所（github.io の直下）を指してしまうため（architecture 4.5）。

   【公開のたびにやること（architecture 12.3）】
   ① 下の APP_VERSION を js/config.js の APP_VERSION と同じ値に上げる
      （値が変わると「新しい版」として扱われ、利用者に「新しいバージョンがあります［更新］」が出る）。
      どのファイルを直しても必ず上げる（sw.js だけの変更でも。上げないとスマホには直した版が届かない）
   ② ファイルを足した・消したときは SHELL_FILES も直す
   ③ 公開（push）の前に node tests/run-node.mjs（または http://localhost:8000/tests/）で「リリース確認」が全部合格することを確かめる
      （バージョンの一致・SHELL_FILES の書き忘れ／消し忘れ・バージョンの上げ忘れ〔RL-06：Node.js のときだけ〕を自動で見つける）

   このファイルは「モジュール」にしない（普通のスクリプト）。モジュール形式の Service Worker は
   古い iPhone（iOS 16.3 以前）で動かないため。
   ========================================================= */

/** アプリのバージョン。js/config.js の APP_VERSION と必ず同じ値にする（テスト「リリース確認」で確かめる） */
const APP_VERSION = '1.1.0';

/**
 * キャッシュ名の接頭辞。https://ユーザー名.github.io は同じアカウントの他のアプリと Cache Storage を共有するので、
 * このアプリのものだと分かる名前にする。古いキャッシュを消すときも、この接頭辞のものだけを対象にする
 * （他のアプリのキャッシュを消さないため：architecture 12.3・17章 #3）。
 */
const CACHE_PREFIX = 'fxnote-';

/** アプリ本体のキャッシュ名（バージョンごとに別の箱にする。新しい版が有効になったら古い箱を丸ごと消す） */
const SHELL_CACHE = `${CACHE_PREFIX}shell-v${APP_VERSION}`;

/**
 * CDN のファイル（Phase 3 の Chart.js）のキャッシュ名。バージョン固定の URL は中身が変わらないので、
 * アプリの版とは別の箱にして、アプリを更新するたびに取り直さないようにする（architecture 12.2・16章）。
 * Chart.js のバージョンを変えるときは番号を上げる。
 */
const CDN_CACHE = `${CACHE_PREFIX}cdn-v1`;

/**
 * インストール時に保存するアプリの全ファイル（sw.js からの相対パス）。
 * ・index.html・manifest.json・css/・js/（画面ファイル js/screens/ を含む全部）・icons/ の全ファイル
 * ・tests/（開発用）は入れない
 * ・書き忘れ・消し忘れはテスト「リリース確認」が見つける（フォルダの中身・index.html・import との突き合わせ）
 * ・テストが読み取りやすいよう、1行に1ファイル、'…' で囲んで書く
 */
const SHELL_FILES = [
  './index.html',
  './manifest.json',

  './css/variables.css',
  './css/base.css',
  './css/layout.css',
  './css/components.css',
  './css/screens.css',

  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',

  './js/app.js',
  './js/boot-theme.js',
  './js/calc.js',
  './js/choice-list.js',
  './js/close-form.js',
  './js/config.js',
  './js/csv.js',
  './js/csv-import.js',
  './js/data-protection.js',
  './js/datetime.js',
  './js/db.js',
  './js/deleted-toast.js',
  './js/detail-view.js',
  './js/draft-notice.js',
  './js/drafts.js',
  './js/edit-form.js',
  './js/entry-form.js',
  './js/events.js',
  './js/filter.js',
  './js/format.js',
  './js/images.js',
  './js/master.js',
  './js/router.js',
  './js/row-flash.js',
  './js/settings-store.js',
  './js/sw-update.js',
  './js/trades.js',
  './js/util.js',
  './js/validate.js',

  './js/screens/analysis.js',
  './js/screens/choices.js',
  './js/screens/close.js',
  './js/screens/detail.js',
  './js/screens/edit.js',
  './js/screens/entry.js',
  './js/screens/install-guide.js',
  './js/screens/list.js',
  './js/screens/settings-data.js',
  './js/screens/settings-import.js',
  './js/screens/settings.js',

  './js/ui/bars.js',
  './js/ui/dialog.js',
  './js/ui/dom.js',
  './js/ui/fields.js',
  './js/ui/filter-chips.js',
  './js/ui/filter-sheet.js',
  './js/ui/icons.js',
  './js/ui/image-field.js',
  './js/ui/image-viewer.js',
  './js/ui/keyboard.js',
  './js/ui/notice.js',
  './js/ui/pair-chooser.js',
  './js/ui/parts.js',
  './js/ui/sheet.js',
  './js/ui/sortable.js',
  './js/ui/tag-picker.js',
  './js/ui/theme.js',
  './js/ui/toast.js',
];

/**
 * CDN から読み込むファイル（バージョン固定の完全な URL）。Phase 3 で Chart.js を足す。いまは無し。
 * 取得に失敗してもアプリ本体のインストールは止めない（グラフ以外は動くため：architecture 16.2）。
 */
const CDN_FILES = [];

/** この Service Worker の担当範囲（例 https://ユーザー名.github.io/fx-trade-note/）。末尾は / */
const SCOPE_URL = self.registration.scope;

/** 開発用の tests/ フォルダ。キャッシュせず、Service Worker も触らない（いつも最新のテストを動かすため） */
const TESTS_URL = new URL('tests/', SCOPE_URL).href;

/** ページを開く要求に返すファイル（ハッシュルーティングなので、どの画面でも中身は index.html） */
const INDEX_URL = new URL('index.html', SCOPE_URL).href;

/* ---------------------------------------------------------
   インストール：全ファイルを新しい箱に保存する
   --------------------------------------------------------- */

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
  // skipWaiting はここでは呼ばない。新しい版はいったん「待機中」にして、利用者が［更新］を押したときに切り替える
  // （入力の途中で中身が入れ替わる事故を防ぐ：architecture 12.3）
});

async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  // cache: 'reload' … ブラウザの一時保存（HTTP キャッシュ）を使わず必ずサーバーから取る。
  // GitHub Pages はファイルを約10分ブラウザに覚えさせるため、付けないと更新前の古いファイルを保存してしまうことがある（architecture 12.2）。
  // addAll は1つでも失敗すると全体が失敗する（中途半端な箱を使わない）。失敗したら次の機会にブラウザがやり直す。
  try {
    await cache.addAll(SHELL_FILES.map((path) => new Request(path, { cache: 'reload' })));
  } catch (err) {
    // 中途半端な（空の）箱を残さない。残すと「箱はあるのに中身が無い」状態になり、ensureShellCache が作り直さなくなるため
    await caches.delete(SHELL_CACHE);
    throw err;
  }
  await precacheCdn();
}

/**
 * アプリ本体の箱が無ければ作り直す（画面が起動のたびに ENSURE_CACHE で頼む）。
 * 登録はそのままでキャッシュだけが消えた（開発者ツールで消した・開発中に ?sw=1 を外して開いたあとに戻した など）ときに、
 * オフラインで開けないままにならないようにするため。インストールは sw.js が変わらない限りやり直されない。
 */
async function ensureShellCache() {
  if (await caches.has(SHELL_CACHE)) return;
  try {
    await precache();
  } catch (err) {
    console.warn('アプリのファイルを保存し直せませんでした（オフラインなど）', err);
  }
}

/** CDN のファイルを別の箱に保存する。すでにあるものは取り直さない。失敗してもインストールは続ける */
async function precacheCdn() {
  if (CDN_FILES.length === 0) return;
  try {
    const cache = await caches.open(CDN_CACHE);
    for (const url of CDN_FILES) {
      if (await cache.match(url)) continue;
      // CDN は別のオリジンなので、中身を読める形（cors）で取る（読めない形で保存すると容量を大きく食うため）
      const res = await fetch(url, { mode: 'cors', cache: 'reload' });
      if (res.ok) await cache.put(url, res);
    }
  } catch (err) {
    console.warn('CDN のファイルを保存できませんでした（グラフ以外は使えます）', err);
  }
}

/* ---------------------------------------------------------
   有効化：古い版の箱を消す
   --------------------------------------------------------- */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, CDN_CACHE]);
    const names = await caches.keys();
    // 消すのは fxnote- で始まる自分の箱だけ（同じ github.io の他のアプリの箱には触らない）
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && !keep.has(name))
      .map((name) => caches.delete(name)));
    // 初めてのインストールのとき、開いている画面もすぐにこの Service Worker の担当にする
    // （そうしないと、最初に開いた画面ではこのあと読み込む画面ファイルがキャッシュを通らず、
    //   初回の利用中に電波が切れると画面を開けないことがあるため）。
    // 更新のときは［更新］を押した画面がこのあとすぐ再読み込みするので、ここで担当を移しても問題ない。
    await self.clients.claim();
  })());
});

/* ---------------------------------------------------------
   画面からの頼みごと：［更新］が押された（待機中の新しい版に切り替える）・キャッシュの確認
   --------------------------------------------------------- */

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') self.skipWaiting();
  // 画面の起動時：キャッシュが消えていたら作り直す
  if (type === 'ENSURE_CACHE') event.waitUntil(ensureShellCache());
});

/* ---------------------------------------------------------
   通信の受け持ち（architecture 12.2）
   --------------------------------------------------------- */

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // GET 以外（Phase 2 のスプレッドシートへの送信など）は触らない。送信をキャッシュすると同期が壊れるため
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // CDN（Phase 3 の Chart.js）：保存済みならそれを返す
  if (url.origin !== self.location.origin) {
    if (CDN_FILES.includes(req.url)) event.respondWith(fromCdnCache(req));
    return; // それ以外の外部への通信は触らない
  }

  // 担当範囲の外・tests/ はそのまま通信する
  if (!req.url.startsWith(SCOPE_URL) || req.url.startsWith(TESTS_URL)) return;

  // ページを開く要求（アドレスに ?sw=1 などが付いていても）は、保存済みの index.html を返す
  if (req.mode === 'navigate') {
    event.respondWith(openPage(req));
    return;
  }

  event.respondWith(fromTestsPage(event).then((yes) => (yes ? fetch(req) : cacheFirst(req))));
});

/**
 * テストページ（tests/）が読み込むファイルか。テストページは ../js/… のアプリのファイルを読み込むので、
 * これをキャッシュから返すと「直す前の古いコード」をテストしてしまう。テストページからの要求はいつも通信する。
 */
async function fromTestsPage(event) {
  if (!event.clientId) return false;
  const client = await self.clients.get(event.clientId);
  return Boolean(client && client.url.startsWith(TESTS_URL));
}

/** ページを開く：保存済みの index.html → なければ通信（まだインストールが終わっていないとき） */
async function openPage(req) {
  const cached = await caches.match(INDEX_URL, { cacheName: SHELL_CACHE });
  return cached || fetch(req);
}

/**
 * キャッシュ優先：保存済みならそれを返す（通信しないので速く、機内モードでも動く）。
 * 一覧（SHELL_FILES）に無いファイルは通信して取り、成功したら箱に足す。
 * 一覧への書き忘れがあっても、オンラインで一度開けば次からはオフラインでも動くようにする安全策。
 */
async function cacheFirst(req) {
  const cached = await caches.match(req, { cacheName: SHELL_CACHE });
  if (cached) return cached;
  const res = await fetch(req);
  // 箱がまだあるときだけ足す（caches.open は無ければ新しく作ってしまうため。開発中に解除して消した箱や、
  // 古い版の箱を、ここで作り直してしまわないように）。保存に失敗しても（容量不足など）画面には中身を返す
  if (res.ok && res.type === 'basic' && await caches.has(SHELL_CACHE)) {
    const copy = res.clone();
    caches.open(SHELL_CACHE)
      .then((cache) => cache.put(req, copy))
      .catch((err) => console.warn('ファイルを保存できませんでした', req.url, err));
  }
  return res;
}

/** CDN のファイル：保存済みならそれ、なければ通信して保存 */
async function fromCdnCache(req) {
  const cache = await caches.open(CDN_CACHE);
  const cached = await cache.match(req.url);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) cache.put(req.url, res.clone()).catch(() => {});
  return res;
}
