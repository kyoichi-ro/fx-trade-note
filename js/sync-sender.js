/* =========================================================
   js/sync-sender.js
   スプレッドシートへの自動送信（Phase 2・T-41／T-42）：記録が変わるたびに、その記録を Apps Script に送り（upsert）、
   結果を記録の syncStatus・syncedAt に書き戻す（architecture 3.3・20.2、docs/sheets-setup.md 6章・10.1・10.3・11.5）。
   T-42 で、未送信の記録（syncStatus が pending。削除済みも含む）を、起動時・オンライン復帰時・前面に戻ったときに自動で送り直し、
   「今すぐ同期」（手動）の入口を足した。
   Apps Script との通信そのもの（送り方・要求の形・応答の振り分け）は js/sync.js。ここは「いつ・何を送るか」と「結果の扱い」。

   【送るきっかけ】
   ・trades.js の変更通知 'trades-changed'：保存（add）・決済／編集／決済の取り消し／画像の削除（update）・削除（delete）・
     削除の取り消し（restore）・CSV の取り込み（imported：ids でまとめて）。通知を受けたら id を送る列に足すだけで、すぐ戻る
     （保存の処理を待たせない。送信は保存が終わったあとに別に動く）
   ・未送信の再送（T-42。requestUnsent）：DB の syncStatus インデックスから未送信の記録を取り出して列に足す（architecture 3.3：専用の
     ストアは作らない）。きっかけは次のとおり（connectResendTriggers）。どれも RESEND_DELAY_MS（2秒）待ってから1回だけ行う
     ・起動時（画面の表示を先に）
     ・オンライン復帰時（online イベント。つながった直後は通信が安定しないことがあるため少し待つ）
     ・前面に戻ったとき（visibilitychange）。ただし前回の送信・確認から VISIBLE_RESEND_INTERVAL_MS（1分）たったときだけ
       （アプリを行き来するたびに送らない）。iPhone のホーム画面版は裏から戻ってもページを開き直さないため（architecture 17章 #15）
     ・一時的な失敗のあとの待ってからの再送（RETRY_DELAYS_MS：30秒・2分・10分の3回まで。それでも送れなければ、ほかのきっかけを待つ）
     ・設定画面の接続テストの成功（resumeAutoSync。設定の問題で止めていたら止めるのをやめて送る：T-41 レビュー SS-R02）
     ・「今すぐ同期」（syncNow／requestUnsent({ manual: true })。ボタンの置き場所は T-43 で決める）
   ・受け付けられなかった記録（syncStatus＝error。Apps Script の rejected）は、同じ内容を送っても同じ結果になるので、自動では送り直さない。
     その記録が変わったとき（保存で pending に戻る）と、「今すぐ同期」のときだけ送る

   【送り方】
   ・同時に1つだけ（送信が終わるまで次を送らない：sheets-setup 6.1・10.1 #4）。1回に SYNC_BATCH_SIZE 件（20件）まで
   ・1分に SYNC_RECORDS_PER_MINUTE 件（40件）まで。超えそうなら、1分前に送った分が外れるまで待って続きを送る（SS-R04）
   ・送る直前に記録を DB から読み直す（最新の内容を送る）。すでに synced の記録は送らない（再送のきっかけが重なっても二重に送らない）
   ・送る列は id の集まり（同じ id は1つ）。未送信の読み出しが重なったとき（起動時とオンライン復帰が同時 など）も1つにまとめる
   ・URL・合言葉が未設定（または入力チェックを通らない：SY-R02）なら何もしない（記録は pending のまま。未送信の読み出しもしない）
   ・同じ記録を何度送っても、Apps Script は id で上書きするのでシートの行は1つ（sheets-setup 6.1）

   【結果の扱い（sheets-setup 10.3）】
   ・added・updated・stale → synced（syncedAt＝送る時刻）、rejected → error。書き戻しは trades.js の markSyncResults：
     updatedAt は変えない・送ったときから記録が変わっていたら書き戻さない（pending のまま。その変更の通知で改めて送られる）・
     'trades-changed' は出さない（送信 → 書き戻し → 送信 … と繰り返さないため）
   ・全体の失敗は記録を pending のまま残し、syncLastError（端末の設定。最後のエラー1つ：roadmap 7.20 #1）に残す
     ・一時的な失敗（オフライン・時間切れ・届かない・BUSY・INTERNAL）… 送る列の id はそのまま残し（失敗した回の id も、送っている間に
       足された id も：SS-R01）、次のきっかけで送る。オフラインでなければ、待ってからの再送も予約する
     ・設定の問題（合言葉違い・Apps Script の設定・シートの見出し・このアプリ用でない など：sync.js の isTransientSyncFailure）
       … 同じ URL・合言葉のままでは自動で送らない（sheets-setup 11.5 の推奨）。URL か合言葉を変えたら・アプリを開き直したら・
       接続テストが成功したら・「今すぐ同期」で、また送る
   ・どの失敗でも、記録の内容は変えない・保存の処理を失敗させない
   ・受け付けられなかった記録の知らせ（reason・件数・id）は、そのあとにほかの種類のエラーが起きても syncLastError.rejected に持ち越し、
     そのエラーが直ったら kind: 'rejected' に戻す（SS-R03。記録が受け付けられる〔synced になる〕まで消さない）

   【秘密の情報】URL・合言葉・要求と応答の本文は console にも syncLastError にも出さない（sync.js の冒頭と同じ）。
   同じ設定のまま送らないための目印（URL と合言葉の組）はメモリの中にだけ持つ。

   依存：sync.js・csv.js（送る値）、events.js、datetime.js、settings-store.js（URL・合言葉・syncLastError）、
         trades.js（記録の読み直しと書き戻し）、db.js（未送信の取り出し：syncStatus インデックス）
   ========================================================= */
