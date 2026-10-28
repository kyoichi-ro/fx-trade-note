/* =========================================================
   js/sync.js
   スプレッドシート同期（Phase 2）：Apps Script との通信の窓口（architecture.md 3.3・4.2、docs/sheets-setup.md 11章）。

   【T-40 で作った範囲】
   ・Apps Script の URL・合言葉の入力チェック（design 14.6.8 の U-1〜U-4・K-1〜K-4。合言葉の決まりは sheets-setup 11.6）
   ・接続テスト（ping）：保存済みの URL・合言葉で Apps Script に確認を送り、結果を T-OK・T-1〜T-6 に振り分ける
     （振り分けの順は sheets-setup 11.5「接続テストの結果の見分け方」）。シートには何も書かない
   【T-41 で足した範囲】
   ・送る直前の URL・合言葉の確認（readSyncConfig。T-40 レビュー SY-R02）：保存値が U-1〜U-4・K-1〜K-4 を通らなければ
     「未設定」と同じ扱いにして、何も送らない（手で書き換えられた値・同じ github.io のほかのページが書いた値に合言葉を送らない）。
     接続テスト・記録の送信のどちらも postToAppsScript を通り、そこで確かめる（送り方を1か所にそろえる）
   ・記録の送信（upsert）の要求の組み立て（buildUpsertRecords：値は js/csv.js の sheetRowValues）と応答の振り分け
     （classifyUpsertResponse・upsertToAppsScript。sheets-setup 11.3〜11.5）
   ・いつ・何を送るか（変更通知を受けて1つずつ送る・結果の書き戻し）は js/sync-sender.js
   【まだ作らないもの（担当タスク）】
   ・未送信の自動再送・「今すぐ同期」… T-42、同期状態の画面 … T-43

   【秘密の情報の扱い（design 14.6.8・14.6.12、sheets-setup 11.5・13.2）】
   ・URL と合言葉は、console・エラー文・画面の文のどこにも出さない（画面に出すのは設定の入力欄の中だけ）。
   ・要求の本文（合言葉が入る）と応答の本文は console に出さない。開発者ツールに出すのは「結果の種類」と
     Apps Script の error.code・error.reason（決まった英字のコード）、通信の失敗の種類（例外の name）だけ。
     例外の message は出さない（ブラウザによっては URL が入るため）。
   ・ただし、CORS で読めなかったとき（「全員」になっていない など）にブラウザ自身が開発者ツールに出す警告には
     URL が入ることがある。これはブラウザの動きで、アプリからは止められない。

   ・層は「業務処理」（architecture 4.3）。画面の部品・設定の保存（settings-store.js）は import しない
     （URL・合言葉は呼び出し側が渡す。テストでにせものの fetch を渡せるようにするため）。
   ========================================================= */
import { sheetRowValues } from './csv.js';
import { getPairSpec } from './master.js';

/* ---------------------------------------------------------
   Apps Script との約束（sheets-setup 11.3・11.4・11.6。gas/Code.gs の ★の値と同じにする）
   --------------------------------------------------------- */

/** アプリと Apps Script の両方が名乗る名前。応答にこれがあれば「このアプリ用の Apps Script の答え」（T-5 との区別） */
export const SYNC_APP_ID = 'fx-trade-note';

/** 要求と応答の形の版（gas/Code.gs の PROTOCOL_VERSION と同じ） */
export const SYNC_PROTOCOL_VERSION = 1;

/** 合言葉の長さ（sheets-setup 11.6。gas/Code.gs の TOKEN_MIN_LENGTH・TOKEN_MAX_LENGTH と同じ） */
export const TOKEN_MIN_LENGTH = 12;
export const TOKEN_MAX_LENGTH = 128;

/**
 * 合言葉の決まり：12〜128文字、半角の英字・数字・記号（ASCII の ! 〜 ~）。gas/Code.gs の TOKEN_FORMAT と一字一句同じ。
 * 下の checkSyncToken は、どこが違うかを文で伝えるために1つずつ確かめ、最後にこの式でもう一度確かめる。
 */
export const TOKEN_FORMAT = /^[\x21-\x7e]{12,128}$/;

