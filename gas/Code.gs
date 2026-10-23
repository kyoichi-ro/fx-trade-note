/* =========================================================
   gas/Code.gs
   FXトレード記録PWA → Google スプレッドシート の書き込み窓口（Google Apps Script）。T-38 で作成。
   決めごとの元：docs/sheets-setup.md（4〜6章：列・書式・追加/上書きのルール、10.2：この窓口で守ること、
   11章：このコードの説明〔要求と応答の形・エラーコード・合言葉の決まり・自己テスト〕）。

   【このファイルについて】
   ・このファイルは GitHub の公開リポジトリに置かれ、誰でも読めます。だから秘密の情報は1つも書きません。
     - 合言葉は「スクリプト プロパティ」（Apps Script の中にだけある保存場所）の SYNC_TOKEN に置きます。
       メニュー「FXトレード記録 → 合言葉を設定する」で入れます（docs/sheets-setup.md 12章）。
     - Apps Script の URL（公開すると発行されるアドレス）もここには書きません。アプリの設定画面に入れます。
   ・使い方：スプレッドシートの「拡張機能 → Apps Script」を開き、最初からある Code.gs の中身を
     このファイルの中身で置き換えて保存 → ウェブアプリとして公開します（手順は 12章）。
     アプリ（PWA）のオフライン用キャッシュには入れません（ブラウザで動かすものではないため）。

   【このファイルがすること】
   ・doPost：アプリから届いた要求（接続テスト ping／記録の書き込み upsert）を受け、合言葉を照合し、
     タブ「trades」の行を id で「追加 または 上書き」する。応答はいつも JSON（11.4）。
   ・メニュー：シートの準備・合言葉の設定・設定の確認・書き込みの自己テスト（テスト用のタブで 5.5 を確かめる）。

   【守っていること（sheets-setup 10.2）】
   ・合言葉はコード・シート・ログに残さない。比べるときは SHA-256 の要約どうしを全部の桁で比べる（早く打ち切らない）。
   ・書き込む前に毎回、1行目の A〜AF が決まった32の見出しと同じか確かめる。違えば何も書かない。
   ・ロック（同時に1つの処理しか書けない仕組み）をかけてから書く。
   ・1行ごとに「表示形式 → 値」の順で書く。A〜AF 以外の列には書かない。
   ・日時は自分で作らない・日付の値として扱わない（いつも文字）。
   ・CSV インジェクション対策：アプリは危ない文字で始まる文字に「'」を付けて送る。付いていないもの
     （= + - @ タブ CR で始まる文字）は、アプリ以外からの送信かアプリの誤りとみなして受け付けない。

   動かす環境：Apps Script の V8 ランタイム（既定）。モジュール（import/export）は使えないので使わない。
   ========================================================= */

/* ---------------------------------------------------------
   決まった値（変えるとアプリと話が通じなくなるものには印 ★）
   --------------------------------------------------------- */

/** ★アプリと Apps Script の両方が名乗る名前。応答にこれがあれば「このアプリ用の Apps Script」と分かる */
const APP_ID = 'fx-trade-note';
/** ★要求と応答の形の版。形を変えるときだけ上げる（アプリ側も同時に直す） */
const PROTOCOL_VERSION = 1;
/** このコードの版（応答と「設定を確認する」に出す。コードを貼り直したかの目印） */
const SCRIPT_VERSION = '1.0.0';

/** ★同期用のタブの名前（sheets-setup 3章。変えない） */
const SHEET_NAME = 'trades';
/** 自己テスト（runSelfTest）が使うタブの名前。trades とは別にして、本物の記録に混ざらないようにする */
const SELFTEST_SHEET_NAME = 'selftest';

/** 合言葉を置くスクリプト プロパティの名前 */
const TOKEN_PROPERTY = 'SYNC_TOKEN';
/**
 * ★合言葉の決まり：12〜128文字、半角の英数字と記号（ASCII の 0x21〜0x7E）。空白・全角・改行は使えない。
 * 全角を使えなくするのは、iPhone とパソコンで同じに見えて中身の違う文字（全角/半角・濁点の付け方）が混ざり、
 * 「合っているのに違うと言われる」を避けるため。12文字の下限の理由は sheets-setup 11.6。
 */
const TOKEN_MIN_LENGTH = 12;
const TOKEN_MAX_LENGTH = 128;
const TOKEN_FORMAT = /^[\x21-\x7e]{12,128}$/;

/** 1回の要求で受け付ける記録の数の上限（Apps Script の実行時間の上限 6分に十分な余裕を持たせる） */
const MAX_RECORDS = 100;
/** 要求の本文の文字数の上限（100件 × 1件あたり数KB を十分に超える大きさ） */
const MAX_BODY_CHARS = 2000000;
/** 1つのセルに入れられる文字数（Google スプレッドシートの上限が 50,000 文字） */
const MAX_TEXT_CHARS = 50000;
/** ロックを待つ時間（ミリ秒）。待っても取れなければ BUSY を返す（アプリは後で送り直す） */
const LOCK_WAIT_MS = 10000;

/**
 * 書き込みの方式（sheets-setup 5.2・5.5）。
 * false（既定）：方式 A。セルの表示形式を先に「@（書式なしテキスト）」などにしてから、普通の書き込み（setValues）で書く。
 * true        ：方式 C。Google Sheets API の「そのまま書く（RAW）」指定で書く。自己テストで「'」が消えるなど
 *               5.5 の結果が期待どおりでなかったときだけ true にする。その場合は Apps Script の左側の
 *               「サービス ＋」から「Google Sheets API」を追加する（識別子は Sheets のまま）。
 */