import {
  readSyncConfig, buildUpsertRecords, upsertToAppsScript, isTransientSyncFailure, SYNC_BATCH_SIZE, SYNC_RECORDS_PER_MINUTE,
} from './sync.js';
import { sheetRowValues, CSV_COLUMNS } from './csv.js';
import { on } from './events.js';
import { nowJst } from './datetime.js';
import { getSetting, setSetting } from './settings-store.js';
import { TRADES_CHANGED, getTrade, markSyncResults } from './trades.js';
import { getTradesByIndex, INDEX } from './db.js';

/** syncLastError の kind（settings-store.js の確かめ方と同じ一覧）。rejected 以外は sync.js の結果の種類と同じ名前 */
export const SYNC_ERROR_KINDS = Object.freeze(['offline', 'timeout', 'unreachable', 'notApp', 'badResponse', 'badToken', 'scriptError', 'rejected']);

/** syncLastError に残す、受け付けられなかった記録の id の数の上限（sheets-setup 9.1：最大10件程度） */
const MAX_ERROR_IDS = 10;

/** 送るきっかけにする 'trades-changed' の種類（events.js）。知らない種類（将来足すもの）では送らない */
export const SEND_TRIGGERS = Object.freeze(['add', 'update', 'delete', 'restore', 'imported']);

/** 起動時・オンライン復帰時・前面に戻ったときに、未送信の再送を始めるまで待つ時間（2秒） */
export const RESEND_DELAY_MS = 2000;

/** 前面に戻ったときの再送の最短の間隔（1分）。前回の送信（または前面に戻ったときの確認）からこれだけたっていなければ何もしない */
export const VISIBLE_RESEND_INTERVAL_MS = 60 * 1000;

/**
 * 一時的な失敗（時間切れ・届かない・BUSY・INTERNAL）のあと、待ってから送り直すまでの時間（30秒・2分・10分）。
 * 続けて失敗したら次の時間を使い、3回とも失敗したら、待ってからの再送はやめてほかのきっかけ（保存・前面に戻る・オンライン復帰・起動・
 * 「今すぐ同期」）を待つ（電波の悪い場所で何度も送り続けないため）。成功したら最初に戻る。オフラインのときは予約しない（online を待つ）
 */
export const RETRY_DELAYS_MS = Object.freeze([30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000]);

/** 1分（送った件数を数える幅） */
const MINUTE_MS = 60 * 1000;

/**
 * 変更通知の detail から、送る記録の id を取り出す。
 * @param {*} detail 'trades-changed' の detail（{ type, id, trade } か、CSV の取り込みは { type: 'imported', ids }）
 * @returns {string[]}
 */
