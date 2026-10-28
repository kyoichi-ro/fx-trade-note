/* =========================================================
   js/sync-sender.js
   スプレッドシートへの自動送信（Phase 2・T-41）：記録が変わるたびに、その記録を Apps Script に送り（upsert）、
   結果を記録の syncStatus・syncedAt に書き戻す（architecture 3.3・20.2、docs/sheets-setup.md 6章・10.1・10.3・11.5）。
   Apps Script との通信そのもの（送り方・要求の形・応答の振り分け）は js/sync.js。ここは「いつ・何を送るか」と「結果の扱い」。

   【送るきっかけ】
   ・trades.js の変更通知 'trades-changed'：保存（add）・決済／編集／決済の取り消し／画像の削除（update）・削除（delete）・
     削除の取り消し（restore）・CSV の取り込み（imported：ids でまとめて）。通知を受けたら id を送る列に足すだけで、すぐ戻る
     （保存の処理を待たせない。送信は保存が終わったあとに別に動く）
   ・未送信の記録をまとめて送る requestUnsent は T-42（起動時・オンライン復帰時・「今すぐ同期」）のための入口。T-41 では呼ばない

   【送り方】
   ・同時に1つだけ（送信が終わるまで次を送らない：sheets-setup 6.1・10.1 #4）。1回に SYNC_BATCH_SIZE 件（20件）まで
   ・送る直前に記録を DB から読み直す（最新の内容を送る）。すでに synced の記録は送らない
   ・URL・合言葉が未設定（または入力チェックを通らない：SY-R02）なら何もしない（記録は pending のまま）

   【結果の扱い（sheets-setup 10.3）】
   ・added・updated・stale → synced（syncedAt＝送る時刻）、rejected → error。書き戻しは trades.js の markSyncResults：
     updatedAt は変えない・送ったときから記録が変わっていたら書き戻さない（pending のまま。その変更の通知で改めて送られる）・
     'trades-changed' は出さない（送信 → 書き戻し → 送信 … と繰り返さないため）
   ・全体の失敗は記録を pending のまま残し、syncLastError（端末の設定。最後のエラー1つ：roadmap 7.20 #1）に残す
     ・一時的な失敗（オフライン・時間切れ・届かない・BUSY・INTERNAL）… 次の変更で、また送ってみる
     ・設定の問題（合言葉違い・Apps Script の設定・シートの見出し・このアプリ用でない など：sync.js の isTransientSyncFailure）
       … 同じ URL・合言葉のままでは自動で送らない（sheets-setup 11.5 の推奨）。URL か合言葉を変えたら・アプリを開き直したら・
       「今すぐ同期」（T-42。requestUnsent({ manual: true })）で、また送る
   ・どの失敗でも、記録の内容は変えない・保存の処理を失敗させない

   【秘密の情報】URL・合言葉・要求と応答の本文は console にも syncLastError にも出さない（sync.js の冒頭と同じ）。
   同じ設定のまま送らないための目印（URL と合言葉の組）はメモリの中にだけ持つ。

   依存：sync.js・csv.js（送る値）、events.js、datetime.js、settings-store.js（URL・合言葉・syncLastError）、
         trades.js（記録の読み直しと書き戻し）、db.js（未送信の取り出し：syncStatus インデックス。T-42 用）
   ========================================================= */
