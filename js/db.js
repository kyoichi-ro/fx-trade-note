/* =========================================================
   js/db.js
   IndexedDB の窓口（architecture.md 4.2・6章：T-12）。DB を開く・移行（バージョンアップ）・各ストアの読み書き。

   この層の約束（architecture 4.3・6.10）：
   ・「保存の窓口」の層。IndexedDB を直接触ってよいのはこのファイルだけ。
     画面（screens/*.js）はここを直接呼ばず、必ず trades.js / drafts.js / images.js を通す。
   ・業務のルール（ID・日時・syncStatus を付ける、論理削除、下書きの扱いなど）は持たない。
     渡されたものをそのまま保存し、保存されているものをそのまま返すだけ。
     それらのルールは一つ上の層の trades.js / images.js / drafts.js が受け持つ（architecture 6.10・8〜10章）。
   ・書き込みは、トランザクションの complete（＝本当に書き込まれた）を待ってから成功を返す。
     個々の書き込み要求の success の時点ではまだ確定していないため（architecture 2章 方針4・6.10）。
   ・失敗は握りつぶさず AppError（util.js。code は architecture 15.1）にして呼び出し元に返す。
     このファイル自身は画面に何も表示しない。

   DB の形（architecture 6.1〜6.5）：
     DB 名 fx-trade-note ／ バージョン 1（config.js の DB_NAME・DB_VERSION）
     ストア trades（キー id ／ インデックス syncStatus）
            images（キー id ／ インデックス tradeId）
            drafts（キー key ／ インデックスなし）

   テストのために、同じ仕組みを別の名前の DB で作れる createDb() を用意している（tests/db.test.js）。
   アプリ本体はこのファイルの下の方で作る appDb（＝本物の fx-trade-note）だけを使う。
   ========================================================= */
import { DB_NAME, DB_VERSION } from './config.js';
import { AppError } from './util.js';

/** ストア名（architecture 6.2）。文字の打ち間違いを防ぐため、他のファイルもこの定数を使う */
export const STORE = Object.freeze({
  TRADES: 'trades',
  IMAGES: 'images',
  DRAFTS: 'drafts',
});

/** インデックス名（architecture 6.3。「実際に取り出す処理があるものだけ」の2個） */
export const INDEX = Object.freeze({
  TRADES_SYNC_STATUS: 'syncStatus',
  IMAGES_TRADE_ID: 'tradeId',
});

/* ---------------------------------------------------------
   各ストアの項目名（キー名）：requirements.md 6章・architecture 6.9 の一致確認表
   ---------------------------------------------------------
   ・requirements 6章の表の順番そのまま。名前を1文字でも変えると、過去の記録・CSV・Phase 2 のシート列と
     合わなくなるため、ここを「正」として業務処理（trades.js など）が知らない項目を弾くのに使う。
   ・db.js 自身はこの一覧で中身を検査しない（渡されたものをそのまま保存する層のため）。
   ・項目を変えるときは requirements 6章 → architecture 6.9 → ここ、の順に直し、必要なら移行処理を足す（6.11）。
   --------------------------------------------------------- */

/** trades の32項目（requirements 6.1） */
export const TRADE_KEYS = Object.freeze([
  'id', 'accountType', 'pair', 'side', 'entryPrice', 'entryAt', 'lots', 'lotUnitSize',
  'slPrice', 'tpPrice', 'riskReward', 'exitPrice', 'exitAt', 'pips', 'profitJpy', 'profitSource',
  'quoteToJpyRate', 'status', 'entryReasons', 'timeframe', 'session', 'emotion', 'exitReason', 'exitEmotion',
  'tags', 'memo', 'imageIds', 'syncStatus', 'syncedAt', 'deletedAt', 'createdAt', 'updatedAt',
]);

/** images の7項目（requirements 6.2。表では「幅・高さ」が1行だが、キーは width と height の2つ） */
export const IMAGE_KEYS = Object.freeze(['id', 'tradeId', 'kind', 'blob', 'width', 'height', 'createdAt']);

/** drafts の10項目（requirements 6.4・architecture 6.5） */
export const DRAFT_KEYS = Object.freeze([
  'key', 'kind', 'tradeId', 'fields', 'uiState', 'addedImageIds', 'removedImageIds', 'baseUpdatedAt',
  'createdAt', 'updatedAt',
]);