/** 接続テストの時間切れの目安（design 14.6.8 の T-4：20秒） */
export const PING_TIMEOUT_MS = 20000;

/**
 * 記録の送信（upsert）の時間切れの目安：60秒。
 * 方式 C は1行ごとに Sheets API を1回呼ぶので、接続テストより時間がかかる（sheets-setup 11.7）。
 * 打ち切っても、Apps Script が書き終えていればシートには入っている。記録は pending のまま残り、後で送り直すと
 * 同じ行が上書きされる（updatedAt が等しいときは上書き：sheets-setup 6.1）ので、行は二重にならない。
 * iPhone で実際の応答時間を測って見直す（T-42・T-48）。
 */
export const UPSERT_TIMEOUT_MS = 60000;

/**
 * 1回の送信に入れる記録の数の上限（sheets-setup 13.2 ③：Apps Script の上限は100件。まずは20件から始め、iPhone で応答の時間を測って決める）。
 * CSV の取り込みのように多くの記録が一度に変わったときは、20件ずつ順に送る。
 */
export const SYNC_BATCH_SIZE = 20;

/** Apps Script のウェブアプリのホスト名（design 14.6.8 の U-2。CSP の connect-src もこのホストを許している） */
const APPS_SCRIPT_HOST = 'script.google.com';

/* ---------------------------------------------------------
   入力チェック（design 14.6.8。欄から離れたときに使う）
   上から順に確かめ、最初に当てはまったものだけを返す。空欄はエラーにしない（「未設定」として保存する）
   --------------------------------------------------------- */

/** 入力チェックのエラー文（design 14.6.8 の表。K-3・K-4 は sheets-setup 13.2 ② で足すよう求められた文） */
export const SYNC_INPUT_MESSAGES = Object.freeze({
  'U-1': 'https:// で始まるURLを貼り付けてください。',
  'U-2': 'Apps Scriptのウェブアプリのアドレス（script.google.com）を入力してください。',
  'U-3': 'テスト用のURL（末尾が /dev）です。「デプロイを管理」に表示される、末尾が /exec のURLを入力してください。',
  'U-4': '末尾が /exec のURLを入力してください。',
  'K-1': '合言葉に空白は使えません。',
  'K-3': '合言葉は半角の英字・数字・記号で入力してください。',
  'K-2': `合言葉は${TOKEN_MIN_LENGTH}文字以上で入力してください。`,
  'K-4': `合言葉は${TOKEN_MAX_LENGTH}文字以内で入力してください。`,
});

/**
 * 前後の空白・改行を取り除く（貼り付けで混ざるため：design 14.6.8）。trim は全角スペースも取り除く。
 * @param {*} text
 * @returns {string}
 */
export function normalizeSyncText(text) {
  return String(text ?? '').trim();
}

/** エラーの結果を作る */
const invalid = (code) => ({ ok: false, code, message: SYNC_INPUT_MESSAGES[code] });

/**
 * Apps Script の URL のチェック（U-1〜U-4）。
 * @param {*} text 入力欄の文字
 * @returns {{ ok: true, value: (string|null) } | { ok: false, code: string, message: string }}
 *   value：保存する値（前後の空白を除いた文字。空欄なら null＝未設定）
 */