const USE_SHEETS_API = false;

/** 削除済みの行（AD 列 deletedAt に値がある行）を灰色の文字にする条件付き書式（sheets-setup 3章） */
const DELETED_ROW_FORMULA = '=$AD2<>""';
const DELETED_ROW_COLOR = '#8e8e93';

/** 日時の固定形式（architecture 6.6。いつも25文字。文字のまま比べると時刻の順になる） */
const DATETIME_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/;
/** 記録の id（UUID。英小文字・数字・ハイフンの36文字） */
const ID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 印（'）なしでこれらの文字で始まる文字は、表計算ソフトが数式として動かしうる（architecture 14.2・sheets-setup 5.4） */
const UNGUARDED_FORMULA = /^[=+\-@\t\r]/;

/* ---------------------------------------------------------
   列（sheets-setup 4.1 の32列。js/csv.js の CSV_COLUMNS と同じ名前・同じ並び）
   --------------------------------------------------------- */

/**
 * ★32列の定義。[見出し, 種類, 日本語の説明（見出しのセルのメモ）]
 * 種類：'id'（UUID の文字）／'text'（文字）／'datetime'（固定形式の日時の文字か空）／
 *       'price'（価格。表示形式は行ごとに 0.000 か 0.00000）／それ以外は数値の表示形式そのもの。
 * 並び・名前を変えるときは、js/csv.js・docs/sheets-setup.md 4.1・T-44 の読み込みを一緒に直す（4.2 のルール）。
 */
const COLUMN_DEFS = [
  ['id', 'id', 'ID（記録ごとの番号。この列で行を探します）'],
  ['accountType', 'text', 'デモ/本番（demo＝デモ、real＝本番）'],
  ['pair', 'text', '通貨ペア'],
  ['side', 'text', '売買方向（buy＝買い、sell＝売り）'],
  ['entryPrice', 'price', 'エントリー価格'],
  ['entryAt', 'datetime', 'エントリー日時'],
  ['lots', '0.00', 'ロット'],
  ['lotUnitSize', '0', '1lotの通貨数'],
  ['slPrice', 'price', '損切りライン（SL）'],
  ['tpPrice', 'price', '利確ライン（TP）'],
  ['riskReward', '0.00', 'リスクリワード'],
  ['exitPrice', 'price', '決済価格'],
  ['exitAt', 'datetime', '決済日時'],
  ['pips', '0.0', 'pips'],
  ['profitJpy', '0', '損益（円）'],
  ['profitSource', 'text', '損益の算出方法（auto＝自動計算、manual＝手入力）'],
  ['quoteToJpyRate', '0.000', '円換算レート'],
  ['status', 'text', 'ステータス（open＝保有中、closed＝決済済み）'],
  ['entryReasons', 'text', 'エントリー根拠（複数あるときは | で区切り）'],
  ['timeframe', 'text', '時間足'],
  ['session', 'text', 'セッション（tokyo＝東京、london＝ロンドン、newyork＝ニューヨーク、other＝その他）'],
  ['emotion', 'text', 'エントリー時の感情'],
  ['exitReason', 'text', '決済理由（tp＝TP到達、sl＝SL到達、manual＝裁量決済、breakeven＝建値決済、other＝その他）'],
  ['exitEmotion', 'text', '決済時の感情'],
  ['tags', 'text', 'タグ（複数あるときは | で区切り）'],
  ['memo', 'text', 'メモ'],
  ['imageCount', '0', '画像の枚数（画像そのものはシートに送りません）'],
  ['syncStatus', 'text', '同期状態（シートではいつも synced）'],
  ['syncedAt', 'datetime', '最終同期日時（この行を送った日時）'],
  ['deletedAt', 'datetime', '削除日時（値がある行はアプリで削除済み）'],
  ['createdAt', 'datetime', '作成日時'],
  ['updatedAt', 'datetime', '更新日時（新しいか古いかの判定に使います）'],
];

const COLUMNS = COLUMN_DEFS.map(function (d) {
  const kind = d[1];
  const isText = kind === 'id' || kind === 'text' || kind === 'datetime';
  return { name: d[0], kind: kind, isText: isText, note: d[2] };
});
const COLUMN_COUNT = COLUMNS.length; // 32（A〜AF）
const COLUMN_NAMES = COLUMNS.map(function (c) { return c.name; });

/* ---------------------------------------------------------
   エラーコード（sheets-setup 11.5）。message は開発者ツールで見るための短い説明で、アプリはコードで文を出し分ける
   --------------------------------------------------------- */

const ERROR_MESSAGES = {
  BAD_REQUEST: '要求の形が違います（このアプリからの送信ではないか、アプリの誤り）。',
  TOO_LARGE: '1回に送る量が多すぎます（記録は1回に100件まで）。',
  UNSUPPORTED_VERSION: 'アプリと Apps Script のコードの版が合いません。',
  TOKEN_NOT_SET: 'Apps Script に合言葉が設定されていないか、決まりに合っていません。',
  BAD_TOKEN: '合言葉が違います。',
  NO_SPREADSHEET: 'この Apps Script はスプレッドシートに付いていません（スプレッドシートの「拡張機能 → Apps Script」から作ってください）。',
  HEADER_MISMATCH: 'タブ「trades」の1行目の見出しが決まりと違います。何も書いていません。',
  BUSY: 'ほかの書き込みが終わらず待ちきれませんでした。時間をおいて送り直してください。',
  INTERNAL: 'Apps Script の中で想定外のエラーが起きました（Apps Script の「実行数」で内容を確認できます）。',
  USE_POST: 'このURLはFXトレード記録アプリからの送信専用です（ブラウザで開いてこの表示が出れば、公開はできています）。',
};