export function idsFromChange(detail) {
  if (!detail || !SEND_TRIGGERS.includes(detail.type)) return [];
  const ids = detail.type === 'imported' ? detail.ids : [detail.id];
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id !== '') : [];
}

/**
 * 保存されている記録が、送った値と同じ内容か（syncStatus・syncedAt を除く30列。シートの行と同じ物差し：csv.js の sheetRowValues）。
 * updatedAt は秒単位なので、同じ秒の中の変更（削除の直後の「取り消す」など）を見分けるために使う（R-05）。
 * @param {object} sentValues 送った「列名 → 値」
 * @param {object} stored 保存されている記録
 * @returns {boolean}
 */
export function sameSheetContent(sentValues, stored) {
  const current = sheetRowValues(stored, { syncedAt: sentValues.syncedAt });
  return CSV_COLUMNS.every((c) => c === 'syncStatus' || c === 'syncedAt' || current[c] === sentValues[c]);
}

/**
 * 未送信の記録を、送る順に並べた id にする（作った順＝createdAt。同じなら id 順）。
 * T-41 より前からある記録をまとめて送るとき、シートの行が記録を作った順に並ぶように。
 * @param {object[]} trades
 * @returns {string[]}
 */
export function unsentIdsInOrder(trades) {
  return trades
    .filter((t) => t && typeof t.id === 'string' && t.id !== '')
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || a.id.localeCompare(b.id))
    .map((t) => t.id);
}

/**
 * syncLastError から「受け付けられなかった記録の知らせ」を取り出す（SS-R03）。
 * kind が rejected ならその本体、ほかの種類なら持ち越した rejected 欄。無ければ null。
 * @param {object|null} err
 * @returns {{ at: string, reason: (string|null), count: number, ids: string[] } | null}
 */
export function rejectedInfoOf(err) {
  if (!err) return null;
  if (err.kind === 'rejected') return { at: err.at, reason: err.reason, count: err.count, ids: err.ids };
  return err.rejected ?? null;
}