export function checkGasUrl(text) {
  const value = normalizeSyncText(text);
  if (value === '') return { ok: true, value: null };

  // U-1：URL として読めない・https:// で始まらない。
  // 途中に空白・改行があるもの（貼り付けで2つの文が混ざった など）と、「名前@」の付いたもの（fetch が受け付けない）も読めない扱い
  let url;
  try {
    url = new URL(value);
  } catch (e) {
    return invalid('U-1');
  }
  if (!/^https:\/\//i.test(value) || /\s/.test(value) || url.username !== '' || url.password !== '') return invalid('U-1');

  // U-2：script.google.com 以外（アドレス欄からコピーした script.googleusercontent.com など）。
  // 番号（:8443 など）付きも別のアドレスとして扱う（CSP が許していないので送れない）
  if (url.hostname !== APPS_SCRIPT_HOST || url.port !== '') return invalid('U-2');

  // U-3：テスト用の URL（作った本人がログインしているときしか動かない）
  if (/\/dev\/?$/.test(url.pathname)) return invalid('U-3');

  // U-4：末尾が /exec でない（?・# の付いたもの、/exec/ も含む。「デプロイを管理」の URL は /exec で終わる）
  if (!url.pathname.endsWith('/exec') || url.search !== '' || url.hash !== '' || /[?#]/.test(value)) return invalid('U-4');

  return { ok: true, value };
}

/**
 * 合言葉のチェック（K-1 空白 → K-3 半角以外 → K-2 短い → K-4 長い。sheets-setup 11.6）。
 * 長さは文字の数ではなく、Apps Script と同じ「半角1文字＝1」で数える（K-3 を通った後なので length でよい）。
 * @param {*} text 入力欄の文字
 * @returns {{ ok: true, value: (string|null) } | { ok: false, code: string, message: string }}
 */
export function checkSyncToken(text) {
  const value = normalizeSyncText(text);
  if (value === '') return { ok: true, value: null };
  if (/\s/.test(value)) return invalid('K-1');
  if (!/^[\x21-\x7e]+$/.test(value)) return invalid('K-3');
  if (value.length < TOKEN_MIN_LENGTH) return invalid('K-2');
  if (value.length > TOKEN_MAX_LENGTH) return invalid('K-4');
  // ここまでで TOKEN_FORMAT と同じ条件のはず。式とずれたときに保存してしまわないための最後の守り
  if (!TOKEN_FORMAT.test(value)) return invalid('K-3');
  return { ok: true, value };
}

/**
 * 保存済みの URL・合言葉を、送る直前にもう一度入力チェックにかける（T-40 レビュー SY-R02）。
 * 両方が U-1〜U-4・K-1〜K-4 を通るときだけ、送ってよい値（前後の空白を除いた形）を返す。
 * どちらかが空・誤りなら null（＝未設定と同じ。何も送らない）。設定画面の「保存」を通らずに入った値
 * （手で書き換えた・今後のコードの誤り・同じ github.io のほかのページ：architecture 14.4）に合言葉を送らないため。
 * @param {*} url 保存済みの Apps Script の URL
 * @param {*} token 保存済みの合言葉
 * @returns {{ url: string, token: string } | null}
 */
export function readSyncConfig(url, token) {
  if (typeof url !== 'string' || typeof token !== 'string') return null;
  const u = checkGasUrl(url);
  const k = checkSyncToken(token);
  if (!u.ok || !k.ok || u.value === null || k.value === null) return null;
  return { url: u.value, token: k.value };
}

/* ---------------------------------------------------------
   Apps Script への送信（sheets-setup 11.3 の送り方）
   --------------------------------------------------------- */

/** 時間切れの目印（例外として投げ、catch で見分ける） */
const TIMEOUT = Symbol('timeout');

/** URL・合言葉が未設定・誤り（readSyncConfig が null）の目印。fetch を呼ぶ前に投げる */
const NOT_CONFIGURED = Symbol('notConfigured');

/**
 * Apps Script に要求を1つ送り、応答の本文（文字）を返す。接続テストも記録の送信もここを通る（送り方を1か所にそろえる）。
 * ・送る前に URL・合言葉を readSyncConfig で確かめ、通らなければ fetch を呼ばずに NOT_CONFIGURED を投げる（SY-R02）
 * ・本文は { app, v, token, ...payload }。合言葉はここで1回だけ本文に入れる
 * ・headers を付けない：本文が文字だと Content-Type: text/plain になり、CORS の事前の確認（プリフライト）が出ない。
 *   application/json にするとプリフライトが出て、Apps Script はそれに答えられず失敗する（sheets-setup 11.3）
 * ・redirect: 'follow'：Apps Script は応答を script.googleusercontent.com へ転送して返すため
 * ・credentials: 'omit'：Google のログイン情報（Cookie）を送らない（「全員」で公開した窓口にはログインなしで送る）
 * ・cache: 'no-store'：応答を端末に残さない
 * ・timeoutMs を過ぎたら通信を打ち切る（応答の本文の読み込みも含む）。打ち切ったら TIMEOUT を投げる
 * @param {{ url: string, token: string, payload: object, fetchImpl: Function, timeoutMs: number, signal?: AbortSignal }} opts
 *   payload … 本文の app・v・token 以外（{ action: 'ping' } など）
 * @returns {Promise<{ status: number, ok: boolean, text: string }>}
 */
async function postToAppsScript({ url, token, payload, fetchImpl, timeoutMs, signal }) {
  const config = readSyncConfig(url, token);
  if (!config) throw NOT_CONFIGURED;
  const body = { app: SYNC_APP_ID, v: SYNC_PROTOCOL_VERSION, token: config.token, ...payload };
  const controller = new AbortController();
  // 画面を離れたとき（呼び出し側の signal）も打ち切る
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  let timer = null;
  // fetch が signal を無視する実装でも必ず時間で終わるよう、時間切れを別の Promise で競わせる
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(TIMEOUT);
    }, timeoutMs);
  });
  const request = (async () => {
    const res = await fetchImpl(config.url, {
      method: 'POST',
      body: JSON.stringify(body),
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
    request.catch(() => {}); // 時間切れで負けた方の失敗を「未処理の失敗」として出さない
  }
}

/* ---------------------------------------------------------
   接続テスト（design 14.6.8 の T-OK・T-1〜T-6、sheets-setup 11.5 の見分け方）
   --------------------------------------------------------- */

/**
 * 接続テストの結果の種類（design 14.6.8 の表の # と対応）。
 * ok＝T-OK、offline＝T-1、badToken＝T-2、unreachable＝T-3、timeout＝T-4、notApp＝T-5、scriptError＝T-6、
 * aborted＝画面を離れたなどで呼び出し側が打ち切った（画面には出さない）、
 * notConfigured＝保存済みの URL・合言葉が空か入力チェックを通らない（何も送っていない。画面には出さない：
 * 設定画面はその場合、欄を赤にして接続テストを押せなくしている）
 */
export const PING_RESULTS = Object.freeze({
  ok: 'T-OK', offline: 'T-1', badToken: 'T-2', unreachable: 'T-3', timeout: 'T-4', notApp: 'T-5', scriptError: 'T-6',
});

/** 接続テストの結果の文（design 14.6.8。成功の文は時刻を付けて pingResultText が作る） */
export const PING_RESULT_TEXTS = Object.freeze({
  offline: 'オフラインです。通信できる場所でもう一度試してください。',
  badToken: '合言葉が違います。Apps Scriptに設定した合言葉と同じものを入力してください。',
  unreachable: 'Apps Scriptに接続できませんでした。URLと、デプロイの「アクセスできるユーザー」が「全員」になっているかを確認してください。',
  timeout: '応答がありませんでした。時間をおいてもう一度試してください。',
  notApp: 'このアプリ用のApps Scriptではないようです。URLを確認してください。',
  scriptError: 'Apps Scriptでエラーが起きました。スプレッドシートのメニュー「FXトレード記録」→「設定を確認する」で原因を確かめてください（手順書の「困ったとき」）。',
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 開発者ツールに出してよい短いコード（英字・数字・_ だけ。応答に変な文字が入っていても、そのまま出さない） */
const safeCode = (v) => (typeof v === 'string' && /^[A-Z0-9_]{1,40}$/.test(v) ? v : null);

/** 接続テストの成功の応答にあるタブの状態（sheets-setup 11.4） */
const SHEET_STATES = ['ready', 'missing', 'empty'];

/**
 * 応答の本文を結果の種類に振り分ける（sheets-setup 11.5 の順の 4〜7）。
 * @param {string} text 応答の本文
 * @returns {{ result: string, code?: (string|null), reason?: (string|null), sheetState?: (string|null) }}
 */
export function classifyPingResponse(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return { result: 'notApp' }; // 4：JSON でない（doPost の無い古いコード・別のページ）
  }
  if (!isPlainObject(body) || body.app !== SYNC_APP_ID) return { result: 'notApp' }; // 4：このアプリ用の印がない
  if (body.ok === true && body.action === 'ping') {
    // タブの状態（ready／missing／empty。どれも成功：sheets-setup 11.4）。開発者ツールに出すだけ
    const state = isPlainObject(body.sheet) && SHEET_STATES.includes(body.sheet.state) ? body.sheet.state : null;
    return { result: 'ok', sheetState: state }; // 5
  }
  const error = isPlainObject(body.error) ? body.error : {};
  const code = safeCode(error.code);
  if (body.ok === false && code === 'BAD_TOKEN') return { result: 'badToken', code }; // 6
  // 7：それ以外（TOKEN_NOT_SET・HEADER_MISMATCH・NO_SPREADSHEET・UNSUPPORTED_VERSION・INTERNAL〔SHEETS_API_NOT_ADDED を含む〕・BAD_REQUEST など）
  return { result: 'scriptError', code, reason: safeCode(error.reason) };
}

/**
 * 接続テスト：保存済みの URL・合言葉で Apps Script に ping を送る（シートには何も書かない：gas/Code.gs の handlePing_）。
 * 例外は投げず、いつも結果の種類を返す（画面は結果の文を出すだけでよいように）。
 * @param {{ url: string, token: string, fetchImpl?: Function, timeoutMs?: number, signal?: AbortSignal,
 *   isOnline?: () => boolean, log?: Pick<Console, 'warn'|'info'> }} opts
 *   isOnline … 端末が通信できる状態か（既定：navigator.onLine）。テストで差し替える
 *   log      … 開発者ツールへの出し先（既定：console）。テストで「URL・合言葉が出ていないか」を確かめるために差し替える
 * @returns {Promise<{ result: ('ok'|'offline'|'badToken'|'unreachable'|'timeout'|'notApp'|'scriptError'|'aborted'|'notConfigured'),
 *   code?: (string|null), reason?: (string|null), sheetState?: (string|null) }>}
 */
export async function pingAppsScript({
  url, token, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = PING_TIMEOUT_MS, signal,
  isOnline = () => globalThis.navigator?.onLine !== false, log = console,
}) {
  let res;
  try {
    res = await postToAppsScript({ url, token, payload: { action: 'ping' }, fetchImpl, timeoutMs, signal });
  } catch (e) {
    if (e === NOT_CONFIGURED) {
      log.warn('接続テスト：notConfigured（送っていません）');
      return { result: 'notConfigured' };
    }
    if (signal && signal.aborted) return { result: 'aborted' };
    // 見分ける順は sheets-setup 11.5 の 1〜3（オフライン → 時間切れ → 届かない）
    let result = 'unreachable';
    if (!isOnline()) result = 'offline';
    else if (e === TIMEOUT) result = 'timeout';
    // 例外の message はブラウザによって URL が入るので出さない。name（TypeError など）だけ
    log.warn(`接続テスト：${result}（${e === TIMEOUT ? 'timeout' : (e && e.name) || 'error'}）`);
    return { result };
  }

  // Apps Script の応答はいつも HTTP 200（状態コードを変えられない：sheets-setup 11.3）。
  // それ以外は doPost まで届いていない（転送先のエラーなど）ので「届かない」と同じに扱う
  if (!res.ok) {
    log.warn(`接続テスト：unreachable（HTTP ${res.status}）`);
    return { result: 'unreachable' };
  }
  const out = classifyPingResponse(res.text);
  // 応答の本文・error.message は出さず、決まったコードだけを開発者ツールに出す
  const detail = [out.code, out.reason, out.sheetState].filter(Boolean).join(' / ');
  (out.result === 'ok' ? log.info : log.warn).call(log, `接続テスト：${out.result}${detail ? `（${detail}）` : ''}`);
  return out;
}

/**
 * 接続テストの結果の文（design 14.6.8）。aborted は画面に出さないので null。
 * @param {string} result pingAppsScript の result
 * @param {string} [time] 成功の文に付ける時刻（'22:40'。確かめた時刻）
 * @returns {string|null}
 */
export function pingResultText(result, time = '') {
  if (result === 'ok') return `接続できました（${time}）`;
  return PING_RESULT_TEXTS[result] ?? null;
}

/* ---------------------------------------------------------
   記録の送信（upsert。sheets-setup 4.3・6章・10.1・11.3〜11.5）
   --------------------------------------------------------- */

/**
 * 送る記録の並び（要求の records）を作る。値は js/csv.js の sheetRowValues（CSV と同じ作り方）。
 * 1件ごとに価格の小数桁（3 か 5：fx-rules 10.4）を添える（Apps Script に通貨ペアの規則を二重に書かないため：sheets-setup 4.3）。
 * 桁が分からない（3・5 以外）ときは添えない（Apps Script が「/JPY なら 3、それ以外は 5」で補う）。
 * @param {object[]} trades 32項目の記録
 * @param {string} syncedAt 送る時刻（全件で同じ値。成功したら記録の syncedAt もこの値にする：sheets-setup 6.3）
 * @returns {Array<{ priceDecimals?: number, values: object }>}
 */
export function buildUpsertRecords(trades, syncedAt) {
  return trades.map((trade) => {
    const record = { values: sheetRowValues(trade, { syncedAt }) };
    let decimals = null;
    try {
      decimals = getPairSpec(trade.pair).priceDecimals;
    } catch (e) {
      decimals = null; // 通貨ペアが壊れているなど。添えずに Apps Script に任せる
    }
    if (decimals === 3 || decimals === 5) return { priceDecimals: decimals, ...record };
    return record;
  });
}

/** 1件ごとの結果の名前（sheets-setup 11.4） */
const UPSERT_RESULTS = ['added', 'updated', 'stale', 'rejected'];

/**
 * 記録の送信の応答の本文を振り分ける（sheets-setup 11.4・11.5。順は接続テストと同じ）。
 * ・JSON でない／app の印がない → notApp
 * ・ok: true かつ action: 'upsert' かつ results が records と同じ数・同じ順の id → ok（results は { id, result, reason }）
 *   形が違う（数が合わない・id が違う・知らない result）→ badResponse（どの記録が書けたか分からないので、どれも synced にしない）
 * ・BAD_TOKEN → badToken、それ以外の error.code → scriptError（code・reason つき）
 * 応答の中の文字は、決まった英字のコード（safeCode）と、送った id と同じ id 以外は返さない。
 * @param {string} text 応答の本文
 * @param {string[]} sentIds 送った記録の id（records と同じ順）
 * @returns {{ result: ('ok'|'notApp'|'badResponse'|'badToken'|'scriptError'), results?: Array<{id: string, result: string, reason: (string|null)}>,
 *   code?: (string|null), reason?: (string|null) }}
 */
export function classifyUpsertResponse(text, sentIds) {
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return { result: 'notApp' };
  }
  if (!isPlainObject(body) || body.app !== SYNC_APP_ID) return { result: 'notApp' };
  if (body.ok === true && body.action === 'upsert') {
    const list = body.results;
    if (!Array.isArray(list) || list.length !== sentIds.length) return { result: 'badResponse' };
    const results = [];
    for (let i = 0; i < list.length; i += 1) {
      const r = list[i];
      if (!isPlainObject(r) || !UPSERT_RESULTS.includes(r.result)) return { result: 'badResponse' };
      // 受け付けなかった記録の id は、Apps Script が64文字で切る（id が文字でなければ null）。それ以外は送った id そのまま
      const sameId = r.id === sentIds[i]
        || (r.result === 'rejected' && (r.id === null || (typeof sentIds[i] === 'string' && r.id === sentIds[i].slice(0, 64))));
      if (!sameId) return { result: 'badResponse' };
      results.push({ id: sentIds[i], result: r.result, reason: r.result === 'rejected' ? safeCode(r.reason) : null });
    }
    return { result: 'ok', results };
  }
  if (body.ok === true) return { result: 'badResponse' }; // ok なのに upsert の答えではない
  const error = isPlainObject(body.error) ? body.error : {};
  const code = safeCode(error.code);
  if (body.ok === false && code === 'BAD_TOKEN') return { result: 'badToken', code };
  return { result: 'scriptError', code, reason: safeCode(error.reason) };
}

/**
 * 送信の失敗が「一時的」か（待てば直る見込みがある）。一時的でないもの（合言葉違い・Apps Script の設定・シートの見出し・
 * このアプリ用でない・アプリの誤り）は、設定を変えるまで同じ結果になるので、自動では送り直さない（sheets-setup 11.5 の推奨）。
 * ・一時的：offline（T-1）・timeout（T-4）・unreachable（T-3：電波・Google 側の一時的な不調もここに入る）、
 *   BUSY（ほかの書き込み中）、INTERNAL（SHEETS_API_NOT_ADDED を除く）
 * ・一時的でない：badToken・notApp・badResponse・それ以外の scriptError（TOKEN_NOT_SET・HEADER_MISMATCH・NO_SPREADSHEET・
 *   UNSUPPORTED_VERSION・BAD_REQUEST・TOO_LARGE・INTERNAL＋SHEETS_API_NOT_ADDED・知らないコード）
 * @param {{ result: string, code?: (string|null), reason?: (string|null) }} out upsertToAppsScript の結果
 * @returns {boolean}
 */
export function isTransientSyncFailure(out) {
  if (['offline', 'timeout', 'unreachable'].includes(out.result)) return true;
  if (out.result !== 'scriptError') return false;
  if (out.code === 'BUSY') return true;
  return out.code === 'INTERNAL' && out.reason !== 'SHEETS_API_NOT_ADDED';
}

/**
 * 記録を Apps Script に送る（action: 'upsert'）。例外は投げず、いつも結果の種類を返す。
 * ・送り方・URL と合言葉の確認・時間切れは接続テストと同じ（postToAppsScript）
 * ・URL・合言葉・要求と応答の本文は開発者ツールに出さない。出すのは結果の種類と件数、決まった英字のコードだけ
 * @param {{ url: string, token: string, records: Array<{ values: object, priceDecimals?: number }>, fetchImpl?: Function,
 *   timeoutMs?: number, signal?: AbortSignal, isOnline?: () => boolean, log?: Pick<Console, 'warn'|'info'> }} opts
 * @returns {Promise<{ result: ('ok'|'notConfigured'|'offline'|'timeout'|'unreachable'|'notApp'|'badResponse'|'badToken'|'scriptError'|'aborted'),
 *   results?: Array<{id: string, result: string, reason: (string|null)}>, code?: (string|null), reason?: (string|null) }>}
 */
export async function upsertToAppsScript({
  url, token, records, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = UPSERT_TIMEOUT_MS, signal,
  isOnline = () => globalThis.navigator?.onLine !== false, log = console,
}) {
  const sentIds = records.map((r) => r.values.id);
  let res;
  try {
    res = await postToAppsScript({ url, token, payload: { action: 'upsert', records }, fetchImpl, timeoutMs, signal });
  } catch (e) {
    if (e === NOT_CONFIGURED) return { result: 'notConfigured' };
    if (signal && signal.aborted) return { result: 'aborted' };
    let result = 'unreachable';
    if (!isOnline()) result = 'offline';
    else if (e === TIMEOUT) result = 'timeout';
    // 例外の message はブラウザによって URL が入るので出さない。name（TypeError など）だけ
    log.warn(`スプレッドシートへの送信：${result}（${e === TIMEOUT ? 'timeout' : (e && e.name) || 'error'}）`);
    return { result };
  }
  if (!res.ok) {
    log.warn(`スプレッドシートへの送信：unreachable（HTTP ${res.status}）`);
    return { result: 'unreachable' };
  }
  const out = classifyUpsertResponse(res.text, sentIds);
  if (out.result === 'ok') {
    const counts = Object.fromEntries(UPSERT_RESULTS.map((k) => [k, out.results.filter((r) => r.result === k).length]));
    const reasons = [...new Set(out.results.map((r) => r.reason).filter(Boolean))];
    const line = `スプレッドシートへの送信：ok（${UPSERT_RESULTS.map((k) => `${k} ${counts[k]}`).join(' / ')}${reasons.length ? `：${reasons.join(', ')}` : ''}）`;
    (counts.rejected > 0 ? log.warn : log.info).call(log, line);
  } else {
    const detail = [out.code, out.reason].filter(Boolean).join(' / ');
    log.warn(`スプレッドシートへの送信：${out.result}${detail ? `（${detail}）` : ''}`);
  }
  return out;
}
