/* =========================================================
   js/data-protection.js
   データ保護まわりの判定と文言（T-29。architecture 12.5・17章 #1・#23、design 14.3.8・14.6.1・14.6.2・14.6.6、
   requirements 8章「データ保護」）。

   ・ホーム画面版（standalone）かどうか、iPhone/iPad かどうかの判定
   ・一覧のお知らせ行「ホーム画面に追加すると、記録が消えにくくなります［方法］」を出すかどうか
   ・永続化リクエスト（navigator.storage.persist()）と、その結果の表示（「有効」／「ブラウザ任せ」）
   ・使用量（navigator.storage.estimate()）の表示（「12 MB」「1 MB未満」）

   なぜ画面から分けたか：
   どれもブラウザの機能（navigator・matchMedia）を見て決めるだけなので、その部分を引数 env で差し替えられるようにすれば、
   Node.js のテストでも「iPhone の Safari」「ホーム画面版」「機能がない古いブラウザ」を再現して確かめられる。
   画面（list.js・settings.js・install-guide.js）は、ここで決めた結果を表示するだけにする。
   env を省くと本物のブラウザ（globalThis）を見る。
   ========================================================= */

/* ---------------------------------------------------------
   ホーム画面版か・iPhone か
   --------------------------------------------------------- */

/**
 * ホーム画面に追加したアプリとして開いているか（architecture 12.5）。
 * ・iPhone の Safari は navigator.standalone（Apple 独自の印）が true になる
 * ・Android・PC は CSS の display-mode: standalone で分かる（manifest.json の display: standalone で開いたとき）
 * どちらか一方でも当てはまればホーム画面版とみなす。判定できない環境（Node など）は false。
 * @param {{ navigator?: object, matchMedia?: Function }} [env]
 * @returns {boolean}
 */
export function isStandalone(env = globalThis) {
  try {
    if (env.navigator && env.navigator.standalone === true) return true;
    return typeof env.matchMedia === 'function' && env.matchMedia('(display-mode: standalone)').matches === true;
  } catch (e) {
    return false;
  }
}

/**
 * iPhone・iPad（iOS / iPadOS）か。
 * 「7日間使わないと記録が消えることがある」のは iOS の Safari の決まりなので、案内はこの端末にだけ出す
 * （Android の Chrome や PC で同じ案内を出すと、当てはまらない注意で利用者を不安にさせるため）。
 * iPadOS 13 以降の Safari は PC（Mac）と同じ名乗り方をするので、「Mac を名乗っているのにタッチ操作ができる」ものも iPad とみなす。
 * iPhone の Chrome・Firefox なども中身は Safari と同じ仕組み（WebKit）で、同じ決まりの対象なので含める。
 * @param {{ navigator?: object }} [env]
 * @returns {boolean}
 */
export function isIos(env = globalThis) {
  const nav = env.navigator;
  if (!nav) return false;
  const ua = String(nav.userAgent || '');
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && Number(nav.maxTouchPoints) > 1;
}

/**
 * iPhone の Safari 以外のブラウザ（Chrome・Firefox・Edge）か。画面の文言「Safariで開いています」を出し分けるためだけに使う
 * （iPhone の Chrome で開いているのに「Safari」と出すと、利用者が探す画面を取り違えるため）。
 */
function isIosOtherBrowser(env) {
  const ua = String((env.navigator && env.navigator.userAgent) || '');
  return /CriOS|FxiOS|EdgiOS/.test(ua);
}

/**
 * 一覧のお知らせ行「ホーム画面に追加すると、記録が消えにくくなります［方法］」を出すか（design 14.3.8 の優先4）。
 * iPhone・iPad で、ホーム画面版ではなく（ブラウザで開いていて）、この起動中に × で閉じていないときだけ出す。
 * @param {{ ios: boolean, standalone: boolean, dismissed: boolean }} state
 * @returns {boolean}
 */
export function shouldShowInstallNotice({ ios, standalone, dismissed }) {
  return ios === true && standalone !== true && dismissed !== true;
}

/** 一覧のお知らせ行の文言（design 14.3.8。右のボタンは［方法］→ #/settings/install） */
export const INSTALL_NOTICE = Object.freeze({
  // 375px の画面で2行にちょうど収まる長さ（12文字×2行）。以前の文は「す」1文字だけが3行目に落ちていた（T-33 U-04）
  text: 'ホーム画面に追加すると、記録が消えにくくなります',
  actionLabel: '方法',
  hash: '#/settings/install',
});

/**
 * 「ホーム画面への追加」画面の一番上に出す、今の状態（design 14.6.6）。
 * ホーム画面版なら ✓（アクセント色）、ブラウザなら ⚠（琥珀）。
 * design のワイヤーフレームは iPhone の Safari を想定した「Safariで開いています」なので、
 * Safari 以外（Android・PC・iPhone の Chrome など）では「ブラウザで開いています」にする（Safari ではないのに Safari と出さないため）。
 * @param {{ navigator?: object, matchMedia?: Function }} [env]
 * @returns {{ standalone: boolean, text: string, tone: 'ok'|'warning' }}
 */
export function installState(env = globalThis) {
  if (isStandalone(env)) return { standalone: true, text: 'ホーム画面のアプリで開いています', tone: 'ok' };
  const safari = isIos(env) && !isIosOtherBrowser(env);
  return { standalone: false, text: safari ? 'Safariで開いています' : 'ブラウザで開いています', tone: 'warning' };
}

/* ---------------------------------------------------------
   永続化リクエスト（navigator.storage.persist）
   --------------------------------------------------------- */