/* =========================================================
   1. ウェブアプリの入口
   ========================================================= */

/**
 * アプリからの送信（POST）を受ける。アプリは本文を JSON の文字にして Content-Type: text/plain で送る
 * （application/json で送るとブラウザが事前の確認〔CORS のプリフライト〕を送り、Apps Script はそれに答えられないため）。
 * 応答はいつも HTTP 200 の JSON（Apps Script は状態コードを変えられないので、成否は本文の ok と error.code で返す）。
 * @param {Object} e Apps Script が渡すイベント（e.postData.contents が本文）
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function doPost(e) {
  let action = null;
  try {
    const body = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
    if (body === '') return fail_(null, 'BAD_REQUEST');
    if (body.length > MAX_BODY_CHARS) return fail_(null, 'TOO_LARGE');

    let req;
    try {
      req = JSON.parse(body);
    } catch (parseError) {
      return fail_(null, 'BAD_REQUEST');
    }
    if (!isPlainObject_(req) || req.app !== APP_ID) return fail_(null, 'BAD_REQUEST');
    if (req.v !== PROTOCOL_VERSION) return fail_(null, 'UNSUPPORTED_VERSION');

    // 合言葉の照合。ここを通るまでは、シートの状態などの情報を何も返さない
    const stored = getStoredToken_();
    if (stored === null) return fail_(null, 'TOKEN_NOT_SET');
    if (!tokensEqual_(req.token, stored)) return fail_(null, 'BAD_TOKEN');

    if (req.action === 'ping') {
      action = 'ping';
      return handlePing_();
    }
    if (req.action === 'upsert') {
      action = 'upsert';
      return handleUpsert_(req.records);
    }
    return fail_(null, 'BAD_REQUEST');
  } catch (err) {
    // 要求の本文（合言葉を含む）はログに出さない。エラーの文だけ
    console.error('doPost で想定外のエラー: ' + errorText_(err));
    return fail_(action, 'INTERNAL');
  }
}

/**
 * ブラウザで URL を開いたとき（GET）。何も読み書きせず、「このアプリ用の窓口で、公開できている」ことだけ分かる応答を返す。
 * 手順書（12章）で「公開できたかの確認」に使う。
 */
function doGet() {
  return fail_(null, 'USE_POST');
}

/* =========================================================
   2. 接続テスト（ping）と書き込み（upsert）
   ========================================================= */

/**
 * 接続テスト。**シートには何も書かない**（タブが無くても作らない。design 14.6.8・14.6.12）。
 * 合言葉が合っていることは doPost で確かめ済み。ここではシートの状態だけを見る。
 */
function handlePing_() {
  const ss = getSpreadsheet_();
  if (!ss) return fail_('ping', 'NO_SPREADSHEET');
  const st = inspectSheet_(ss, SHEET_NAME);
  if (st.state === 'mismatch') return fail_('ping', 'HEADER_MISMATCH', st.mismatch);
  // state：'ready'（準備済み）／'missing'（タブがまだ無い）／'empty'（タブが空）。missing・empty は最初の書き込みで準備する
  return ok_('ping', { sheet: { name: SHEET_NAME, state: st.state } });
}

/**
 * 記録の書き込み。records の1件ずつを id で「追加 または 上書き」する（sheets-setup 6.1）。
 * @param {Array} records [{ values: {32の見出し → 値}, priceDecimals: 3|5 }, …]
 */