/** タイマー（Node.js では、待っている間もテストの終わりを妨げないよう unref する。ブラウザは数を返すだけ） */
function defaultSetTimer(fn, ms) {
  const handle = setTimeout(fn, ms);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

/** 送り方の結果（sendBatch が返す） */
const NEXT = 'next'; // 続けて送ってよい
const STOP_KEEP = 'stopKeep'; // 一時的な失敗：止めるが、列の id は残す（次のきっかけで送る：SS-R01）
const STOP_CLEAR = 'stopClear'; // 未設定・設定の問題：止めて列を空にする（記録は pending のまま。再送のきっかけで DB から読み直す）

/**
 * 自動送信のしくみを作る。DB・設定・通信・時計はすべて外から渡す（テストでにせものを渡せるように）。
 * アプリ本体は下の startAutoSync が本物をつないで使う。
 * @param {object} deps
 * @param {() => ({ url: string, token: string } | null)} deps.getConfig 送ってよい URL・合言葉（readSyncConfig の結果）。未設定なら null
 * @param {(ids: string[]) => Promise<Array<object|null>>} deps.loadTrades 記録を読み直す（無いものは null）
 * @param {(entries: object[]) => Promise<string[]>} deps.markResults 結果の書き戻し（trades.js の markSyncResults）
 * @param {(opts: { includeErrors: boolean }) => Promise<string[]>} [deps.loadUnsentIds] 未送信の記録の id（送る順）。
 *   includeErrors が false なら pending だけ、true（「今すぐ同期」）なら pending と error
 * @param {() => (object|null)} [deps.readLastError] syncLastError を読む
 * @param {(value: (object|null)) => void} [deps.saveLastError] syncLastError を保存する（失敗しても送信は止めない）
 * @param {() => string} [deps.now] 今の日時（日本時間の固定形式）。送る時刻・エラーの時刻に使う
 * @param {number} [deps.batchSize] 1回に送る件数の上限
 * @param {number} [deps.recordsPerMinute] 1分に送る件数の上限（SS-R04）
 * @param {number[]} [deps.retryDelays] 一時的な失敗のあと、待ってから送り直すまでの時間
 * @param {Function} [deps.fetchImpl] fetch（テストでにせものを渡す）
 * @param {number} [deps.timeoutMs] 送信の時間切れ
 * @param {() => boolean} [deps.isOnline] 端末が通信できる状態か（既定：navigator.onLine）
 * @param {Pick<Console, 'warn'|'info'|'error'>} [deps.log] 開発者ツールへの出し先
 * @param {(fn: () => void) => void} [deps.schedule] 送信を始める時機（既定：今の処理が終わったあと）
 * @param {() => number} [deps.nowMs] 今の時刻（ミリ秒）。1分あたりの件数と、前回の送信からの時間に使う
 * @param {(ms: number) => Promise<void>} [deps.sleep] 1分あたりの上限で待つ
 * @param {(fn: () => void, ms: number) => *} [deps.setTimer] 待ってからの再送の予約
 * @param {(handle: *) => void} [deps.clearTimer] 予約の取り消し
 */
export function createSyncSender({
  getConfig, loadTrades, markResults, loadUnsentIds = async () => [],
  readLastError = () => null, saveLastError = () => {}, now = nowJst, batchSize = SYNC_BATCH_SIZE,
  recordsPerMinute = SYNC_RECORDS_PER_MINUTE, retryDelays = RETRY_DELAYS_MS,
  fetchImpl, timeoutMs, isOnline = () => globalThis.navigator?.onLine !== false, log = console,
  schedule = (fn) => { setTimeout(fn, 0); },
  nowMs = () => Date.now(), sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  setTimer = defaultSetTimer, clearTimer = (handle) => { clearTimeout(handle); },
}) {
  /** 1回に送る件数（1分の上限より多くはしない） */
  const perBatch = Math.max(1, Math.min(batchSize, recordsPerMinute));
  /** 送る記録の id（重複なし・足した順） */
  const queue = new Set();
  /** 送信中の処理（同時に1つだけ） */
  let running = null;
  /** 送信を始める予約をしたか */
  let scheduled = false;
  /** 設定の問題で止めたときの URL と合言葉の組（メモリの中だけ。同じ組のままなら自動では送らない） */
  let blockedKey = null;
  /** 一時的な失敗で止めたか（次のきっかけまで送らない。列の id は残す：SS-R01） */
  let paused = false;
  /** 続けて起きた一時的な失敗の回数（待ってからの再送の間隔を決める） */
  let failures = 0;
  /** 待ってからの再送の予約 */
  let retryTimer = null;
  /** 直前の1分に送った件数の記録（{ at, n }。SS-R04） */
  const sentLog = [];
  /** 最後に送信（fetch）を始めた時刻（ミリ秒）。前面に戻ったときの再送の間隔に使う */
  let lastSendAt = -Infinity;
  /** 実行中の未送信の読み出し */
  const loads = new Set();
  /** 実行中の自動の読み出し（重ねて呼ばれたら同じものを返す） */
  let autoLoad = null;

  const keyOf = (config) => `${config.url}\n${config.token}`;

  /** syncLastError を保存する。保存できなくても（容量不足など）送信は続ける */
  function writeLastError(value) {
    try {
      saveLastError(value);
    } catch (e) {
      log.warn(`同期のエラーを端末に記録できませんでした（${(e && e.code) || (e && e.name) || 'error'}）`);
    }
  }

  function readError() {
    try {
      return readLastError();
    } catch (e) {
      return null;
    }
  }

  /**
   * 全体の失敗を残す（URL・合言葉・本文は入れない）。
   * 前に受け付けられなかった記録の知らせがあれば、rejected 欄に持ち越す（上書きで消さない：SS-R03）
   */
  function recordFailure(kind, { code = null, reason = null } = {}) {
    const carried = rejectedInfoOf(readError());
    writeLastError({ at: now(), kind, code, reason, count: 0, ids: [], ...(carried ? { rejected: carried } : {}) });
  }

  /**
   * 1回の送信が成功したあとの syncLastError の扱い。
   * ・受け付けられなかった記録があれば kind: 'rejected'（前の知らせのうち、まだ synced になっていない id も残す。最大10件）
   * ・なければ、前のエラーを消す。ただし前に受け付けられなかった記録の知らせ（kind が rejected、または持ち越した rejected 欄）があれば、
   *   今回 synced になった id だけを外して kind: 'rejected' として残し、残りが無くなったら消す
   *   （ほかの記録の成功・一時的な失敗が直ったことで、受け付けられなかった記録の知らせが消えないように：SS-R03。
   *   件数は T-43 が syncStatus＝error から数えられる）
   */
  function afterSuccess(syncedIds, rejected) {
    const prev = readError();
    const prevRejected = rejectedInfoOf(prev);
    const kept = prevRejected
      ? prevRejected.ids.filter((id) => !syncedIds.has(id) && !rejected.some((r) => r.id === id))
      : [];
    // 前の知らせの件数のうち、まだ残っている数（id は最大10件しか持たないので、件数は件数で減らす）
    const keptCount = prevRejected ? Math.max(kept.length, prevRejected.count - (prevRejected.ids.length - kept.length)) : 0;
    if (rejected.length > 0) {
      const ids = [...rejected.map((r) => r.id).filter((id) => typeof id === 'string' && id !== ''), ...kept].slice(0, MAX_ERROR_IDS)
        .map((id) => id.slice(0, 64));
      writeLastError({ at: now(), kind: 'rejected', code: null, reason: rejected[0].reason ?? null, count: rejected.length + keptCount, ids });
      return;
    }
    if (prev === null) return;
    if (prevRejected && kept.length > 0) {
      const next = { at: prevRejected.at, kind: 'rejected', code: null, reason: prevRejected.reason, count: keptCount, ids: kept };
      if (JSON.stringify(next) !== JSON.stringify(prev)) writeLastError(next);
      return;
    }
    writeLastError(null);
  }

  /** 待ってからの再送の予約を取り消す */
  function cancelRetry() {
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  }

  /** 一時的な失敗のあと、待ってからの再送を予約する（3回まで） */
  function scheduleRetry() {
    failures += 1;
    cancelRetry();
    if (failures > retryDelays.length) {
      log.info('スプレッドシートへの送信：続けて失敗したため、次の保存・起動・オンライン復帰のときに送ります');
      return;
    }
    retryTimer = setTimer(() => {
      retryTimer = null;
      requestUnsent();
    }, retryDelays[failures - 1]);
  }

  /** 直前の1分に送った件数（古いものは捨てる） */
  function sentInLastMinute(t) {
    while (sentLog.length > 0 && t - sentLog[0].at >= MINUTE_MS) sentLog.shift();
    return sentLog.reduce((sum, e) => sum + e.n, 0);
  }

  /** n 件を送っても1分の上限を超えないところまで待つ（SS-R04） */
  async function waitForBudget(n) {
    for (;;) {
      const t = nowMs();
      if (sentLog.length === 0 || sentInLastMinute(t) + n <= recordsPerMinute) return;
      const wait = Math.max(1, sentLog[0].at + MINUTE_MS - t);
      log.info(`スプレッドシートへの送信：1分あたりの件数の上限に近いため、${Math.ceil(wait / 1000)}秒待ってから続きを送ります`);
      await sleep(wait);
    }
  }

  /** 失敗した回の id を、列の先頭に戻す（順番を保つ。送っている間に足された id はそのあと） */
  function requeueFront(ids) {
    const rest = [...queue].filter((id) => !ids.includes(id));
    queue.clear();
    for (const id of [...ids, ...rest]) queue.add(id);
  }

  /** 列の先頭から1回分を送る。結果は NEXT（続けてよい）・STOP_KEEP・STOP_CLEAR */
  async function sendBatch() {
    await waitForBudget(Math.min(perBatch, queue.size));
    const config = getConfig();
    if (!config) return STOP_CLEAR; // 未設定：何もしない（記録は pending のまま。設定したら再送のきっかけで送る）
    const key = keyOf(config);
    if (blockedKey !== null) {
      if (blockedKey === key) return STOP_CLEAR; // 設定の問題で止めたまま（同じ URL・合言葉）
      blockedKey = null; // URL か合言葉が変わった
    }
    if (!isOnline()) {
      recordFailure('offline');
      return STOP_KEEP; // オンラインに戻ったら（online イベント）送る
    }
    const ids = [...queue].slice(0, perBatch);
    for (const id of ids) queue.delete(id);
    const trades = (await loadTrades(ids)).filter((t) => t && typeof t.id === 'string' && t.syncStatus !== 'synced');
    if (trades.length === 0) return NEXT;

    const syncedAt = now();
    const records = buildUpsertRecords(trades, syncedAt);
    const started = nowMs();
    sentLog.push({ at: started, n: records.length });
    lastSendAt = started;
    const out = await upsertToAppsScript({ url: config.url, token: config.token, records, fetchImpl, timeoutMs, isOnline, log });
    if (out.result === 'notConfigured' || out.result === 'aborted') return STOP_CLEAR;
    if (out.result !== 'ok') {
      recordFailure(out.result, { code: out.code ?? null, reason: out.reason ?? null });
      if (!isTransientSyncFailure(out)) {
        blockedKey = key;
        failures = 0;
        cancelRetry();
        return STOP_CLEAR;
      }
      // 一時的な失敗：この回の id も列に戻す（記録は pending のまま。次のきっかけで送る：SS-R01）
      requeueFront(trades.map((t) => t.id));
      if (out.result !== 'offline') scheduleRetry();
      return STOP_KEEP;
    }

    failures = 0;
    cancelRetry();
    const entries = trades.map((trade, i) => ({
      id: trade.id,
      updatedAt: trade.updatedAt,
      syncStatus: out.results[i].result === 'rejected' ? 'error' : 'synced',
      syncedAt,
      sameAsSent: (stored) => sameSheetContent(records[i].values, stored),
    }));
    await markResults(entries);
    const rejected = out.results.filter((r) => r.result === 'rejected');
    const syncedIds = new Set(out.results.filter((r) => r.result !== 'rejected').map((r) => r.id));
    afterSuccess(syncedIds, rejected);
    return NEXT;
  }

  /** 列が空になるまで1回分ずつ送る */
  async function drain() {
    while (queue.size > 0) {
      const next = await sendBatch();
      if (next === STOP_CLEAR) {
        queue.clear(); // 止めた：残りの記録は pending のまま（再送のきっかけで DB から読み直す）
        return;
      }
      if (next === STOP_KEEP) {
        paused = true; // 一時的な失敗：列はそのまま。次のきっかけで送る
        return;
      }
    }
  }

  function start() {
    if (running) return;
    running = (async () => {
      try {
        await drain();
      } catch (e) {
        // DB の読み書きの失敗など。記録は pending のまま残る（再送のきっかけで読み直す）。e に URL・合言葉は入らない（ここまで渡していない）
        log.error('スプレッドシートへの送信を中断しました', e);
        queue.clear();
      } finally {
        running = null;
      }
      if (queue.size > 0) kick(); // 一時的な失敗で止めたとき（paused）は送らない
    })();
  }

  function kick() {
    if (running || scheduled || paused || queue.size === 0) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      start();
    });
  }

  /**
   * 記録を送る列に足す（すぐ戻る。送信は今の処理が終わったあとに始まる）。送信中なら、その送信のあとで送る。
   * 新しいきっかけなので、一時的な失敗で止めていても送ってみる（列に残っていた id も一緒に）。
   * @param {string[]} ids
   */
  function request(ids) {
    for (const id of ids) if (typeof id === 'string' && id !== '') queue.add(id);
    paused = false;
    kick();
  }

  /**
   * 未送信の記録をまとめて送る（起動時・オンライン復帰時・前面に戻ったとき・待ってからの再送・「今すぐ同期」）。
   * ・URL・合言葉が未設定なら何もしない（読み出しもしない）
   * ・自動（manual: false）：pending だけを送る。設定の問題で止めているときは何もしない。読み出しが重なったら1つにまとめる
   * ・手動（manual: true。「今すぐ同期」）：pending と error（受け付けられなかった記録）を送る。設定の問題で止めていても送ってみる
   *   （sheets-setup 11.5）。待ってからの再送の回数も最初に戻す
   * 例外は投げない（DB から読めなかったときは開発者ツールに出して 0 を返す）。
   * @param {{ manual?: boolean }} [opts]
   * @returns {Promise<number>} 送る列に足した記録の数
   */
  async function requestUnsent({ manual = false } = {}) {
    const config = getConfig();
    if (!config) return 0;
    if (manual) {
      blockedKey = null;
      failures = 0;
    } else if (blockedKey !== null && blockedKey === keyOf(config)) {
      return 0;
    }
    if (!manual && autoLoad) return autoLoad;
    const load = (async () => {
      let ids;
      try {
        ids = await loadUnsentIds({ includeErrors: manual });
      } catch (e) {
        log.error('未送信の記録を読み出せませんでした', e);
        return 0;
      }
      request(ids);
      return ids.length;
    })();
    loads.add(load);
    if (!manual) autoLoad = load;
    try {
      return await load;
    } finally {
      loads.delete(load);
      if (autoLoad === load) autoLoad = null;
    }
  }

  /** 送る列が空になり（または止まり）、送信と未送信の読み出しが終わるまで待つ */
  async function whenIdle() {
    while (running || scheduled || loads.size > 0) {
      if (running) await running;
      else if (loads.size > 0) await Promise.all([...loads]);
      else await new Promise((resolve) => { setTimeout(resolve, 0); });
    }
  }

  return {
    request,
    requestUnsent,
    whenIdle,

    /**
     * 「今すぐ同期」（T-42。画面のボタンの置き場所は T-43 で決める）：未送信（pending・error）をすべて送り、送り終わるまで待つ。
     * @returns {Promise<number>} 送る列に足した記録の数（未設定なら 0）
     */
    async syncNow() {
      const n = await requestUnsent({ manual: true });
      await whenIdle();
      return n;
    },

    /**
     * 接続テストが成功したとき（T-41 レビュー SS-R02）：設定の問題で止めていた自動の送信を再開し、未送信（pending）を送る。
     * 受け付けられなかった記録（error）は、接続テストでは直らないので送らない（「今すぐ同期」で送る）。
     * @returns {Promise<number>}
     */
    resumeAfterTest() {
      blockedKey = null;
      failures = 0;
      return requestUnsent();
    },

    /** 最後に送信（fetch）を始めた時刻（ミリ秒）。送ったことがなければ -Infinity（前面に戻ったときの再送の間隔に使う） */
    lastSendAt: () => lastSendAt,

    /** 設定の問題で自動の送信を止めているか（T-43 の画面・テスト用） */
    isBlocked: () => blockedKey !== null,

    /** 一時的な失敗で止めていて、次のきっかけを待っているか（テスト・T-43 用） */
    isPaused: () => paused,

    /** 送る列に残っている記録の数（テスト・T-43 用） */
    queuedCount: () => queue.size,

    /** 待ってからの再送を予約しているか（テスト用） */
    hasRetryScheduled: () => retryTimer !== null,
  };
}