import { readSyncConfig, buildUpsertRecords, upsertToAppsScript, isTransientSyncFailure, SYNC_BATCH_SIZE } from './sync.js';
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
 * 自動送信のしくみを作る。DB・設定・通信はすべて外から渡す（テストでにせものを渡せるように）。
 * アプリ本体は下の startAutoSync が本物をつないで使う。
 * @param {object} deps
 * @param {() => ({ url: string, token: string } | null)} deps.getConfig 送ってよい URL・合言葉（readSyncConfig の結果）。未設定なら null
 * @param {(ids: string[]) => Promise<Array<object|null>>} deps.loadTrades 記録を読み直す（無いものは null）
 * @param {(entries: object[]) => Promise<string[]>} deps.markResults 結果の書き戻し（trades.js の markSyncResults）
 * @param {() => Promise<string[]>} [deps.loadUnsentIds] 未送信（pending・error）の記録の id（T-42 の requestUnsent 用）
 * @param {() => (object|null)} [deps.readLastError] syncLastError を読む
 * @param {(value: (object|null)) => void} [deps.saveLastError] syncLastError を保存する（失敗しても送信は止めない）
 * @param {() => string} [deps.now] 今の日時（日本時間の固定形式）。送る時刻・エラーの時刻に使う
 * @param {number} [deps.batchSize] 1回に送る件数の上限
 * @param {Function} [deps.fetchImpl] fetch（テストでにせものを渡す）
 * @param {number} [deps.timeoutMs] 送信の時間切れ
 * @param {() => boolean} [deps.isOnline] 端末が通信できる状態か（既定：navigator.onLine）
 * @param {Pick<Console, 'warn'|'info'|'error'>} [deps.log] 開発者ツールへの出し先
 * @param {(fn: () => void) => void} [deps.schedule] 送信を始める時機（既定：今の処理が終わったあと）
 */