function handleUpsert_(records) {
  if (!Array.isArray(records)) return fail_('upsert', 'BAD_REQUEST');
  if (records.length > MAX_RECORDS) return fail_('upsert', 'TOO_LARGE');
  const ss = getSpreadsheet_();
  if (!ss) return fail_('upsert', 'NO_SPREADSHEET');
  if (records.length === 0) return ok_('upsert', { results: [], counts: countResults_([]) });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return fail_('upsert', 'BUSY');
  try {
    const st = prepareSheet_(ss, SHEET_NAME);
    if (st.state === 'mismatch') return fail_('upsert', 'HEADER_MISMATCH', st.mismatch);
    const results = upsertRecords_(st.sheet, records);
    SpreadsheetApp.flush(); // ロックを外す前に書き込みを確定させる
    return ok_('upsert', { results: results, counts: countResults_(results) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 行を探して追加・上書き・書かないを決め、書く（ロックの中で呼ぶ）。
 * ・行は毎回 A 列から id で探す（行番号を覚えない。オーナーが並べ替えても正しい行に書ける）
 * ・同じ id の行が2つ以上あるときは上の行を使い、ほかは触らない（結果に duplicate: true）
 * ・届いた updatedAt がシートの行の updatedAt より古いときだけ書かない（等しいときは上書き：6.1）
 * ・results[i] は records[i] に対応する（同じ順・同じ数）
 * @returns {Array<{id: (string|null), result: string, reason?: string, column?: string, duplicate?: boolean}>}
 */
function upsertRecords_(sheet, records) {
  const lastRow = sheet.getLastRow(); // 見出しがあるので 1 以上
  const index = Object.create(null); // id → { row, updatedAt }
  const duplicated = Object.create(null);
  if (lastRow >= 2) {
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    const updated = sheet.getRange(2, COLUMN_COUNT, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i += 1) {
      const id = String(ids[i][0]);
      if (id === '') continue;
      if (index[id]) {
        duplicated[id] = true;
        continue;
      }
      index[id] = { row: i + 2, updatedAt: String(updated[i][0]) };
    }
  }

  let nextRow = lastRow + 1; // 新しい行はいつも、何か書かれている最後の行のすぐ下（どの列にも中身のない行）
  const results = [];
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    const problem = validateRecord_(rec);
    if (problem) {
      const rejected = { id: echoId_(rec), result: 'rejected', reason: problem.reason };
      if (problem.column) rejected.column = problem.column;
      results.push(rejected);
      continue;
    }
    const v = rec.values;
    const values = COLUMNS.map(function (c) { return v[c.name] === null ? '' : v[c.name]; });
    const formats = rowFormats_(priceDecimalsOf_(rec));
    const found = index[v.id];
    let result;
    if (!found) {
      ensureRows_(sheet, nextRow);
      writeRow_(sheet, nextRow, values, formats);
      index[v.id] = { row: nextRow, updatedAt: v.updatedAt };
      nextRow += 1;
      result = 'added';
    } else if (isOlder_(v.updatedAt, found.updatedAt)) {
      result = 'stale'; // シートの方が新しい。書かない（アプリは送り直さない：10.3）
    } else {
      writeRow_(sheet, found.row, values, formats);
      found.updatedAt = v.updatedAt;
      result = 'updated';
    }
    const r = { id: v.id, result: result };
    if (duplicated[v.id]) r.duplicate = true;
    results.push(r);
  }
  return results;
}

/**
 * 届いた updatedAt がシートの行の値より古いか。シートの値が固定形式でない（手で書き換えられたなど）ときは
 * 「古くない」とみなして上書きする（端末の記録が正：一方向の控え）。
 */
function isOlder_(incoming, existing) {
  if (!DATETIME_FORMAT.test(existing)) return false;
  return incoming < existing;
}

/**
 * 1件の記録の形を確かめる（sheets-setup 10.2 #3）。問題がなければ null、あれば最初に見つかった問題。
 * 見る順：記録の形 → 32の見出しがそろっているか → 余分な見出し → 列の順に値。
 * @returns {null|{reason: string, column?: string}}
 */
function validateRecord_(rec) {
  if (!isPlainObject_(rec) || !isPlainObject_(rec.values)) return { reason: 'BAD_RECORD' };
  const v = rec.values;
  for (let i = 0; i < COLUMN_COUNT; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(v, COLUMNS[i].name)) return { reason: 'MISSING_COLUMN', column: COLUMNS[i].name };
  }
  const keys = Object.keys(v);
  for (let i = 0; i < keys.length; i += 1) {
    if (COLUMN_NAMES.indexOf(keys[i]) < 0) return { reason: 'UNKNOWN_COLUMN', column: String(keys[i]).slice(0, 64) };
  }
  for (let i = 0; i < COLUMN_COUNT; i += 1) {
    const c = COLUMNS[i];
    const x = v[c.name];
    if (c.isText) {
      if (typeof x !== 'string') return { reason: 'BAD_TEXT', column: c.name };
      if (x.length > MAX_TEXT_CHARS) return { reason: 'TOO_LONG', column: c.name };
      if (UNGUARDED_FORMULA.test(x)) return { reason: 'FORMULA', column: c.name };
      if (c.kind === 'id' && !ID_FORMAT.test(x)) return { reason: 'BAD_ID', column: c.name };
      if (c.kind === 'datetime' && x !== '' && !DATETIME_FORMAT.test(x)) return { reason: 'BAD_DATETIME', column: c.name };
      if (c.name === 'updatedAt' && x === '') return { reason: 'BAD_DATETIME', column: c.name };
    } else if (x !== null && !(typeof x === 'number' && isFinite(x))) {
      return { reason: 'BAD_NUMBER', column: c.name };
    }
  }
  return null;
}

/** 受け付けなかった記録の結果に添える id（文字ならそのまま、長すぎる・文字でないときは切る／null） */
function echoId_(rec) {
  if (isPlainObject_(rec) && isPlainObject_(rec.values) && typeof rec.values.id === 'string') return rec.values.id.slice(0, 64);
  return null;
}

/** 価格の小数桁（3 か 5）。アプリが添えた値を使い、無い・おかしいときは「/JPY で終われば 3、それ以外は 5」（sheets-setup 4.3） */
function priceDecimalsOf_(rec) {
  if (rec.priceDecimals === 3 || rec.priceDecimals === 5) return rec.priceDecimals;
  return /\/JPY$/.test(String(rec.values.pair)) ? 3 : 5;
}

/** その行の A〜AF の表示形式（sheets-setup 5.3） */
function rowFormats_(priceDecimals) {
  const price = priceDecimals === 3 ? '0.000' : '0.00000';
  return COLUMNS.map(function (c) {
    if (c.isText) return '@';
    if (c.kind === 'price') return price;
    return c.kind;
  });
}

/** 結果の件数をまとめる */
function countResults_(results) {
  const counts = { added: 0, updated: 0, stale: 0, rejected: 0 };
  results.forEach(function (r) { counts[r.result] += 1; });
  return counts;
}

/* =========================================================
   3. シートの準備・見出しの確認・書き込み
   ========================================================= */

/** 結びついているスプレッドシート（無いときは null） */
function getSpreadsheet_() {
  try {
    return SpreadsheetApp.getActiveSpreadsheet() || null;
  } catch (err) {
    return null;
  }
}

/**
 * タブの状態を見るだけ（何も書かない。接続テストと「設定を確認する」で使う）。
 * @returns {{state: ('missing'|'empty'|'ready'|'mismatch'), sheet?: Object, mismatch?: Object}}
 */
function inspectSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) return { state: 'missing' };
  if (sheet.getLastRow() === 0) return { state: 'empty', sheet: sheet };
  const mismatch = checkHeader_(sheet);
  return mismatch ? { state: 'mismatch', sheet: sheet, mismatch: mismatch } : { state: 'ready', sheet: sheet };
}