/**
 * 送信のしくみに、記録の変更通知をつなぐ。
 * @param {{ request: (ids: string[]) => void }} sender
 * @param {typeof on} [listen] 通知の受け取り方（既定：events.js の on）
 * @returns {() => void} つなぐのをやめる関数
 */
export function connectSender(sender, listen = on) {
  return listen(TRADES_CHANGED, (detail) => {
    const ids = idsFromChange(detail);
    if (ids.length > 0) sender.request(ids);
  });
}

/**
 * 未送信の再送のきっかけ（起動時・オンライン復帰時・前面に戻ったとき）をつなぐ（T-42。architecture 3.3）。
 * ・どれも delayMs 待ってから requestUnsent()（自動）を1回呼ぶ。待っている間に別のきっかけが来ても1回にまとめる
 * ・起動時：つないだときに1回
 * ・オンライン復帰時：window の online
 * ・前面に戻ったとき：document の visibilitychange で visible になり、前回の送信（sender.lastSendAt）と前回の確認の
 *   どちらからも visibleIntervalMs 以上たっているときだけ
 * @param {{ requestUnsent: Function, lastSendAt: () => number }} sender
 * @param {{ win?: EventTarget, doc?: (EventTarget & { visibilityState: string }), nowMs?: () => number,
 *   setTimer?: Function, clearTimer?: Function, delayMs?: number, visibleIntervalMs?: number }} [opts] テストで差し替える
 * @returns {() => void} つなぐのをやめる関数（予約も取り消す）
 */