/* ---------------------------------------------------------
   移行処理（バージョンアップ）：architecture 6.11
   ---------------------------------------------------------
   ・キー＝「そのバージョンにするための処理」。各処理は「1つ前のバージョンからの差分」だけを書く。
   ・古い端末が v1 → v3 に上がるときも、2 → 3 の順に1段ずつ実行する（下の runMigrations）。
   ・足すのは安全、消すのは慎重に：ストア・インデックス・項目の「追加」は既存データを壊さない。
     ストアの削除や項目名の変更は、新しい形へデータを写し終えてから。同じリリースで古いものを消さない。
   ・データの書き換えは、引数の tx（バージョンアップ用のトランザクション）の中でカーソルを使って行う。
     途中で失敗すれば全体が取り消され、古いデータのまま残る。
   ・ここに処理を足したら config.js の DB_VERSION を同じ番号に上げる。

   【バージョンを上げるときの例（まだ使っていない）】
     2: (db, tx) => {
       // 例1：インデックスの追加（既存データは壊れない）
       tx.objectStore('trades').createIndex('exitAt', 'exitAt', { unique: false });
       // 例2：全記録に新しい項目を足す（requirements 6章の更新とセットで）
       // tx.objectStore('trades').openCursor().onsuccess = (e) => {
       //   const cur = e.target.result; if (!cur) return;
       //   cur.update({ ...cur.value, newKey: null }); cur.continue();
       // };
     },
   --------------------------------------------------------- */
export const MIGRATIONS = Object.freeze({
  /** v1：最初の形。3つのストアと2つのインデックスを作る（architecture 6.2・6.3） */
  1: (db) => {
    const trades = db.createObjectStore(STORE.TRADES, { keyPath: 'id' });
    // Phase 2 の未送信キュー（pending / error の取り出し）用。重複可（architecture 3.3・6.3）
    trades.createIndex(INDEX.TRADES_SYNC_STATUS, 'syncStatus', { unique: false });

    const images = db.createObjectStore(STORE.IMAGES, { keyPath: 'id' });
    // 画像は重いので全件を読まず、トレード単位で取り出すための索引（architecture 6.4・11.6）
    images.createIndex(INDEX.IMAGES_TRADE_ID, 'tradeId', { unique: false });

    // 下書きのキーは 'new' / 'close:{tradeId}' / 'edit:{tradeId}'（architecture 6.5）
    db.createObjectStore(STORE.DRAFTS, { keyPath: 'key' });
  },
});

/**
 * 古いバージョンから新しいバージョンまで、移行処理を1段ずつ順番に実行する（architecture 6.11）。
 * 途中のバージョンの処理が見つからないときは、半端な形の DB を作らないよう例外にする
 * （呼び出し元でバージョンアップ全体を取り消す）。
 * @param {IDBDatabase} db
 * @param {IDBTransaction} tx バージョンアップ用のトランザクション
 * @param {number} oldVersion 今の端末の DB のバージョン（新規作成なら 0）
 * @param {number} newVersion 開こうとしているバージョン
 * @param {object} migrations
 */
export function runMigrations(db, tx, oldVersion, newVersion, migrations) {
  for (let v = oldVersion + 1; v <= newVersion; v++) {
    const step = migrations[v];
    if (typeof step !== 'function') {
      throw new Error(`DB のバージョン ${v} への移行処理がありません（db.js の MIGRATIONS を確認してください）`);
    }
    step(db, tx, oldVersion);
  }
}

/* ---------------------------------------------------------
   エラーの変換：architecture 15.1
   --------------------------------------------------------- */

/** code ごとの日本語の説明（「何が起きたか＋どうすればよいか」。画面の正式な文言は design.md が正） */
const MESSAGES = Object.freeze({
  DB_OPEN: 'データを保存できない状態です。プライベートブラウズを使っていないか確認してください。',
  VERSION: 'アプリを最新版に更新してください。',
  QUOTA: '保存できませんでした。端末の空き容量が不足している可能性があります。',
  // iOS Safari は容量不足を別の名前（UnknownError や名前のない中断）で返すことがあるため、
  // 名前で断定せず「容量不足の可能性」も案内する（architecture 15.1 のルール）
  DB_WRITE: '保存中に問題が起きました。端末の空き容量が不足している可能性もあります。',
  DB_READ: 'データの読み込み中に問題が起きました。アプリを再読み込みしてください。',
  DUPLICATE: 'この記録はすでに保存されています。',
});