/**
 * 書き込みの前の準備。タブが無ければ作り、空なら見出し・メモ・固定・条件付き書式を設定する（10.2 #1）。
 * 中身のあるタブは見出しを確かめるだけ（何も変えない）。
 */
function prepareSheet_(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    initSheet_(sheet);
    return { state: 'ready', sheet: sheet };
  }
  const mismatch = checkHeader_(sheet);
  return mismatch ? { state: 'mismatch', sheet: sheet, mismatch: mismatch } : { state: 'ready', sheet: sheet };
}

/**
 * 1行目の A〜AF が32の見出しと同じ並びか（10.2 #2）。同じなら null、違えば最初に違った列の情報。
 * 列が32より少ないタブ（列を消した）も「違う」とする。
 */
function checkHeader_(sheet) {
  const maxCols = sheet.getMaxColumns();
  const width = Math.min(maxCols, COLUMN_COUNT);
  const row = sheet.getRange(1, 1, 1, width).getValues()[0];
  for (let i = 0; i < COLUMN_COUNT; i += 1) {
    const actual = i < width ? String(row[i]) : '';
    if (actual !== COLUMNS[i].name) {
      return { column: columnLetter_(i + 1), expected: COLUMNS[i].name, actual: actual.slice(0, 50) };
    }
  }
  return null;
}

/** 空のタブに見出しなどを設定する（A〜AF の1行目と、A2:AF の条件付き書式だけ） */
function initSheet_(sheet) {
  if (sheet.getMaxColumns() < COLUMN_COUNT) sheet.insertColumnsAfter(sheet.getMaxColumns(), COLUMN_COUNT - sheet.getMaxColumns());
  if (sheet.getMaxRows() < 2) sheet.insertRowsAfter(sheet.getMaxRows(), 100);
  const header = sheet.getRange(1, 1, 1, COLUMN_COUNT);
  header.setNumberFormat('@'); // 見出しも文字として書く
  header.setValues([COLUMN_NAMES]);
  header.setNotes([COLUMNS.map(function (c) { return c.note; })]);
  header.setFontWeight('bold');
  sheet.setFrozenRows(1);
  applyDeletedRowStyle_(sheet);
}

/**
 * 削除済みの行を灰色の文字にする条件付き書式を、A2 から最後の行までに設定し直す。
 * 自分で付けた規則（同じ式のもの）だけを入れ替え、オーナーが足したほかの規則は残す。
 */
function applyDeletedRowStyle_(sheet) {
  const kept = sheet.getConditionalFormatRules().filter(function (r) { return !isDeletedRowRule_(r); });
  const rule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(DELETED_ROW_FORMULA)
    .setFontColor(DELETED_ROW_COLOR)
    .setRanges([sheet.getRange(2, 1, sheet.getMaxRows() - 1, COLUMN_COUNT)])
    .build();
  kept.push(rule);
  sheet.setConditionalFormatRules(kept);
}

function isDeletedRowRule_(rule) {
  const cond = rule.getBooleanCondition();
  if (!cond) return false;
  return cond.getCriteriaType() === SpreadsheetApp.BooleanCriteria.CUSTOM_FORMULA
    && String(cond.getCriteriaValues()[0]) === DELETED_ROW_FORMULA;
}

/** row 行目に書けるよう、足りなければ行を足す（足したら灰色の条件付き書式の範囲も広げる） */
function ensureRows_(sheet, row) {
  const maxRows = sheet.getMaxRows();
  if (row <= maxRows) return;
  sheet.insertRowsAfter(maxRows, row - maxRows + 100);
  applyDeletedRowStyle_(sheet);
}

/**
 * 1行を書く：先にその行の A〜AF の表示形式を設定し、そのあと値を書く（sheets-setup 5.3 の順）。
 * 触るのは A〜AF の1行だけ（AG 列より右は触らない）。
 */
function writeRow_(sheet, row, values, formats) {
  const range = sheet.getRange(row, 1, 1, COLUMN_COUNT);
  range.setNumberFormats([formats]);
  if (USE_SHEETS_API) {
    // 方式 C：表示形式を確定させてから、読み替えなし（RAW）で値を書く
    SpreadsheetApp.flush();
    const a1 = quoteSheetName_(sheet.getName()) + '!A' + row + ':' + columnLetter_(COLUMN_COUNT) + row;
    Sheets.Spreadsheets.Values.update({ values: [values] }, sheet.getParent().getId(), a1, { valueInputOption: 'RAW' });
  } else {
    range.setValues([values]);
  }
}

/* =========================================================
   4. 合言葉
   ========================================================= */

/** スクリプト プロパティの合言葉。無い・決まりに合わないときは null（その場合は誰の要求も通さない） */
function getStoredToken_() {
  const t = PropertiesService.getScriptProperties().getProperty(TOKEN_PROPERTY);
  return typeof t === 'string' && TOKEN_FORMAT.test(t) ? t : null;
}

/**
 * 合言葉が同じか。両方を SHA-256 の要約（いつも32バイト）にしてから、32バイト全部を比べ終えてから答える。
 * 「何文字目まで合っていたか」で答えの速さが変わらないようにするため（時間差から合言葉を推測されにくくする）。
 * @param {*} given 要求に入っていた合言葉（文字でないものは空として扱う）
 * @param {string} stored
 */