export function connectResendTriggers(sender, {
  win = globalThis.window, doc = globalThis.document, nowMs = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (handle) => { clearTimeout(handle); },
  delayMs = RESEND_DELAY_MS, visibleIntervalMs = VISIBLE_RESEND_INTERVAL_MS,
} = {}) {
  let timer = null;
  let lastVisibleCheck = -Infinity;

  function resendLater() {
    if (timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      sender.requestUnsent();
    }, delayMs);
  }

  const onOnline = () => resendLater();
  const onVisible = () => {
    if (!doc || doc.visibilityState !== 'visible') return;
    const t = nowMs();
    if (t - Math.max(lastVisibleCheck, sender.lastSendAt()) < visibleIntervalMs) return;
    lastVisibleCheck = t;
    resendLater();
  };

  if (win) win.addEventListener('online', onOnline);
  if (doc) doc.addEventListener('visibilitychange', onVisible);
  resendLater(); // 起動時

  return () => {
    if (win) win.removeEventListener('online', onOnline);
    if (doc) doc.removeEventListener('visibilitychange', onVisible);
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
}

/** アプリ本体の送信のしくみ（startAutoSync で1回だけ作る） */
let appSender = null;

/**
 * DB から未送信の記録の id を、送る順に読み出す関数を作る（syncStatus インデックス：architecture 3.3。専用のストアは作らない）。
 * 自動（includeErrors: false）は pending だけ、「今すぐ同期」（true）は pending と error。削除済みの記録も含む（sheets-setup 6.2）。
 * @param {{ getTradesByIndex: (index: string, value: string) => Promise<object[]> }} [db] 既定：アプリの DB（テストでは別名の DB）
 * @returns {(opts: { includeErrors: boolean }) => Promise<string[]>}
 */