/** この環境の navigator.storage（persist・persisted が両方あるときだけ）。なければ null */
function storageManager(env) {
  const storage = env.navigator && env.navigator.storage;
  if (!storage || typeof storage.persist !== 'function' || typeof storage.persisted !== 'function') return null;
  return storage;
}

/**
 * 「保護されているか」を読むだけ（頼みはしない）。設定画面の表示に使う。
 * @param {{ navigator?: object }} [env]
 * @returns {Promise<boolean|null>} true＝保護されている／false＝ブラウザ任せ／null＝機能がない・読めない（行を出さない）
 */
export async function readPersisted(env = globalThis) {
  const storage = storageManager(env);
  if (!storage) return null;
  try {
    return (await storage.persisted()) === true;
  } catch (e) {
    return null;
  }
}

/**
 * ブラウザに「このサイトのデータを勝手に消さないで」と頼む（architecture 12.5）。
 * すでに保護されていれば頼まない（PC の Firefox などは頼むたびに確認の画面を出すため、余計に出さない）。
 * 失敗しても例外は投げない（保護は「あれば使う」機能で、アプリの動きには関係しないため）。
 * @param {{ navigator?: object }} [env]
 * @returns {Promise<boolean|null>} 頼んだあとの状態。機能がない・失敗したときは null
 */
export async function requestPersistence(env = globalThis) {
  const storage = storageManager(env);
  if (!storage) return null;
  try {
    if ((await storage.persisted()) === true) return true;
    return (await storage.persist()) === true;
  } catch (e) {
    return null;
  }
}

/**
 * 「1回の起動で1回だけ頼む」形の requestPersistence を作る（architecture 12.5「拒否されても繰り返し求めない」）。
 * 起動時（記録があるとき）と、記録を保存した直後（最初の1件）の両方から呼ばれるが、実際に頼むのは最初の1回だけ。
 * 2回目以降は1回目の結果（Promise）をそのまま返す。
 * ※ 起動をまたいで「一度断られた」ことは覚えていない（覚えるには requirements 6.3 に無い設定キーが要るため）。
 *   Chrome・Safari は確認の画面を出さずに自動で決めるので、起動のたびに頼んでも利用者の手間にはならない。
 * @param {{ navigator?: object }} [env]
 * @returns {() => Promise<boolean|null>}
 */
export function createPersistRequester(env = globalThis) {
  let pending = null;
  return () => {
    if (!pending) pending = requestPersistence(env);
    return pending;
  };
}

/** アプリ全体で使う「1回だけ頼む」関数（app.js の起動時と、entry.js の保存の直後から呼ぶ） */
export const requestPersistenceOnce = createPersistRequester();

/**
 * 設定画面「データの保護」の行の値（design 14.6.2）。
 * @param {boolean|null} persisted readPersisted() の結果
 * @returns {string|null} '有効'／'ブラウザ任せ'。機能がない環境（null）では行を出さないので null
 */
export function protectionLabel(persisted) {
  if (persisted === true) return '有効';
  if (persisted === false) return 'ブラウザ任せ';
  return null;
}

/** 「このアプリについて」の下の説明文（design 14.6.1） */
export const PROTECTION_NOTE = '記録はこの端末の中だけに保存されています。機種変更やアプリの削除の前に、CSVを書き出してください。';

/** 「データの保護」が「ブラウザ任せ」のときに説明文の先頭に足す文（design 14.6.1・architecture 12.5） */
export const PROTECTION_OFF_NOTE = 'データの保護が有効になっていません。ホーム画面に追加して使うと有効になりやすくなります。';

/**
 * 「このアプリについて」の下の説明文（design 14.6.1）。
 * 「ブラウザ任せ」（false）のときだけ先頭に注意を足す。機能がない環境（null）は行も出さないので注意も足さない
 * （「データの保護」の行が無いのに、その名前の注意だけが出ると意味が通じないため）。
 * @param {boolean|null} persisted
 * @returns {string}
 */
export function protectionNote(persisted) {
  return persisted === false ? `${PROTECTION_OFF_NOTE}${PROTECTION_NOTE}` : PROTECTION_NOTE;
}

/* ---------------------------------------------------------
   使用量（navigator.storage.estimate）
   --------------------------------------------------------- */

/** 1MB のバイト数。iPhone の「設定」の容量表示と同じく 1,000,000 バイトで数える（端末の表示と数字をそろえるため） */
const MB = 1000 * 1000;

/**
 * このアプリが使っている容量（バイト）を読む。機能がない・読めないときは null（設定画面で行を出さない：design 14.6.2）。
 * @param {{ navigator?: object }} [env]
 * @returns {Promise<number|null>}
 */
export async function readUsage(env = globalThis) {
  const storage = env.navigator && env.navigator.storage;
  if (!storage || typeof storage.estimate !== 'function') return null;
  try {
    const { usage } = await storage.estimate();
    return Number.isFinite(usage) && usage >= 0 ? usage : null;
  } catch (e) {
    return null;
  }
}

/**
 * 使用量の表示（design 14.6.2：MB で小数なし。1MB 未満は「1 MB未満」）。
 * 小数を出さないのは、ブラウザの値はおおよその見積もりで、細かい桁に意味がないため。四捨五入する。
 * @param {number|null} bytes
 * @returns {string|null} 値が無ければ null（行を出さない）
 */
export function formatUsage(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < MB) return '1 MB未満';
  return `${Math.round(bytes / MB).toLocaleString('ja-JP')} MB`;
}