function tokensEqual_(given, stored) {
  const g = typeof given === 'string' && given.length <= 1024 ? given : '';
  const a = digest_(g);
  const b = digest_(stored);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i += 1) diff |= (a[i] ^ b[i]);
  return diff === 0;
}

function digest_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
}

/* =========================================================
   5. スプレッドシートのメニュー（オーナーが使う）
   ========================================================= */

/** スプレッドシートを開いたときにメニュー「FXトレード記録」を足す */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('FXトレード記録')
    .addItem('シートを準備する', 'setupSheet')
    .addItem('合言葉を設定する', 'setSyncToken')
    .addItem('設定を確認する', 'checkSetup')
    .addSeparator()
    .addItem('書き込みの自己テスト（テスト用のタブ）', 'runSelfTest')
    .addToUi();
}

/** タブ「trades」を作り、見出しなどを設定する（初めて実行したときに、Google の「承認」の画面が出る） */
function setupSheet() {
  const ss = getSpreadsheet_();
  if (!ss) {
    notify_('シートを準備する', ERROR_MESSAGES.NO_SPREADSHEET);
    return;
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    notify_('シートを準備する', ERROR_MESSAGES.BUSY);
    return;
  }
  try {
    const st = prepareSheet_(ss, SHEET_NAME);
    if (st.state === 'mismatch') {
      notify_('シートを準備する', mismatchText_(st.mismatch) + '\nタブ「trades」の1行目を直すか、タブの名前を変えて退避してから、もう一度実行してください。');
      return;
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  notify_('シートを準備する', 'タブ「trades」の準備ができています。');
}

/**
 * 合言葉を入力して、スクリプト プロパティに保存する。入力した合言葉は画面にもログにも出さない。
 * （スプレッドシートのメニューから実行する。Apps Script の画面から直接は入力の欄を出せない）
 */
function setSyncToken() {
  let ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (err) {
    console.log('合言葉の設定は、スプレッドシートのメニュー「FXトレード記録 → 合言葉を設定する」から行ってください。');
    return;
  }
  const res = ui.prompt(
    '合言葉を設定する',
    TOKEN_MIN_LENGTH + '〜' + TOKEN_MAX_LENGTH + '文字の、半角の英字・数字・記号で入力してください（空白・全角は使えません）。'
      + 'すでに設定してある合言葉は、この合言葉に置き換わります。',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const token = String(res.getResponseText()).trim(); // 貼り付けで混ざった前後の空白・改行は取り除く
  if (!TOKEN_FORMAT.test(token)) {
    ui.alert('合言葉を設定する', '決まりに合っていないため、保存していません。'
      + TOKEN_MIN_LENGTH + '〜' + TOKEN_MAX_LENGTH + '文字の、半角の英字・数字・記号で入力してください（空白・全角は使えません）。', ui.ButtonSet.OK);
    return;
  }
  PropertiesService.getScriptProperties().setProperty(TOKEN_PROPERTY, token);
  ui.alert('合言葉を設定する', '合言葉を保存しました。アプリの設定画面にも同じ合言葉を入力してください。', ui.ButtonSet.OK);
}

/** 今の設定（合言葉があるか・タブの状態・書き込みの方式・コードの版）を表示する。合言葉そのものは出さない */
function checkSetup() {
  const lines = [];
  const raw = PropertiesService.getScriptProperties().getProperty(TOKEN_PROPERTY);
  if (raw === null || raw === '') lines.push('合言葉：未設定（メニュー「合言葉を設定する」で設定してください）');
  else if (!TOKEN_FORMAT.test(raw)) lines.push('合言葉：決まりに合っていません（設定し直してください）');
  else lines.push('合言葉：設定済み');

  const ss = getSpreadsheet_();
  if (!ss) {
    lines.push('タブ：' + ERROR_MESSAGES.NO_SPREADSHEET);
  } else {
    const st = inspectSheet_(ss, SHEET_NAME);
    if (st.state === 'missing') lines.push('タブ「trades」：まだありません（「シートを準備する」か、最初の送信で作られます）');
    else if (st.state === 'empty') lines.push('タブ「trades」：空です（「シートを準備する」か、最初の送信で見出しが入ります）');
    else if (st.state === 'mismatch') lines.push('タブ「trades」：' + mismatchText_(st.mismatch));
    else lines.push('タブ「trades」：準備済み（記録の行 ' + Math.max(st.sheet.getLastRow() - 1, 0) + ' 行）');
  }

  if (USE_SHEETS_API) {
    lines.push('書き込みの方式：Sheets API（RAW）' + (typeof Sheets === 'undefined' ? '　※「サービス」に Google Sheets API が追加されていません' : ''));
  } else {
    lines.push('書き込みの方式：標準（表示形式を先に設定）');
  }
  lines.push('コードの版：' + SCRIPT_VERSION);
  notify_('設定を確認する', lines.join('\n'));
}

/* =========================================================
   6. 書き込みの自己テスト（sheets-setup 5.5・11.8）
   ========================================================= */

/**
 * テスト用のタブ「selftest」に、5.5 の12個の値を本物の書き込みの処理（upsertRecords_）で書き、
 * 読み戻して期待どおりかを表示する。続けて「上書き」「古い内容は書かない」「削除の印」「印のない = は受け付けない」も確かめる。
 * ・タブ「trades」には触らない。selftest は実行のたびに作り直す。確かめ終わったらタブごと消してよい
 * ・CSV の書き出しの確認（5.5 の右端の列）は、このタブを「ファイル → ダウンロード → カンマ区切り形式」で書き出して見る
 */
function runSelfTest() {
  const ss = getSpreadsheet_();
  if (!ss) {
    notify_('書き込みの自己テスト', ERROR_MESSAGES.NO_SPREADSHEET);
    return;
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    notify_('書き込みの自己テスト', ERROR_MESSAGES.BUSY);
    return;
  }
  const report = [];
  try {
    // 前回のテスト用のタブは作り直す（新しいタブを先に作ってから古い方を消す。タブが1つだけだと消せないため）
    const old = ss.getSheetByName(SELFTEST_SHEET_NAME);
    const sheet = ss.insertSheet(SELFTEST_SHEET_NAME + '-' + Utilities.getUuid().slice(0, 8));
    if (old) ss.deleteSheet(old);
    sheet.setName(SELFTEST_SHEET_NAME);
    initSheet_(sheet);
    selfTestRun_(sheet, report);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  const ng = report.filter(function (r) { return !r.ok; });
  const head = ng.length === 0
    ? 'すべて期待どおりでした（' + report.length + '項目）。'
    : report.length + '項目中 ' + ng.length + '項目が期待と違いました。docs/sheets-setup.md の 11.8（期待どおりでなかったとき）を見てください。';
  notify_('書き込みの自己テスト', head + '\n\n' + report.map(function (r) { return (r.ok ? 'OK ' : 'NG ') + r.label + (r.ok ? '' : '（実際：' + r.actual + '）'); }).join('\n'));
}

/** 自己テストの中身（テストのしやすさのため runSelfTest から分けてある） */
function selfTestRun_(sheet, report) {
  const check = function (label, ok, actual) { report.push({ label: label, ok: ok, actual: describe_(actual) }); };

  // 合言葉の照合が正しく動くか（設定されているときだけ。合言葉そのものは表示しない）
  const stored = getStoredToken_();
  if (stored !== null) {
    const changed = stored.slice(0, -1) + (stored.slice(-1) === 'a' ? 'b' : 'a');
    check('合言葉の照合（同じなら一致・1文字違い／長さ違いは不一致）',
      tokensEqual_(stored, stored) && !tokensEqual_(changed, stored) && !tokensEqual_(stored + 'x', stored) && !tokensEqual_(undefined, stored), '照合の結果が違う');
  }

  // ids[0]〜[7]：前半の8件（5.5 の値。後半で上書きしないので、CSV に書き出して確かめられる）
  // ids[8]：上書き・古い内容の確認用／ids[9]：削除の印の確認用／ids[10]：受け付けない値の確認用
  const ids = [];
  for (let i = 0; i < 11; i += 1) ids.push(Utilities.getUuid().toLowerCase());
  const memos = ['001', '1e3', 'TRUE', '50%', "'=1+1", "''=x", "'普通", 'カンマ,と"引用符"と\n改行'];
  const records = memos.map(function (memo, i) {
    const usd = i !== 1; // 2件目だけ EUR/USD（価格の桁 5）
    return selfTestRecord_(ids[i], {
      pair: usd ? 'USD/JPY' : 'EUR/USD',
      entryPrice: usd ? 150.1 : 1.0851,
      memo: memo,
      tags: i === 0 ? '3/4' : '',
      profitJpy: i === 0 ? -1885 : (i === 1 ? 0 : null),
      pips: i === 0 ? -37.7 : null,
    });
  });
  const first = upsertRecords_(sheet, records);
  check('8件を追加した', first.every(function (r) { return r.result === 'added'; }), JSON.stringify(first));

  const vals = sheet.getRange(2, 1, 8, COLUMN_COUNT).getValues();
  const disp = sheet.getRange(2, 1, 8, COLUMN_COUNT).getDisplayValues();
  const col = function (name) { return COLUMN_NAMES.indexOf(name); };
  const same = function (r, name, expected) { return vals[r][col(name)] === expected; };
  check('#1 日時の文字（entryAt）がそのまま', same(0, 'entryAt', '2026-10-15T21:30:12+09:00'), vals[0][col('entryAt')]);
  check('#2 3/4（tags）がそのまま', same(0, 'tags', '3/4'), vals[0][col('tags')]);
  check('#3 001・1e3・TRUE・50%（memo）がそのまま', same(0, 'memo', '001') && same(1, 'memo', '1e3') && same(2, 'memo', 'TRUE') && same(3, 'memo', '50%'),
    [vals[0][col('memo')], vals[1][col('memo')], vals[2][col('memo')], vals[3][col('memo')]]);
  check("#4 '=1+1 の ' が残る", same(4, 'memo', "'=1+1"), vals[4][col('memo')]);
  check("#5 ''=x がそのまま", same(5, 'memo', "''=x"), vals[5][col('memo')]);
  check("#6 '普通 の ' が残る", same(6, 'memo', "'普通"), vals[6][col('memo')]);
  check('#7 改行・カンマ・引用符を含むメモが1つのセルにそのまま', same(7, 'memo', memos[7]), vals[7][col('memo')]);
  check('#8 150.1（桁3）が数値で、見え方 150.100', vals[0][col('entryPrice')] === 150.1 && disp[0][col('entryPrice')] === '150.100',
    [vals[0][col('entryPrice')], disp[0][col('entryPrice')]]);
  check('#9 1.0851（桁5）の見え方 1.08510', disp[1][col('entryPrice')] === '1.08510', disp[1][col('entryPrice')]);
  check('#10 -1885・0・空（profitJpy）', vals[0][col('profitJpy')] === -1885 && disp[0][col('profitJpy')] === '-1885'
    && vals[1][col('profitJpy')] === 0 && disp[1][col('profitJpy')] === '0' && vals[2][col('profitJpy')] === '',
    [vals[0][col('profitJpy')], vals[1][col('profitJpy')], vals[2][col('profitJpy')]]);
  check('#11 -37.7（pips）', vals[0][col('pips')] === -37.7 && disp[0][col('pips')] === '-37.7', [vals[0][col('pips')], disp[0][col('pips')]]);
  check('#12 UUID（id）がそのまま', same(0, 'id', ids[0]), vals[0][col('id')]);

  // 上書き・古い内容・削除の印・受け付けない値。前半の8行（2〜9行目）は触らず、別の id の行（10・11行目）で確かめる
  const base = upsertRecords_(sheet, [selfTestRecord_(ids[8], { memo: '上書き前' }), selfTestRecord_(ids[9], {})]);
  const newer = selfTestRecord_(ids[8], { memo: '上書きした', updatedAt: '2026-10-16T09:05:01+09:00' });
  const older = selfTestRecord_(ids[8], { memo: '古い内容', updatedAt: '2026-10-16T09:04:59+09:00' });
  const deleted = selfTestRecord_(ids[9], { deletedAt: '2026-10-16T09:06:00+09:00', updatedAt: '2026-10-16T09:06:00+09:00' });
  const unguarded = selfTestRecord_(ids[10], { memo: '=1+1' });
  const second = upsertRecords_(sheet, [newer, older, deleted, unguarded]);
  const resultText = function (rs) { return rs.map(function (r) { return r.result + (r.reason ? ':' + r.reason : ''); }).join(','); };
  const results = resultText(base) + ' → ' + resultText(second);
  check('上書き・古いので書かない・削除の印・印のない = を受け付けない', results === 'added,added → updated,stale,updated,rejected:FORMULA', results);
  check('上書きしても行は増えない（見出し＋10行）', sheet.getLastRow() === 11, sheet.getLastRow());
  check('上書きした内容が残り、古い内容で戻らない', sheet.getRange(10, col('memo') + 1).getValue() === '上書きした', sheet.getRange(10, col('memo') + 1).getValue());
  check('削除日時（deletedAt）が入った', sheet.getRange(11, col('deletedAt') + 1).getValue() === '2026-10-16T09:06:00+09:00', sheet.getRange(11, col('deletedAt') + 1).getValue());
  // 前半の8行が後半の確認で変わっていないこと（CSV に書き出して 5.5 を確かめるための前提）
  const after = sheet.getRange(2, 1, 8, COLUMN_COUNT).getValues();
  const unchanged = after.every(function (row, r) { return row.every(function (x, c) { return x === vals[r][c]; }); });
  check('前半の8行（2〜9行目）は後半の確認で変わっていない', unchanged, unchanged ? '' : '前半の行が書き換わった');
}

/** 自己テスト用の記録（アプリが送るのと同じ形。値は桁の形を示すための例で、実際のレートではない） */
function selfTestRecord_(id, overrides) {
  const v = {
    id: id, accountType: 'demo', pair: 'USD/JPY', side: 'buy', entryPrice: 150.1, entryAt: '2026-10-15T21:30:12+09:00',
    lots: 1, lotUnitSize: 10000, slPrice: 149.8, tpPrice: 150.4, riskReward: 2, exitPrice: 150.25,
    exitAt: '2026-10-16T09:05:00+09:00', pips: 15, profitJpy: 1500, profitSource: 'auto', quoteToJpyRate: null,
    status: 'closed', entryReasons: 'ブレイクアウト', timeframe: 'M15', session: 'tokyo', emotion: '冷静',
    exitReason: 'manual', exitEmotion: '冷静', tags: '', memo: '', imageCount: 0, syncStatus: 'synced',
    syncedAt: '2026-10-16T09:05:03+09:00', deletedAt: '', createdAt: '2026-10-15T21:30:40+09:00',
    updatedAt: '2026-10-16T09:05:00+09:00',
  };
  Object.keys(overrides).forEach(function (k) { v[k] = overrides[k]; });
  return { values: v, priceDecimals: /\/JPY$/.test(v.pair) ? 3 : 5 };
}

/* =========================================================
   7. 小さな道具
   ========================================================= */

function ok_(action, extra) {
  return respond_(Object.assign(base_(action), { ok: true }, extra || {}));
}

function fail_(action, code, extra) {
  return respond_(Object.assign(base_(action), { ok: false, error: Object.assign({ code: code, message: ERROR_MESSAGES[code] }, extra || {}) }));
}

function base_(action) {
  return { app: APP_ID, v: PROTOCOL_VERSION, script: SCRIPT_VERSION, action: action };
}

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function isPlainObject_(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/** 列の番号 → 列の文字（1 → A、32 → AF） */
function columnLetter_(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function quoteSheetName_(name) {
  return "'" + String(name).replace(/'/g, "''") + "'";
}

function mismatchText_(m) {
  return '1行目の見出しが違います（' + m.column + '列：「' + m.expected + '」のはずが「' + m.actual + '」）。';
}

function errorText_(err) {
  return String(err && err.message ? err.message : err).slice(0, 300);
}

function describe_(x) {
  if (x instanceof Date) return '日付の値 ' + x;
  if (Array.isArray(x)) return x.map(describe_).join(' / ');
  return typeof x === 'string' ? '「' + x + '」' : String(x);
}

/** メニューから実行したときは画面に、Apps Script の画面から実行したときは「実行ログ」に出す（合言葉は渡さないこと） */
function notify_(title, message) {
  console.log(title + '\n' + message);
  try {
    SpreadsheetApp.getUi().alert(title, message, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (err) {
    // 画面を出せない場面（Apps Script の画面から実行したときなど）はログだけ
  }
}
