/* =========================================================
   js/util.js
   小さな道具（architecture.md 4.2：T-12）。
     ・newId()    … 記録・画像の ID（UUID）を作る
     ・debounce() … 連続する処理を「止まってから1回だけ」にする（下書きの自動保存 0.5秒：architecture 9.2）
     ・AppError   … アプリ共通のエラー（code ＋ 日本語の message：architecture 15.1）
     ・assertKnownKeys() … 保存する記録に requirements 6章にない項目が混ざっていないかの確認

   ・ここは「基礎」の層（architecture 4.3）。画面も IndexedDB も触らず、他のファイルも import しない。
   ========================================================= */

/**
 * UUID（v4 形式。例 3f2b8c1e-6a0d-4e2f-9b7a-1c2d3e4f5a6b）を作る。
 *
 * なぜ代わりの方法を持つのか（architecture 17章 #16）：
 * crypto.randomUUID は https か localhost で開いたときしか使えない。パソコンの IP アドレス
 * （http://192.168.…）で iPhone から開いて見た目を確認するときでも ID が作れるよう、
 * どこでも使える crypto.getRandomValues で同じ形の UUID を組み立てる。
 * Math.random は「推測されにくさ」が保証されないので使わない。
 * @returns {string}
 */
export function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch (e) {
      // セキュアコンテキストでない環境では例外になることがあるので、下の方法に切り替える
    }
  }
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // バージョン 4（ランダム）の印
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 の印
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 連続して呼ばれる処理を「呼ばれなくなってから wait ミリ秒後に1回だけ」実行する（デバウンス）。
 * 返す関数には、待たずにすぐ実行する flush() と、予約を取り消す cancel() が付いている。
 * flush() は「アプリが裏に回った瞬間に下書きを即時保存する」（architecture 9.2）ために使う。
 * @param {Function} fn
 * @param {number} wait ミリ秒
 */
export function debounce(fn, wait) {
  let timer = null;
  let lastArgs = null;
  const run = () => {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    return fn(...args);
  };
  const debounced = (...args) => {
    lastArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, wait);
  };
  /** 予約中の処理があれば、待たずに今すぐ実行する（予約がなければ何もしない） */
  debounced.flush = () => {
    if (timer === null) return undefined;
    clearTimeout(timer);
    return run();
  };
  /** 予約中の処理を取り消す（「入力内容を破棄」を選んだときなど） */
  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  /** 予約中の処理があるか */
  debounced.pending = () => timer !== null;
  return debounced;
}

/**
 * アプリ共通のエラー（architecture 15.1）。
 * 保存・読み込みの失敗を「握りつぶさず」呼び出し元に返すときは、必ずこの形にする。
 * 画面は code を見て表示の仕方（アラート・お知らせ行・表示しない）を決める。
 * message は「何が起きたか＋どうすればよいか」の日本語の目安。画面の正式な文言は design.md が正なので、
 * 画面側で code から文言を選んでよい。
 *
 * code の一覧（architecture 15.1）：
 *   VALIDATION / QUOTA / DB_WRITE / DB_READ / DUPLICATE / NOT_FOUND / DB_OPEN / VERSION /
 *   IMAGE_DECODE / SETTINGS_WRITE
 */
export class AppError extends Error {
  /**
   * @param {string} code    上の一覧のどれか
   * @param {string} message 日本語の説明
   * @param {object} [options]
   * @param {unknown} [options.cause] 元になったエラー（開発者ツールで原因を調べるため。画面には出さない）
   */
  constructor(code, message, { cause } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** err が AppError で、code が一致するか（code を省略したら AppError かどうかだけ） */
export function isAppError(err, code) {
  return err instanceof AppError && (code === undefined || err.code === code);
}

/**
 * obj に、決められた項目名（keys）以外が入っていないかを確かめる。入っていたら TypeError。
 * なぜ必要か：requirements 6章にない項目（打ち間違いの 'memos' など）がそのまま保存されると、
 * 本来の項目は空のまま・CSV やシートの列もずれる。保存前に気づけるよう、プログラムの誤りとして止める
 * （利用者の入力ミスではないので AppError ではなく TypeError。開発中にコンソールで気づける）。
 * @param {object} obj
 * @param {readonly string[]} keys 許される項目名
 * @param {string} label エラー文に出す名前（例 'trades'）
 */
export function assertKnownKeys(obj, keys, label) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new TypeError(`${label}：オブジェクトで渡してください`);
  }
  const unknown = Object.keys(obj).filter((k) => !keys.includes(k));
  if (unknown.length > 0) {
    throw new TypeError(`${label}：requirements.md 6章にない項目があります（${unknown.join(', ')}）`);
  }
}