export function createSyncSender({
  getConfig, loadTrades, markResults, loadUnsentIds = async () => [],
  readLastError = () => null, saveLastError = () => {}, now = nowJst, batchSize = SYNC_BATCH_SIZE,
  fetchImpl, timeoutMs, isOnline = () => globalThis.navigator?.onLine !== false, log = console,
  schedule = (fn) => { setTimeout(fn, 0); },
}) {
  /** 送る記録の id（重複なし・足した順） */
  const queue = new Set();
  /** 送信中の処理（同時に1つだけ） */
  let running = null;
  /** 送信を始める予約をしたか */
  let scheduled = false;
  /** 設定の問題で止めたときの URL と合言葉の組（メモリの中だけ。同じ組のままなら自動では送らない） */
  let blockedKey = null;

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

  /** 全体の失敗を残す（URL・合言葉・本文は入れない） */
  function recordFailure(kind, { code = null, reason = null } = {}) {
    writeLastError({ at: now(), kind, code, reason, count: 0, ids: [] });
  }

  /**
   * 1回の送信が成功したあとの syncLastError の扱い。
   * ・受け付けられなかった記録があれば kind: 'rejected'（前の rejected のうち、まだ synced になっていない id も残す。最大10件）
   * ・なければ、前のエラーを消す。ただし前のエラーが rejected なら、今回 synced になった id だけを外し、残りが無くなったら消す
   *   （ほかの記録の成功で、受け付けられなかった記録の知らせが消えないように。件数は T-43 が syncStatus＝error から数えられる）
   */
  function afterSuccess(syncedIds, rejected) {
    const prev = readError();
    const kept = prev && prev.kind === 'rejected'
      ? prev.ids.filter((id) => !syncedIds.has(id) && !rejected.some((r) => r.id === id))
      : [];
    if (rejected.length > 0) {
      const ids = [...rejected.map((r) => r.id).filter((id) => typeof id === 'string' && id !== ''), ...kept].slice(0, MAX_ERROR_IDS)
        .map((id) => id.slice(0, 64));
      writeLastError({ at: now(), kind: 'rejected', code: null, reason: rejected[0].reason ?? null, count: rejected.length + kept.length, ids });
      return;
    }
    if (prev === null) return;
    if (prev.kind === 'rejected' && kept.length > 0) {
      if (kept.length !== prev.ids.length) writeLastError({ ...prev, count: Math.max(kept.length, prev.count - (prev.ids.length - kept.length)), ids: kept });
      return;
    }
    writeLastError(null);
  }

  /**
   * 列の先頭から1回分を送る。続けて送ってよければ true、止めるなら false（残りは pending のまま）。
   */
  async function sendBatch() {
    const config = getConfig();
    if (!config) return false; // 未設定：何もしない（記録は pending のまま。設定したら T-42 の再送で送る）
    const key = keyOf(config);
    if (blockedKey !== null) {
      if (blockedKey === key) return false; // 設定の問題で止めたまま（同じ URL・合言葉）
      blockedKey = null; // URL か合言葉が変わった
    }
    if (!isOnline()) {
      recordFailure('offline');
      return false;
    }
    const ids = [...queue].slice(0, batchSize);
    for (const id of ids) queue.delete(id);
    const trades = (await loadTrades(ids)).filter((t) => t && typeof t.id === 'string' && t.syncStatus !== 'synced');
    if (trades.length === 0) return true;

    const syncedAt = now();
    const records = buildUpsertRecords(trades, syncedAt);
    const out = await upsertToAppsScript({ url: config.url, token: config.token, records, fetchImpl, timeoutMs, isOnline, log });
    if (out.result === 'notConfigured' || out.result === 'aborted') return false;
    if (out.result !== 'ok') {
      recordFailure(out.result, { code: out.code ?? null, reason: out.reason ?? null });
      if (!isTransientSyncFailure(out)) blockedKey = key;
      return false;
    }

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
    return true;
  }

  /** 列が空になるまで1回分ずつ送る */
  async function drain() {
    while (queue.size > 0) {
      if (!(await sendBatch())) {
        queue.clear(); // 止めた：残りの記録は pending のまま（次の変更・T-42 の再送で送る）
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
        // DB の読み書きの失敗など。記録は pending のまま残る。e に URL・合言葉は入らない（ここまで渡していない）
        log.error('スプレッドシートへの送信を中断しました', e);
        queue.clear();
      } finally {
        running = null;
      }
      if (queue.size > 0) kick();
    })();
  }

  /**
   * 記録を送る列に足す（すぐ戻る。送信は今の処理が終わったあとに始まる）。送信中なら、その送信のあとで送る。
   * @param {string[]} ids
   */
  function request(ids) {
    for (const id of ids) if (typeof id === 'string' && id !== '') queue.add(id);
    kick();
  }

  function kick() {
    if (running || scheduled || queue.size === 0) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      start();
    });
  }

  return {
    request,

    /**
     * 未送信（pending・error）の記録をまとめて送る（T-42 の起動時・オンライン復帰時・「今すぐ同期」のための入口）。
     * manual: true（「今すぐ同期」）なら、設定の問題で止めていても送ってみる（sheets-setup 11.5）。
     * @param {{ manual?: boolean }} [opts]
     */
    async requestUnsent({ manual = false } = {}) {
      if (manual) blockedKey = null;
      request(await loadUnsentIds());
    },

    /** 送る列が空になり、送信が終わるまで待つ（テスト・T-42 用） */
    async whenIdle() {
      while (running || scheduled) {
        if (running) await running;
        else await new Promise((resolve) => { setTimeout(resolve, 0); });
      }
    },

    /** 設定の問題で自動の送信を止めているか（T-43 の画面・テスト用） */
    isBlocked: () => blockedKey !== null,
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

/** アプリ本体の送信のしくみ（startAutoSync で1回だけ作る） */
let appSender = null;

/**
 * アプリ本体の自動送信を始める（app.js が起動時に1回呼ぶ）。本物の設定・DB・fetch をつなぐ。
 * 2回目以降は同じものを返す（変更通知を二重に受け取って、同じ記録を2回送らないように）。
 * @returns {ReturnType<typeof createSyncSender>}
 */
export function startAutoSync() {
  if (appSender) return appSender;
  appSender = createSyncSender({
    getConfig: () => readSyncConfig(getSetting('gasUrl'), getSetting('syncToken')),
    loadTrades: (ids) => Promise.all(ids.map((id) => getTrade(id))),
    markResults: (entries) => markSyncResults(entries),
    loadUnsentIds: async () => {
      const lists = await Promise.all(['pending', 'error'].map((s) => getTradesByIndex(INDEX.TRADES_SYNC_STATUS, s)));
      return lists.flat().map((t) => t.id);
    },
    readLastError: () => getSetting('syncLastError'),
    saveLastError: (value) => { setSetting('syncLastError', value); },
  });
  connectSender(appSender);
  return appSender;
}