/**
 * IndexedDB のエラー（DOMException）を AppError に変換する。
 * ・QuotaExceededError … QUOTA（容量不足）
 * ・ConstraintError    … DUPLICATE（add で同じキーがすでにある＝二重保存。本アプリのインデックスは
 *                        すべて重複可なので、この名前のエラーは「同じキー」以外では起きない）
 * ・VersionError       … VERSION（古いアプリで新しい DB を開いた）
 * ・それ以外          … fallbackCode（書き込みなら DB_WRITE、読み込みなら DB_READ、開くときは DB_OPEN）
 * すでに AppError ならそのまま返す。元のエラーは cause に残す（開発者ツールで原因を調べるため）。
 * @param {unknown} err
 * @param {'DB_WRITE'|'DB_READ'|'DB_OPEN'} fallbackCode
 * @returns {AppError}
 */
export function toAppError(err, fallbackCode) {
  if (err instanceof AppError) return err;
  const name = err && typeof err === 'object' ? err.name : undefined;
  let code = fallbackCode;
  if (name === 'QuotaExceededError') code = 'QUOTA';
  else if (name === 'ConstraintError') code = 'DUPLICATE';
  else if (name === 'VersionError') code = 'VERSION';
  return new AppError(code, MESSAGES[code] || MESSAGES[fallbackCode], { cause: err ?? undefined });
}

/** IndexedDB 由来のエラー（DOMException）かどうか。プログラムの書き間違い（TypeError 等）と区別するため */
function isDomError(e) {
  return typeof DOMException !== 'undefined' && e instanceof DOMException;
}

/** 1つの要求（IDBRequest）の結果を Promise にする。見つからない（undefined）は null にそろえる */
function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result === undefined ? null : request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ---------------------------------------------------------
   DB の窓口を作る
   --------------------------------------------------------- */

/**
 * DB の窓口（開く・読み書きの関数のまとまり）を作る。
 * アプリ本体は下の appDb を使う。テストは別の名前・別のバージョン・別の移行処理で作って試す
 * （本物のデータに触れずに、移行や失敗時の動きを確かめるため）。
 *
 * @param {object} options
 * @param {string} options.name        DB 名
 * @param {number} options.version     DB のバージョン
 * @param {object} options.migrations  移行処理（MIGRATIONS と同じ形）
 * @param {IDBFactory|null} [options.factory] IndexedDB 本体。省略時は globalThis.indexedDB
 *        （テストで「IndexedDB が使えない環境」を再現するために差し替えられるようにしている）
 */