export function unsentLoader(db = { getTradesByIndex }) {
  return async ({ includeErrors = false } = {}) => {
    const statuses = includeErrors ? ['pending', 'error'] : ['pending'];
    const lists = await Promise.all(statuses.map((s) => db.getTradesByIndex(INDEX.TRADES_SYNC_STATUS, s)));
    return unsentIdsInOrder(lists.flat());
  };
}

/**
 * アプリ本体の自動送信を始める（app.js が起動時に1回呼ぶ）。本物の設定・DB・fetch をつなぎ、
 * 変更通知と再送のきっかけ（起動時・オンライン復帰・前面に戻る）を受け取り始める。
 * 2回目以降は同じものを返す（変更通知を二重に受け取って、同じ記録を2回送らないように）。
 * @returns {ReturnType<typeof createSyncSender>}
 */
export function startAutoSync() {
  if (appSender) return appSender;
  appSender = createSyncSender({
    getConfig: () => readSyncConfig(getSetting('gasUrl'), getSetting('syncToken')),
    loadTrades: (ids) => Promise.all(ids.map((id) => getTrade(id))),
    markResults: (entries) => markSyncResults(entries),
    loadUnsentIds: unsentLoader(),
    readLastError: () => getSetting('syncLastError'),
    saveLastError: (value) => { setSetting('syncLastError', value); },
  });
  connectSender(appSender);
  connectResendTriggers(appSender);
  return appSender;
}

/**
 * 「今すぐ同期」（T-42。ボタンは T-43 で置く）：未送信（pending・error）をすべて送り、終わるまで待つ。
 * 設定の問題で自動の送信を止めていても送ってみる。自動送信を始める前（startAutoSync の前）は何もしない。
 * @returns {Promise<number>} 送る列に足した記録の数
 */
export function syncNow() {
  return appSender ? appSender.syncNow() : Promise.resolve(0);
}

/**
 * 設定画面の接続テストが成功したとき（T-41 レビュー SS-R02）：止めていた自動の送信を再開し、未送信を送る。
 * 自動送信を始める前（テストの画面など）は何もしない。
 */
export function resumeAutoSync() {
  if (appSender) appSender.resumeAfterTest();
}