export function createDb({ name, version, migrations, factory = globalThis.indexedDB } = {}) {
  /** 開いた接続（の Promise）。使い回して、毎回開き直さない（architecture 6.10） */
  let dbPromise = null;

  /**
   * 画面に知らせる必要がある出来事の受け取り手（app.js が登録する）。
   * db.js は画面を知らない（architecture 4.3）ので、表示は受け取り手に任せる。
   *   onBlocked       … 他の画面（タブ）が古い版の DB を開いたままで、バージョンアップを待っている
   *   onVersionChange … 他の画面で新しい版のアプリが開かれ、この画面の接続を閉じた（再読み込みが必要）
   */
  const handlers = { onBlocked: null, onVersionChange: null };

  /**
   * DB を開く（必要なら移行処理を実行する）。2回目以降は同じ接続を返す。
   * 失敗：DB_OPEN（IndexedDB が使えない・移行に失敗した等）／VERSION（端末の DB の方が新しい）
   * @returns {Promise<IDBDatabase>}
   */
  function openDb() {
    if (dbPromise) return dbPromise;

    const p = new Promise((resolve, reject) => {
      // IndexedDB そのものがない・使えない（古いブラウザ、一部のプライベートブラウズ等）
      if (!factory || typeof factory.open !== 'function') {
        reject(new AppError('DB_OPEN', MESSAGES.DB_OPEN));
        return;
      }

      let request;
      try {
        request = factory.open(name, version);
      } catch (e) {
        // 一部のブラウザは、保存が許可されていない設定のとき open() 自体が例外を投げる
        reject(toAppError(e, 'DB_OPEN'));
        return;
      }

      let upgradeError = null;
      request.onupgradeneeded = (event) => {
        const tx = request.transaction;
        try {
          runMigrations(request.result, tx, event.oldVersion, event.newVersion ?? version, migrations);
        } catch (e) {
          // 移行の途中で失敗したら、バージョンアップ全体を取り消す（古いデータ・古いバージョンのまま残る）
          upgradeError = e;
          try { tx.abort(); } catch (_) { /* すでに終わっている場合は何もしない */ }
        }
      };

      request.onblocked = () => {
        // 古い接続が残っていて移行できない。相手が閉じれば自動で続きが進むので、ここでは失敗にしない
        if (handlers.onBlocked) handlers.onBlocked();
      };

      request.onsuccess = () => {
        const db = request.result;
        // 他の画面で新しい版の DB を開こうとしたら、こちらは素直に閉じて道を譲る（architecture 6.11）。
        // 閉じないと、相手側のバージョンアップがいつまでも進まない
        db.onversionchange = () => {
          db.close();
          if (dbPromise === p) dbPromise = null;
          if (handlers.onVersionChange) handlers.onVersionChange();
        };
        // ブラウザ側の都合で接続が切られた場合は、次の呼び出しで開き直す
        db.onclose = () => {
          if (dbPromise === p) dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (upgradeError) {
          reject(new AppError('DB_OPEN', MESSAGES.DB_OPEN, { cause: upgradeError }));
        } else {
          reject(toAppError(request.error, 'DB_OPEN'));
        }
      };
    });

    dbPromise = p;
    // 開けなかったときは覚えておかず、次に呼ばれたときにもう一度開くのを試す
    p.catch(() => {
      if (dbPromise === p) dbPromise = null;
    });
    return p;
  }

  /** 接続を閉じる（主にテストの後片付け用。閉じた後に読み書きすると自動で開き直す） */
  async function closeDb() {
    const p = dbPromise;
    dbPromise = null;
    if (!p) return;
    try {
      (await p).close();
    } catch (_) {
      // 開けていなかった場合は閉じるものがない
    }
  }

  /**
   * DB をまるごと削除する。**テストの後片付け専用**（本物のデータを消す事故を防ぐため、
   * アプリ本体向けの関数（このファイルの最後の export）には含めていない）。
   */
  async function deleteDatabase() {
    // 二重の安全策：テスト用に作った窓口でも、名前が本物と同じなら絶対に消さない
    if (name === DB_NAME) {
      throw new Error(`本物の DB「${DB_NAME}」は deleteDatabase() で削除できません（テスト専用の関数です）`);
    }
    await closeDb();
    if (!factory) return;
    await new Promise((resolve, reject) => {
      const req = factory.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(toAppError(req.error, 'DB_WRITE'));
      // 他の接続が残っていて待たされている場合も、閉じられれば success になる
    });
  }

  /**
   * トランザクション内で使う読み書きの道具を作る。
   * 呼び出し側（runTx の fn）が IndexedDB の生の仕組みに触れずに済むようにするため。
   * どれも Promise を返す。get で見つからないときは null。
   */
  function makeOps(tx) {
    return {
      get: (store, key) => promisify(tx.objectStore(store).get(key)),
      getAll: (store, query) => promisify(tx.objectStore(store).getAll(query)),
      getAllByIndex: (store, index, query) => promisify(tx.objectStore(store).index(index).getAll(query)),
      add: (store, value) => promisify(tx.objectStore(store).add(value)),
      put: (store, value) => promisify(tx.objectStore(store).put(value)),
      delete: (store, key) => promisify(tx.objectStore(store).delete(key)),
      /**
       * ストアの全件を1件ずつ fn に渡す（カーソル）。getAll と違い、全件を一度にメモリへ持たない。
       * 画像のように 1 件が大きいストアを、中身（Blob）を持ち続けずに調べるときに使う（孤立画像の掃除：T-24）。
       * fn が受け取った値は、この呼び出しの間だけ使う（必要な項目だけコピーして取っておく）。
       */
      eachRecord: (store, fn) => new Promise((resolve, reject) => {
        const request = tx.objectStore(store).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          try {
            fn(cursor.value);
          } catch (e) {
            reject(e);
            return;
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      }),
    };
  }

  /**
   * 1つのトランザクションの中で fn を実行し、トランザクションが確定（complete）してから fn の戻り値を返す。
   * fn の途中で失敗したら、トランザクション全体を取り消す（中途半端なデータを残さない）。
   *
   * 【fn を書くときの注意】fn の中で await してよいのは ops の読み書きだけ。
   * fetch や setTimeout など IndexedDB 以外のものを待つと、その間にトランザクションが自動で終わってしまい、
   * 続きの読み書きが失敗する（IndexedDB の仕組み上の決まり）。
   *
   * @param {string[]} storeNames 使うストア
   * @param {'readonly'|'readwrite'} mode
   * @param {'DB_WRITE'|'DB_READ'} failCode 失敗したときの code（容量不足・二重保存は toAppError で判別）
   * @param {(ops: object) => any} fn
   */
  async function withTx(storeNames, mode, failCode, fn) {
    const db = await openDb(); // 開けなければ DB_OPEN / VERSION がそのまま呼び出し元に返る

    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(storeNames, mode);
      } catch (e) {
        // 存在しないストア名を指定した、接続が閉じられた直後など
        reject(toAppError(e, failCode));
        return;
      }

      let result;
      let fnError = null;
      const fail = (e) => {
        if (fnError) return; // 最初の原因を残す
        // IndexedDB 由来のエラーは AppError に変換。プログラムの書き間違い（TypeError など）はそのまま返し、
        // 想定外のエラーとして開発者が気づけるようにする
        fnError = e instanceof AppError || !isDomError(e) ? e : toAppError(e, failCode);
        try { tx.abort(); } catch (_) { /* すでに中断・確定している */ }
      };

      tx.oncomplete = () => {
        if (fnError) reject(fnError);
        else resolve(result);
      };
      tx.onabort = () => {
        // 書き込み要求の失敗（容量不足・同じキー等）で中断した場合は tx.error に原因が入る。
        // iOS Safari は原因なし（null）で中断することがあるので、そのときは failCode（容量不足の可能性も案内）
        reject(fnError || toAppError(tx.error, failCode));
      };

      let ret;
      try {
        ret = fn(makeOps(tx));
      } catch (e) {
        fail(e);
        return;
      }
      Promise.resolve(ret).then((v) => { result = v; }, fail);
    });
  }

  /** 書き込み（readwrite）のトランザクション。失敗は DB_WRITE / QUOTA / DUPLICATE */
  const write = (stores, fn) => withTx(stores, 'readwrite', 'DB_WRITE', fn);
  /** 読み込み（readonly）のトランザクション。失敗は DB_READ */
  const read = (stores, fn) => withTx(stores, 'readonly', 'DB_READ', fn);

  return {
    openDb,
    closeDb,
    deleteDatabase,

    /**
     * 受け取り手を登録する（app.js がお知らせ行を出すため。architecture 6.11）。
     * @param {{onBlocked?: Function, onVersionChange?: Function}} h
     */
    setHandlers(h) {
      if ('onBlocked' in h) handlers.onBlocked = h.onBlocked;
      if ('onVersionChange' in h) handlers.onVersionChange = h.onVersionChange;
    },

    /* ---- trades（トレード記録） ---- */

    /** 新規追加。同じ id がすでにあれば DUPLICATE（＝二重保存を防ぐ。architecture 6.10・8章） */
    addTrade: (trade) => write([STORE.TRADES], (ops) => ops.add(STORE.TRADES, trade)).then(() => trade),
    /** 上書き保存（更新）。失敗は DB_WRITE / QUOTA */
    putTrade: (trade) => write([STORE.TRADES], (ops) => ops.put(STORE.TRADES, trade)).then(() => trade),
    /** 1件取得。見つからなければ null */
    getTrade: (id) => read([STORE.TRADES], (ops) => ops.get(STORE.TRADES, id)),
    /** 全件取得（論理削除したものも含む。絞り込み・並べ替えは呼び出し側：architecture 6.3） */
    getAllTrades: () => read([STORE.TRADES], (ops) => ops.getAll(STORE.TRADES)),
    /**
     * インデックスで取得（Phase 2 の未送信キュー：getTradesByIndex('syncStatus', 'pending')）。
     * @param {string} index インデックス名（INDEX.TRADES_SYNC_STATUS）
     * @param {IDBValidKey|IDBKeyRange} [range] 値または範囲。省略で全件
     */
    getTradesByIndex: (index, range) => read([STORE.TRADES], (ops) => ops.getAllByIndex(STORE.TRADES, index, range)),

    /* ---- images（画像） ---- */

    /** 画像の追加。同じ id があれば DUPLICATE */
    addImage: (image) => write([STORE.IMAGES], (ops) => ops.add(STORE.IMAGES, image)).then(() => image),
    /** 1枚取得。見つからなければ null */
    getImage: (id) => read([STORE.IMAGES], (ops) => ops.get(STORE.IMAGES, id)),
    /** あるトレードの画像をまとめて取得（並び順はトレードの imageIds が正：architecture 6.4） */
    getImagesByTrade: (tradeId) => read([STORE.IMAGES], (ops) => ops.getAllByIndex(STORE.IMAGES, INDEX.IMAGES_TRADE_ID, tradeId)),
    /** 画像をまとめて物理削除（1つのトランザクション。存在しない id は無視される） */
    deleteImages: (ids) => {
      // 文字列1つを渡す書き間違いをすると、1文字ずつ別の ID として扱われてしまうため、配列以外は受け付けない
      if (!Array.isArray(ids)) return Promise.reject(new TypeError('deleteImages(ids)：ids は ID の配列で渡してください'));
      return write([STORE.IMAGES], async (ops) => {
        for (const id of ids) await ops.delete(STORE.IMAGES, id);
      });
    },

    /* ---- drafts（下書き） ---- */

    /** 1件取得。見つからなければ null */
    getDraft: (key) => read([STORE.DRAFTS], (ops) => ops.get(STORE.DRAFTS, key)),
    /** 保存（同じ key は上書き。同じ画面の下書きは常に1つ：architecture 6.5） */
    putDraft: (draft) => write([STORE.DRAFTS], (ops) => ops.put(STORE.DRAFTS, draft)).then(() => draft),
    /** 削除（ない key は何もしない） */
    deleteDraft: (key) => write([STORE.DRAFTS], (ops) => ops.delete(STORE.DRAFTS, key)),
    /** 全件取得（起動時に「入力途中のものがあるか」を調べる：architecture 9.3） */
    getAllDrafts: () => read([STORE.DRAFTS], (ops) => ops.getAll(STORE.DRAFTS)),

    /**
     * 複数のストアを1つのトランザクションでまとめて書く（例：記録の保存＋下書きの削除。architecture 6.10・8章）。
     * fn(ops) の ops：get / getAll / getAllByIndex / add / put / delete / eachRecord（どれも Promise）。
     * 全部成功したら fn の戻り値を返し、1つでも失敗したら全部を取り消して AppError を返す。
     * @param {string[]} storeNames
     * @param {(ops: object) => any} fn
     */
    runTx: (storeNames, fn) => write(storeNames, fn),
  };
}

/* ---------------------------------------------------------
   アプリ本体が使う窓口（本物の DB「fx-trade-note」）
   --------------------------------------------------------- */
// deleteDatabase（DB の丸ごと削除）は、本物の記録を消す事故を防ぐため appDb から外しておく
// （テストは createDb() で作った別名の DB に対してだけ使う）。
const { deleteDatabase: _neverExposeDelete, ...appDbApi } = createDb({
  name: DB_NAME, version: DB_VERSION, migrations: MIGRATIONS,
});
export const appDb = Object.freeze(appDbApi);

// 関数として直接 import できるようにも出しておく（architecture 6.10 の関数名）。
export const {
  openDb, closeDb, setHandlers,
  addTrade, putTrade, getTrade, getAllTrades, getTradesByIndex,
  addImage, getImage, getImagesByTrade, deleteImages,
  getDraft, putDraft, deleteDraft, getAllDrafts,
  runTx,
} = appDb;
