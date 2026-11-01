/* =========================================================
   tests/sync-send.test.js
   スプレッドシートへの記録の送信（T-41）と未送信の再送（T-42）のテスト。docs/sheets-setup.md 4.3・6章・10.1・10.3・11.3〜11.5、architecture 3.3・20.2。
   ・SQ-xx：Apps Script との約束（js/sync.js の buildUpsertRecords・classifyUpsertResponse・upsertToAppsScript）。
            要求の形・送り方、応答の振り分け、一時的な失敗の見分け、gas/Code.gs の列の定義との一致、秘密が console に出ないこと
   ・SA-xx：自動送信（js/sync-sender.js）。本物の業務処理（trades.js の createTradeService）を、メモリの中のにせものの DB で動かし、
            にせものの Apps Script（fetch）に送る。送るきっかけ（保存・決済・編集・決済の取り消し・削除・削除の取り消し・画像の削除・
            CSV の取り込み）、送る値が CSV と同じ作り方、結果の反映、送っている間の編集、ループしないこと、1つずつ・20件ずつ、
            未設定のとき送らないこと、設定の問題のとき繰り返さないこと、失敗しても記録が壊れないこと、syncLastError、秘密
   ・SR-xx：未送信の再送（T-42）。起動時・オンライン復帰・前面に戻ったとき（1分おき）・待ってからの再送（30秒・2分・10分）・
            「今すぐ同期」（manual）・接続テストの成功での再開（SS-R02）、二重に送らないこと、送信中に保存した記録の取りこぼし（SS-R01）、
            受け付けられなかった記録の知らせの持ち越し（SS-R03）、受け付けられなかった記録を自動で繰り返さないこと、1分40件（SS-R04）、
            オフラインで記録が壊れないこと、秘密。時計・タイマー・window・document はにせもの（本物の30秒・1分を待たない）
   ・SB-xx：本物の IndexedDB（別名のテスト用 DB）での書き戻し（trades.js の markSyncResults）と、一連の操作、未送信の読み出し（T-42）。ブラウザだけ
   本物の Apps Script には送らない。本物の設定（fxnote:）にも触れない（startAutoSync は呼ばない：本物の URL・合言葉で送ってしまうため）。
   ========================================================= */
import {
  buildUpsertRecords, classifyUpsertResponse, upsertToAppsScript, isTransientSyncFailure, readSyncConfig,
  SYNC_BATCH_SIZE, UPSERT_TIMEOUT_MS, SYNC_RECORDS_PER_MINUTE,
} from '../js/sync.js';
import {
  createSyncSender, connectSender, connectResendTriggers, idsFromChange, sameSheetContent, unsentIdsInOrder, rejectedInfoOf, unsentLoader,
  SYNC_ERROR_KINDS, RESEND_DELAY_MS, VISIBLE_RESEND_INTERVAL_MS, RETRY_DELAYS_MS,
} from '../js/sync-sender.js';
import { sheetRowValues, CSV_COLUMNS, CSV_NUMBER_COLUMNS } from '../js/csv.js';
import { createTradeService, TRADES_CHANGED } from '../js/trades.js';
import { STORE, createDb, MIGRATIONS } from '../js/db.js';
import { DB_VERSION } from '../js/config.js';
import { createSettingsStore } from '../js/settings-store.js';
import { toJstString } from '../js/datetime.js';
import { on } from '../js/events.js';
import { AppError } from '../js/util.js';
import { TEST_DB_PREFIX } from './db.test.js';
import {
  FAKE_URL, FAKE_TOKEN, verdict, readText, fakeFetch, reply, gas, gasError, hangUntilAbort, networkError, fakeLog,
  captureConsole, leaked, fakeStorage,
} from './sync.test.js';

const CATEGORY = 'スプレッドシートへの送信';
const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run });
const tdb = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run, requires: 'indexedDB' });

const tick = () => new Promise((r) => { setTimeout(r, 0); });

/** cond() が true になるまで待つ。limitMs を過ぎたら失敗にする（テストが止まったままにならないように） */
async function waitFor(cond, label, limitMs = 3000) {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > limitMs) throw new Error(`待ちきれませんでした：${label}`);
    await tick();
  }
}

/** Promise を limitMs で打ち切る（送信が終わらないときにテストが止まったままにならないように） */
function withLimit(promise, label, limitMs = 5000) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`終わりませんでした：${label}`)), limitMs); }),
  ]);
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ---------------------------------------------------------
   にせものの DB（メモリの中。db.js の窓口と同じ形の最小限）と時計
   --------------------------------------------------------- */

/**
 * trades.js の createTradeService に渡せる、メモリの中の DB。
 * runTx は途中で失敗したら全部を元に戻す（IndexedDB のトランザクションと同じ）。値は出し入れのたびに写す（構造化複製のまね）。
 */
function memoryDb() {
  const stores = { [STORE.TRADES]: new Map(), [STORE.IMAGES]: new Map(), [STORE.DRAFTS]: new Map() };
  const keyOf = (store, v) => (store === STORE.DRAFTS ? v.key : v.id);
  const ops = {
    get: async (store, key) => clone(stores[store].get(key)) ?? null,
    getAll: async (store) => [...stores[store].values()].map(clone),
    put: async (store, v) => { stores[store].set(keyOf(store, v), clone(v)); },
    add: async (store, v) => {
      if (stores[store].has(keyOf(store, v))) throw new AppError('DUPLICATE', 'すでにあります');
      stores[store].set(keyOf(store, v), clone(v));
    },
    delete: async (store, key) => { stores[store].delete(key); },
  };
  return {
    stores,
    async runTx(names, fn) {
      const backup = Object.fromEntries(Object.entries(stores).map(([k, m]) => [k, new Map(m)]));
      try {
        return await fn(ops);
      } catch (e) {
        for (const [k, m] of Object.entries(backup)) stores[k] = m;
        throw e;
      }
    },
    getTrade: async (id) => clone(stores[STORE.TRADES].get(id)) ?? null,
    getAllTrades: async () => [...stores[STORE.TRADES].values()].map(clone),
    raw: (id) => clone(stores[STORE.TRADES].get(id)),
  };
}

/** 呼ぶたびに1秒進む時計（最初は 2026-10-28T10:00:00+09:00）。frozen なら進まない（同じ秒の中の変更をまねる） */
function makeClock({ frozen = false } = {}) {
  const base = Date.parse('2026-10-28T01:00:00Z');
  let n = 0;
  return () => toJstString(new Date(base + (frozen ? 0 : n++) * 1000));
}

/* ---------------------------------------------------------
   にせものの Apps Script（gas/Code.gs の upsert の答え方をまねる：sheets-setup 6.1・11.4）
   --------------------------------------------------------- */

/**
 * @param {{ decide?: (record, body) => (string|object|null), hold?: (body) => Promise<void>, failWith?: (body) => (object|null) }} [opts]
 *   decide … その記録の結果を決める（'rejected' など。オブジェクトなら結果そのもの）。null ならシートの決まりどおり
 *   hold   … 応答を返す前に待つ（送っている間の操作をまねる）
 *   failWith … 全体のエラーを返すとき、その応答（gasError(...)）
 */
function fakeGas({ decide = () => null, hold = null, failWith = () => null } = {}) {
  const sheet = new Map();
  const bodies = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const f = fakeFetch(async (url, init) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (hold) await hold(body);
      const fail = failWith(body);
      if (fail) return { status: 200, ok: true, text: async () => JSON.stringify(fail) };
      const results = body.records.map((r) => {
        const forced = decide(r, body);
        if (forced && typeof forced === 'object') return forced;
        if (forced) return { id: r.values.id, result: forced, ...(forced === 'rejected' ? { reason: 'FORMULA', column: 'memo' } : {}) };
        const prev = sheet.get(r.values.id);
        if (prev && r.values.updatedAt < prev.updatedAt) return { id: r.values.id, result: 'stale' };
        sheet.set(r.values.id, r.values);
        return { id: r.values.id, result: prev ? 'updated' : 'added' };
      });
      return { status: 200, ok: true, text: async () => JSON.stringify(gas({ action: 'upsert', ok: true, results })) };
    } finally {
      inFlight -= 1;
    }
  });
  f.sheet = sheet;
  f.bodies = bodies;
  f.maxInFlight = () => maxInFlight;
  return f;
}

/* ---------------------------------------------------------
   送信のしくみ一式（本物の業務処理＋にせものの DB・Apps Script・設定）
   --------------------------------------------------------- */

/**
 * @param {{ fetchImpl?: Function, url?: (string|null), token?: (string|null), clock?: Function, batchSize?: number,
 *   isOnline?: () => boolean, log?: object, timeoutMs?: number, wrap?: object }} [opts]
 *   wrap … loadTrades・markResults・saveLastError をわざと失敗させるときの差し替え
 */
/**
 * にせものの時計（ミリ秒）と、待つ・予約するのにせもの（T-42）。
 * sleep は待たずに時計を進める（1分あたりの上限で待った時間を waits に残す）。setTimer は予約を timers に積むだけで、
 * テストが fire() で呼ぶ（本物の30秒・2分・10分を待たない）。
 */
function fakeTime() {
  const time = { ms: 1_000_000, waits: [], timers: [] };
  time.nowMs = () => time.ms;
  time.sleep = async (d) => { time.waits.push(d); time.ms += d; };
  time.setTimer = (fn, ms) => {
    const handle = { fn, ms, cleared: false, fired: false };
    time.timers.push(handle);
    return handle;
  };
  time.clearTimer = (handle) => { if (handle) handle.cleared = true; };
  /** 取り消されていない予約（まだ呼んでいないもの） */
  time.live = () => time.timers.filter((h) => !h.cleared && !h.fired);
  /** いちばん古い予約を呼ぶ（時計もその分進める） */
  time.fire = () => {
    const h = time.live()[0];
    if (!h) return null;
    h.fired = true;
    time.ms += h.ms;
    h.fn();
    return h;
  };
  return time;
}

function setup({
  fetchImpl = fakeGas(), url = FAKE_URL, token = FAKE_TOKEN, clock = makeClock(), batchSize, isOnline = () => true,
  log = fakeLog(), timeoutMs, wrap = {}, time = fakeTime(), recordsPerMinute,
} = {}) {
  const db = memoryDb();
  const svc = createTradeService({ db, now: clock, getLotUnitSize: () => 10000 });
  const cfg = { url, token };
  // syncLastError は本物の settings-store の確かめ方を通す（形が違えば TypeError）。保存場所はにせもの
  const store = createSettingsStore({ storage: fakeStorage(), prefix: 'fxnote-test:' });
  const unsentLoads = [];
  const deps = {
    getConfig: () => readSyncConfig(cfg.url, cfg.token),
    loadTrades: (ids) => Promise.all(ids.map((id) => svc.getTrade(id))),
    markResults: (entries) => svc.markSyncResults(entries),
    // 本物（startAutoSync）と同じ：自動は pending だけ、「今すぐ同期」は error も。作った順に並べる
    loadUnsentIds: async ({ includeErrors } = {}) => {
      unsentLoads.push(Boolean(includeErrors));
      const statuses = includeErrors ? ['pending', 'error'] : ['pending'];
      return unsentIdsInOrder((await svc.getAllTrades()).filter((x) => statuses.includes(x.syncStatus)));
    },
    readLastError: () => store.get('syncLastError'),
    saveLastError: (v) => { store.set('syncLastError', v); },
  };
  const sender = createSyncSender({
    ...deps, ...wrap, now: clock, fetchImpl, isOnline, log, batchSize, timeoutMs, recordsPerMinute,
    nowMs: time.nowMs, sleep: time.sleep, setTimer: time.setTimer, clearTimer: time.clearTimer,
  });
  const events = [];
  const offEvents = on(TRADES_CHANGED, (d) => events.push(d));
  const off = connectSender(sender);
  return {
    db, svc, sender, cfg, store, fetchImpl, log, events, time, unsentLoads,
    lastError: () => store.get('syncLastError'),
    idle: () => withLimit(sender.whenIdle(), '送信'),
    cleanup() { off(); offEvents(); },
  };
}

/** 新しい記録の入力（保有中） */
const entry = (n, over = {}) => ({
  id: uuid(n), accountType: 'real', pair: 'USD/JPY', side: 'buy', entryPrice: 150.123, entryAt: '2026-10-15T21:30:00+09:00', lots: 0.5,
  slPrice: 149.9, tpPrice: 150.6, tags: ['指標前'], memo: 'メモ, "引用"\n2行目', ...over,
});

/** CSV の取り込みに渡す32項目の記録 */
const importedRow = (n, over = {}) => ({
  id: uuid(n), accountType: 'demo', pair: 'EUR/USD', side: 'sell', entryPrice: 1.08512, entryAt: '2026-10-16T17:00:00+09:00',
  lots: 1, lotUnitSize: 10000, slPrice: null, tpPrice: null, riskReward: null, exitPrice: null, exitAt: null, pips: null,
  profitJpy: null, profitSource: null, quoteToJpyRate: null, status: 'open', entryReasons: ['ブレイクアウト'], timeframe: null,
  session: 'london', emotion: '=焦り', exitReason: null, exitEmotion: null, tags: [], memo: null, imageIds: [],
  syncStatus: 'pending', syncedAt: null, deletedAt: null,
  createdAt: '2026-10-16T17:00:10+09:00', updatedAt: '2026-10-16T17:00:10+09:00', ...over,
});

/** 直前の送信の中身（最後の要求の records） */
const lastRecords = (f) => (f.bodies.length ? f.bodies[f.bodies.length - 1].records : []);

/* ---------------------------------------------------------
   SQ：Apps Script との約束
   --------------------------------------------------------- */

function protocolTests() {
  return [
    t('SQ-01', '送る記録の組み立て：値は sheetRowValues（CSV と同じ作り方）、価格の小数桁（JPY は 3、それ以外は 5）を添える',
      'USD/JPY・EUR/USD・通貨ペアが壊れた記録', 'records[i] = { priceDecimals, values }、送る時刻は全件同じ。壊れたペアでも例外にしない',
      () => {
        const at = '2026-10-28T10:00:00+09:00';
        const trades = [importedRow(1, { pair: 'USD/JPY', entryPrice: 150.1 }), importedRow(2), importedRow(3, { pair: null })];
        const recs = buildUpsertRecords(trades, at);
        return verdict([
          ['件数', recs.length === 3, recs.length],
          ['USD/JPY は 3', recs[0].priceDecimals === 3, recs[0].priceDecimals],
          ['EUR/USD は 5', recs[1].priceDecimals === 5, recs[1].priceDecimals],
          ['値は sheetRowValues と同じ', recs.every((r, i) => deepEqual(r.values, sheetRowValues(trades[i], { syncedAt: at }))), ''],
          ['送る時刻・synced', recs.every((r) => r.values.syncedAt === at && r.values.syncStatus === 'synced'), ''],
          ['壊れたペアは桁を添えない（Apps Script が補う）', recs[2].priceDecimals === undefined || [3, 5].includes(recs[2].priceDecimals), recs[2].priceDecimals],
          ['キーは priceDecimals と values だけ', recs.every((r) => Object.keys(r).every((k) => k === 'priceDecimals' || k === 'values')), Object.keys(recs[0])],
        ]);
      }),

    t('SQ-02', '送り方：接続テストと同じ（POST・headers なし・redirect: follow・credentials: omit・cache: no-store）。本文は { app, v, token, action: "upsert", records }',
      '2件を送る', 'sheets-setup 11.3。fetch は1回、URL は保存済みの URL、records はそのまま',
      async () => {
        const f = reply(gas({ action: 'upsert', ok: true, results: [{ id: uuid(1), result: 'added' }, { id: uuid(2), result: 'updated' }] }));
        const records = buildUpsertRecords([importedRow(1), importedRow(2)], '2026-10-28T10:00:00+09:00');
        const out = await upsertToAppsScript({ url: FAKE_URL, token: FAKE_TOKEN, records, fetchImpl: f, isOnline: () => true, log: fakeLog() });
        const { url, init } = f.calls[0] || {};
        let body = null;
        try { body = JSON.parse(init.body); } catch (e) { /* 下で不合格 */ }
        return verdict([
          ['1回だけ', f.calls.length === 1, f.calls.length],
          ['保存済みの URL', url === FAKE_URL, ''],
          ['POST・headers なし', init.method === 'POST' && !('headers' in init), Object.keys(init).join(',')],
          ['redirect・credentials・cache', init.redirect === 'follow' && init.credentials === 'omit' && init.cache === 'no-store', ''],
          ['本文は文字', typeof init.body === 'string', typeof init.body],
          ['本文のキー', body && Object.keys(body).join(',') === 'app,v,token,action,records', body ? Object.keys(body).join(',') : '読めない'],
          ['app・v・token・action', body && body.app === 'fx-trade-note' && body.v === 1 && body.token === FAKE_TOKEN && body.action === 'upsert', ''],
          ['records はそのまま', body && deepEqual(body.records, records), ''],
          ['結果', out.result === 'ok' && out.results.map((r) => r.result).join() === 'added,updated', out],
          ['既定の時間切れは60秒・1回20件', UPSERT_TIMEOUT_MS === 60000 && SYNC_BATCH_SIZE === 20, `${UPSERT_TIMEOUT_MS}/${SYNC_BATCH_SIZE}`],
        ]);
      }),

    t('SQ-03', '応答の振り分け（sheets-setup 11.4・11.5）：ok の results は送った順・同じ id のときだけ受け取る',
      '成功・rejected（理由つき・id が null・64文字で切られた id）・数が違う・id が違う・知らない result・ok だが ping の答え・BAD_TOKEN・ほかのコード・JSON でない・app なし',
      'ok／badResponse／badToken／scriptError／notApp',
      () => {
        const ids = [uuid(1), uuid(2)];
        const up = (results) => JSON.stringify(gas({ action: 'upsert', ok: true, results }));
        const longId = 'x'.repeat(70);
        const cases = [
          ['成功', up([{ id: ids[0], result: 'added' }, { id: ids[1], result: 'stale' }]), ids, 'ok'],
          ['rejected（理由つき）', up([{ id: ids[0], result: 'rejected', reason: 'FORMULA', column: 'memo' }, { id: ids[1], result: 'updated', duplicate: true }]), ids, 'ok'],
          ['rejected の id が null', up([{ id: null, result: 'rejected', reason: 'BAD_ID' }]), [ids[0]], 'ok'],
          ['rejected の id が64文字で切られた', up([{ id: longId.slice(0, 64), result: 'rejected', reason: 'BAD_ID' }]), [longId], 'ok'],
          ['数が違う', up([{ id: ids[0], result: 'added' }]), ids, 'badResponse'],
          ['id が違う', up([{ id: ids[1], result: 'added' }, { id: ids[0], result: 'added' }]), ids, 'badResponse'],
          ['added なのに id が null', up([{ id: null, result: 'added' }]), [ids[0]], 'badResponse'],
          ['知らない result', up([{ id: ids[0], result: 'written' }]), [ids[0]], 'badResponse'],
          ['results が無い', JSON.stringify(gas({ action: 'upsert', ok: true })), [ids[0]], 'badResponse'],
          ['ok だが ping の答え', JSON.stringify(gas({ action: 'ping', ok: true })), [ids[0]], 'badResponse'],
          ['BAD_TOKEN', JSON.stringify(gasError('BAD_TOKEN')), ids, 'badToken'],
          ['HEADER_MISMATCH', JSON.stringify(gas({ action: 'upsert', ok: false, error: { code: 'HEADER_MISMATCH', column: 'C' } })), ids, 'scriptError'],
          ['BUSY', JSON.stringify(gas({ action: 'upsert', ok: false, error: { code: 'BUSY' } })), ids, 'scriptError'],
          ['JSON でない', '<html>sign in</html>', ids, 'notApp'],
          ['app なし', JSON.stringify({ ok: true, action: 'upsert', results: [] }), [], 'notApp'],
        ];
        const checks = cases.map(([label, text, sent, want]) => {
          const r = classifyUpsertResponse(text, sent);
          return [`${label} → ${want}`, r.result === want, r.result];
        });
        const rej = classifyUpsertResponse(cases[1][1], ids);
        checks.push(['rejected の理由を覚える（英大文字のコードだけ）', rej.results[0].reason === 'FORMULA' && rej.results[1].reason === null, rej.results]);
        const odd = classifyUpsertResponse(up([{ id: ids[0], result: 'rejected', reason: `${FAKE_URL}` }]), [ids[0]]);
        checks.push(['変な理由は null', odd.results[0].reason === null, odd.results[0].reason]);
        const api = classifyUpsertResponse(JSON.stringify(gasError('INTERNAL', { reason: 'SHEETS_API_NOT_ADDED' })), ids);
        checks.push(['SHEETS_API_NOT_ADDED', api.result === 'scriptError' && api.code === 'INTERNAL' && api.reason === 'SHEETS_API_NOT_ADDED', api]);
        return verdict(checks);
      }),

    t('SQ-04', '通信の失敗と「一時的な失敗」の見分け（sheets-setup 11.5 の推奨）',
      'オフライン・届かない・HTTP 500・時間切れ・各エラーコード', '一時的：offline・timeout・unreachable・BUSY・INTERNAL（SHEETS_API_NOT_ADDED 以外）。ほかは設定の問題',
      async () => {
        const records = buildUpsertRecords([importedRow(1)], '2026-10-28T10:00:00+09:00');
        const send = (fetchImpl, opts = {}) => upsertToAppsScript({ url: FAKE_URL, token: FAKE_TOKEN, records, fetchImpl, isOnline: () => true, log: fakeLog(), ...opts });
        const results = {
          unreachable: (await send(networkError())).result,
          offline: (await send(networkError(), { isOnline: () => false })).result,
          http500: (await send(reply('error', 500))).result,
          timeout: (await send(hangUntilAbort(), { timeoutMs: 30 })).result,
        };
        const table = [
          [{ result: 'offline' }, true], [{ result: 'timeout' }, true], [{ result: 'unreachable' }, true],
          [{ result: 'scriptError', code: 'BUSY' }, true], [{ result: 'scriptError', code: 'INTERNAL', reason: null }, true],
          [{ result: 'scriptError', code: 'INTERNAL', reason: 'SHEETS_API_NOT_ADDED' }, false],
          [{ result: 'badToken', code: 'BAD_TOKEN' }, false], [{ result: 'notApp' }, false], [{ result: 'badResponse' }, false],
          ...['TOKEN_NOT_SET', 'HEADER_MISMATCH', 'NO_SPREADSHEET', 'UNSUPPORTED_VERSION', 'BAD_REQUEST', 'TOO_LARGE', null].map((code) => [{ result: 'scriptError', code }, false]),
        ];
        return verdict([
          ['届かない → unreachable', results.unreachable === 'unreachable', results.unreachable],
          ['オフライン → offline', results.offline === 'offline', results.offline],
          ['HTTP 500 → unreachable', results.http500 === 'unreachable', results.http500],
          ['時間切れ → timeout', results.timeout === 'timeout', results.timeout],
          ...table.map(([out, want]) => [`${out.result}${out.code ? ` ${out.code}` : ''}${out.reason ? `/${out.reason}` : ''} → ${want ? '一時的' : '設定の問題'}`, isTransientSyncFailure(out) === want, isTransientSyncFailure(out)]),
        ]);
      }),

    t('SQ-05', 'URL・合言葉が入力チェックを通らないときは送らない（SY-R02）', '/dev・11文字・空・null', 'notConfigured・fetch は呼ばれない',
      async () => {
        const f = reply(gas({ action: 'upsert', ok: true, results: [] }));
        const records = buildUpsertRecords([importedRow(1)], '2026-10-28T10:00:00+09:00');
        const outs = [];
        for (const [url, token] of [[FAKE_URL.replace('/exec', '/dev'), FAKE_TOKEN], [FAKE_URL, 'abcdefghijk'], ['', FAKE_TOKEN], [FAKE_URL, null]]) {
          outs.push((await upsertToAppsScript({ url, token, records, fetchImpl: f, isOnline: () => true, log: fakeLog() })).result);
        }
        return verdict([
          ['どれも notConfigured', outs.every((r) => r === 'notConfigured'), outs],
          ['fetch は呼ばれない', f.calls.length === 0, f.calls.length],
        ]);
      }),

    t('SQ-06', 'アプリの列の定義が gas/Code.gs と同じ（見出し32列の並び・数値の列・1回の上限）',
      'gas/Code.gs の COLUMN_DEFS・MAX_RECORDS', '見出しは CSV_COLUMNS と同じ並び、文字・日時・ID 以外の列＝CSV_NUMBER_COLUMNS、SYNC_BATCH_SIZE ≦ MAX_RECORDS',
      async () => {
        const code = await readText('gas/Code.gs');
        const block = (code.match(/const COLUMN_DEFS = \[([\s\S]*?)\n\];/) || [])[1] || '';
        const defs = [...block.matchAll(/\['(\w+)', '([^']+)'/g)].map((m) => [m[1], m[2]]);
        const numbers = defs.filter(([, kind]) => !['id', 'text', 'datetime'].includes(kind)).map(([name]) => name);
        const max = Number((code.match(/const MAX_RECORDS = (\d+);/) || [])[1]);
        return verdict([
          ['32列', defs.length === 32, defs.length],
          ['見出しの並び', defs.map(([n]) => n).join() === CSV_COLUMNS.join(), defs.map(([n]) => n).join()],
          ['数値の列', numbers.join() === CSV_NUMBER_COLUMNS.join(), numbers.join()],
          ['1回の件数は上限以内', SYNC_BATCH_SIZE <= max, `${SYNC_BATCH_SIZE}/${max}`],
        ]);
      }),

    t('SQ-07', 'URL・合言葉・要求と応答の本文が console に出ない（送信の全部の結果の種類で）',
      '成功（rejected あり）・本文に合言葉を含む BAD_TOKEN・URL と合言葉入りの例外・HTML・時間切れ・オフライン', 'console に出た文字に URL・合言葉・応答の本文・送った値が入らない。結果の種類と件数だけ',
      async () => {
        const records = buildUpsertRecords([importedRow(1, { memo: '送った値のメモ' })], '2026-10-28T10:00:00+09:00');
        const echo = { ...gasError('BAD_TOKEN'), error: { code: 'BAD_TOKEN', message: `応答の本文 ${FAKE_TOKEN} ${FAKE_URL}` } };
        const scenarios = [
          () => reply(gas({ action: 'upsert', ok: true, results: [{ id: uuid(1), result: 'rejected', reason: 'FORMULA', column: 'memo' }] })),
          () => reply(echo),
          () => reply(`<html>${FAKE_URL} ${FAKE_TOKEN}</html>`),
          networkError,
          hangUntilAbort,
        ];
        const results = [];
        const logged = await captureConsole(async () => {
          for (const make of scenarios) {
            results.push((await upsertToAppsScript({ url: FAKE_URL, token: FAKE_TOKEN, records, fetchImpl: make(), isOnline: () => true, timeoutMs: 30 })).result);
          }
          results.push((await upsertToAppsScript({ url: FAKE_URL, token: FAKE_TOKEN, records, fetchImpl: networkError(), isOnline: () => false })).result);
        });
        const bad = leaked(logged, [FAKE_URL, FAKE_TOKEN, 'FAKE-DEPLOYMENT-ID', '応答の本文', '送った値のメモ']);
        return verdict([
          ['シナリオがすべて動いた', results.join(',') === 'ok,badToken,notApp,unreachable,timeout,offline', results.join(',')],
          ['結果の種類は出る', logged.length === results.length, logged.length],
          ['秘密・本文が出ない', bad.length === 0, bad.join(' | ')],
        ]);
      }),
  ];
}

/* ---------------------------------------------------------
   SA：自動送信（本物の業務処理＋メモリの DB）
   --------------------------------------------------------- */

/** 送ったあとの記録の確認：synced・syncedAt は送る時刻・updatedAt は操作のときのまま・送った値は記録のシートの値と同じ */
function syncedChecks(label, s, id, updatedAt) {
  const stored = s.db.raw(id);
  const recs = lastRecords(s.fetchImpl);
  const sent = recs.find((r) => r.values.id === id);
  return [
    [`${label}：送った`, Boolean(sent), recs.map((r) => r.values.id)],
    [`${label}：synced`, stored.syncStatus === 'synced', stored.syncStatus],
    [`${label}：syncedAt は送る時刻`, sent && stored.syncedAt === sent.values.syncedAt, `${stored.syncedAt} / ${sent && sent.values.syncedAt}`],
    [`${label}：updatedAt は変えない`, stored.updatedAt === updatedAt, `${stored.updatedAt} / ${updatedAt}`],
    [`${label}：送った値＝記録をシートの形にしたもの（32列とも同じ）`, sent && deepEqual(sent.values, sheetRowValues(stored, { syncedAt: stored.syncedAt })), ''],
  ];
}

function senderTests() {
  return [
    t('SA-01', '送るきっかけ：保存・決済・編集・決済の取り消し・画像の削除・削除・削除の取り消し・CSV の取り込みのたびに、その記録を1回送る',
      '本物の業務処理で順に操作（にせものの Apps Script）', '操作ごとに fetch が1回増え、その記録が synced・syncedAt＝送る時刻・updatedAt はそのまま・送った値は記録と同じ',
      async () => {
        const s = setup();
        try {
          const checks = [];
          const step = async (label, run, ids) => {
            const before = s.fetchImpl.calls.length;
            const result = await run();
            const updatedAt = Object.fromEntries(ids.map((id) => [id, s.db.raw(id).updatedAt])); // 送る前（操作の直後）の updatedAt
            const pending = ids.every((id) => s.db.raw(id).syncStatus === 'pending');
            await s.idle();
            checks.push([`${label}：操作の直後は pending`, pending, '']);
            checks.push([`${label}：fetch は1回`, s.fetchImpl.calls.length === before + 1, s.fetchImpl.calls.length - before]);
            for (const id of ids) checks.push(...syncedChecks(label, s, id, updatedAt[id]));
            return result;
          };
          // 画像つきの記録（画像は先に images にある前提：architecture 11.5）
          await s.db.runTx([STORE.IMAGES], async (ops) => { await ops.put(STORE.IMAGES, { id: 'img-1', tradeId: uuid(1) }); });
          const a = await step('保存', () => s.svc.saveNewTrade(entry(1, { imageIds: ['img-1'] })), [uuid(1)]);
          checks.push(['保存：imageCount は1', lastRecords(s.fetchImpl)[0].values.imageCount === 1, lastRecords(s.fetchImpl)[0].values.imageCount]);
          const closed = await step('決済', () => s.svc.closeTrade(a.id, { exitPrice: 150.4, exitAt: '2026-10-15T23:00:00+09:00', exitReason: 'tp' }), [uuid(1)]);
          checks.push(['決済：決済の値を送った', lastRecords(s.fetchImpl)[0].values.exitPrice === 150.4 && lastRecords(s.fetchImpl)[0].values.status === 'closed', '']);
          const edited = await step('編集', () => s.svc.saveTrade({ ...s.db.raw(a.id), memo: '=直した' }, { expectedUpdatedAt: closed.updatedAt }), [uuid(1)]);
          checks.push(['編集：数式になりうるメモに印', lastRecords(s.fetchImpl)[0].values.memo === "'=直した", lastRecords(s.fetchImpl)[0].values.memo]);
          checks.push(['編集：編集を始めたときの updatedAt で保存できた（同期が updatedAt を変えていない）', edited.memo === '=直した', '']);
          await step('決済の取り消し', () => s.svc.reopenTrade(a.id), [uuid(1)]);
          checks.push(['決済の取り消し：決済の列は空', lastRecords(s.fetchImpl)[0].values.exitPrice === null && lastRecords(s.fetchImpl)[0].values.exitAt === '', '']);
          await step('画像の削除', () => s.svc.removeTradeImage(a.id, 'img-1'), [uuid(1)]);
          checks.push(['画像の削除：imageCount は0', lastRecords(s.fetchImpl)[0].values.imageCount === 0, '']);
          const del = await step('削除', () => s.svc.deleteTrade(a.id), [uuid(1)]);
          checks.push(['削除：deletedAt を送った', lastRecords(s.fetchImpl)[0].values.deletedAt === del.deletedAt, '']);
          await step('削除の取り消し', () => s.svc.undoDeleteTrade(a.id, del.deletedAt), [uuid(1)]);
          checks.push(['削除の取り消し：deletedAt は空', lastRecords(s.fetchImpl)[0].values.deletedAt === '', '']);
          await step('CSV の取り込み（2件を1回で）', () => s.svc.importTrades([importedRow(2), importedRow(3, { deletedAt: '2026-10-17T09:00:00+09:00', updatedAt: '2026-10-17T09:00:00+09:00' })], { snapshot: new Map() }), [uuid(2), uuid(3)]);
          checks.push(['CSV の取り込み：2件・削除済みも送る', lastRecords(s.fetchImpl).length === 2, lastRecords(s.fetchImpl).length]);
          checks.push(['にせもののシートは2行＋1行（削除済みも行として残る）', s.fetchImpl.sheet.size === 3, s.fetchImpl.sheet.size]);
          return verdict(checks);
        } finally { s.cleanup(); }
      }),

    t('SA-02', 'URL・合言葉が未設定（または入力チェックを通らない）なら何も送らない。記録は pending のまま。設定したら次の変更から送る',
      'URL なし・合言葉なし・/dev の URL・11文字の合言葉で保存 → 正しく設定して別の記録を保存', 'fetch は0回・pending・syncLastError なし → 設定後は1回',
      async () => {
        const checks = [];
        for (const [label, url, token] of [['URL なし', null, FAKE_TOKEN], ['合言葉なし', FAKE_URL, null], ['/dev', FAKE_URL.replace('/exec', '/dev'), FAKE_TOKEN], ['11文字', FAKE_URL, 'abcdefghijk']]) {
          const s = setup({ url, token });
          try {
            await s.svc.saveNewTrade(entry(1));
            await s.idle();
            checks.push([`${label}：送らない`, s.fetchImpl.calls.length === 0, s.fetchImpl.calls.length]);
            checks.push([`${label}：pending のまま`, s.db.raw(uuid(1)).syncStatus === 'pending', s.db.raw(uuid(1)).syncStatus]);
            checks.push([`${label}：syncLastError なし`, s.lastError() === null, s.lastError()]);
            s.cfg.url = FAKE_URL;
            s.cfg.token = FAKE_TOKEN;
            await s.svc.saveNewTrade(entry(2));
            await s.idle();
            checks.push([`${label}：設定後は送る（その記録だけ。前の記録の再送は T-42）`, s.fetchImpl.calls.length === 1 && lastRecords(s.fetchImpl)[0].values.id === uuid(2), s.fetchImpl.calls.length]);
          } finally { s.cleanup(); }
        }
        return verdict(checks);
      }),

    t('SA-03', '結果の反映：added・updated・stale → synced、rejected → error（syncLastError に件数と id）。あとで受け付けられたら消える',
      '3件を1回で送り、1件目 stale・2件目 rejected（FORMULA）・3件目 added → 2件目を直して送り直す',
      'stale と added は synced、rejected は error（syncedAt は前のまま）、syncLastError＝rejected・1件・id。直して受け付けられると null',
      async () => {
        const reject = new Set([uuid(2)]);
        const f = fakeGas({ decide: (r) => (r.values.id === uuid(1) ? 'stale' : reject.has(r.values.id) ? 'rejected' : null) });
        const s = setup({ fetchImpl: f });
        try {
          await s.svc.importTrades([importedRow(1), importedRow(2), importedRow(3)], { snapshot: new Map() });
          await s.idle();
          const [a, b, c] = [1, 2, 3].map((n) => s.db.raw(uuid(n)));
          const err = s.lastError();
          // ほかの記録の成功では、受け付けられなかった知らせは消えない
          await s.svc.saveNewTrade(entry(4));
          await s.idle();
          const errKept = s.lastError();
          reject.delete(uuid(2));
          await s.svc.saveTrade({ ...s.db.raw(uuid(2)), memo: '直した' });
          await s.idle();
          return verdict([
            ['stale → synced', a.syncStatus === 'synced', a.syncStatus],
            ['rejected → error', b.syncStatus === 'error' && b.syncedAt === null, `${b.syncStatus}/${b.syncedAt}`],
            ['added → synced', c.syncStatus === 'synced', c.syncStatus],
            ['syncLastError', err && err.kind === 'rejected' && err.count === 1 && err.ids.join() === uuid(2) && err.reason === 'FORMULA' && SYNC_ERROR_KINDS.includes(err.kind), err],
            ['ほかの記録の成功では消えない', errKept && errKept.kind === 'rejected', errKept],
            ['直して受け付けられた → synced', s.db.raw(uuid(2)).syncStatus === 'synced', s.db.raw(uuid(2)).syncStatus],
            ['syncLastError は消える', s.lastError() === null, s.lastError()],
          ]);
        } finally { s.cleanup(); }
      }),

    t('SA-04', '送っている間に編集された記録は synced にしない（architecture 20.2）。その変更で送り直して synced になる',
      '保存 → 応答を待たせている間に決済 → 応答', '1回目の応答のあとも pending、2回目で決済の値を送って synced。updatedAt は決済のときのまま',
      async () => {
        let release;
        let first = true;
        const seen = [];
        const s0 = { db: null };
        const f = fakeGas({
          hold: async (body) => {
            seen.push(s0.db ? s0.db.raw(uuid(1)).syncStatus : null);
            if (first) { first = false; await new Promise((r) => { release = r; }); }
          },
        });
        const s = setup({ fetchImpl: f });
        s0.db = s.db;
        try {
          await s.svc.saveNewTrade(entry(1));
          await waitFor(() => release, '1回目の送信'); // 1回目が届くまで
          const closed = await s.svc.closeTrade(uuid(1), { exitPrice: 150.4, exitAt: '2026-10-15T23:00:00+09:00' });
          release();
          await s.idle();
          const stored = s.db.raw(uuid(1));
          return verdict([
            ['2回送った', f.calls.length === 2, f.calls.length],
            ['2回目を送るとき（1回目の応答のあと）は pending のまま', seen[1] === 'pending', seen],
            ['2回目は決済の値', f.bodies[1].records[0].values.status === 'closed', f.bodies[1].records[0].values.status],
            ...syncedChecks('最後', s, uuid(1), closed.updatedAt),
          ]);
        } finally { s.cleanup(); }
      }),

    t('SA-05', '同じ秒の中の変更（updatedAt が同じ）でも synced にしない：削除を送っている間に「取り消す」（R-05）',
      '時計を止めて、削除 → 応答を待たせている間に削除の取り消し → 応答', '1回目（削除済み）の応答では synced にせず、取り消しの内容を送り直す。シートの deletedAt は空',
      async () => {
        let release = null;
        let holdNext = false;
        const f = fakeGas({ hold: async () => { if (holdNext) { holdNext = false; await new Promise((r) => { release = r; }); } } });
        const s = setup({ fetchImpl: f, clock: makeClock({ frozen: true }) });
        try {
          await s.svc.saveNewTrade(entry(1));
          await s.idle();
          holdNext = true;
          const del = await s.svc.deleteTrade(uuid(1));
          await waitFor(() => release, '削除の送信');
          const restored = await s.svc.undoDeleteTrade(uuid(1), del.deletedAt);
          const sameSecond = restored.updatedAt === del.updatedAt;
          release();
          await s.idle();
          const stored = s.db.raw(uuid(1));
          return verdict([
            ['updatedAt は同じ秒（見分けられない）', sameSecond, `${del.updatedAt}/${restored.updatedAt}`],
            ['3回送った（保存・削除・取り消し）', f.calls.length === 3, f.calls.length],
            ['最後は取り消した内容', f.bodies[2].records[0].values.deletedAt === '', f.bodies[2].records[0].values.deletedAt],
            ['シートの行も削除済みでない', f.sheet.get(uuid(1)).deletedAt === '', f.sheet.get(uuid(1)).deletedAt],
            ['記録は synced（シートと同じ内容）', stored.syncStatus === 'synced' && stored.deletedAt === null, `${stored.syncStatus}/${stored.deletedAt}`],
          ]);
        } finally { s.cleanup(); }
      }),

    t('SA-06', 'ループしない：書き戻しは変更通知を出さず、送信は操作1回につき1回だけ',
      '保存 → 送信 → 書き戻し → しばらく待つ', "'trades-changed' は保存の1回だけ、fetch も1回。markSyncResults を直接呼んでも通知は出ない。知らない種類の通知では送らない",
      async () => {
        const s = setup();
        try {
          await s.svc.saveNewTrade(entry(1));
          await s.idle();
          for (let i = 0; i < 5; i += 1) await tick();
          await s.idle();
          const eventsAfter = s.events.length;
          const callsAfter = s.fetchImpl.calls.length;
          const stored = s.db.raw(uuid(1));
          await s.svc.markSyncResults([{ id: uuid(1), updatedAt: stored.updatedAt, syncStatus: 'error' }]);
          await tick();
          await s.idle();
          return verdict([
            ['通知は保存の1回だけ', eventsAfter === 1 && s.events[0].type === 'add', s.events.map((e) => e.type)],
            ['fetch は1回', callsAfter === 1, callsAfter],
            ['書き戻しでは通知が出ない', s.events.length === 1, s.events.length],
            ['書き戻しのあとも送らない', s.fetchImpl.calls.length === 1, s.fetchImpl.calls.length],
            ['知らない種類・壊れた通知は送らない', [null, undefined, { type: 'synced', id: uuid(1) }, { type: 'imported', ids: 'x' }, { type: 'add', id: 1 }, { type: 'add' }]
              .every((d) => idsFromChange(d).length === 0), ''],
            ['取り込みは ids をまとめて', idsFromChange({ type: 'imported', ids: [uuid(1), '', uuid(2)] }).join() === `${uuid(1)},${uuid(2)}`, ''],
          ]);
        } finally { s.cleanup(); }
      }),

    t('SA-07', '同時に1つずつ・1回20件まで：45件の取り込みは20件ずつ順に送る。送っている間の保存は、列の最後に足して送る',
      'CSV の取り込み45件（応答を少し遅らせる）＋1回目を送っている間に1件保存', '同時に送るのは最大1つ、件数は 20,20,6（最後に保存の1件）、全部 synced',
      async () => {
        const f = fakeGas({ hold: () => new Promise((r) => { setTimeout(r, 5); }) });
        const s = setup({ fetchImpl: f });
        try {
          const rows = Array.from({ length: 45 }, (_, i) => importedRow(100 + i));
          await s.svc.importTrades(rows, { snapshot: new Map() });
          await waitFor(() => f.calls.length > 0, '最初の送信');
          await s.svc.saveNewTrade(entry(1));
          await s.idle();
          const all = await s.svc.getAllTrades();
          return verdict([
            ['同時に送るのは1つ', f.maxInFlight() === 1, f.maxInFlight()],
            ['件数', f.bodies.map((b) => b.records.length).join() === '20,20,6', f.bodies.map((b) => b.records.length).join()],
            ['1分に40件まで：3回目は1回目から1分たつまで待った（T-42・SS-R04）', SYNC_RECORDS_PER_MINUTE === 40 && s.time.waits.length === 1 && s.time.waits[0] === 60000, s.time.waits],
            ['取り込んだ順に送り、保存した1件は最後', f.bodies.flatMap((b) => b.records.map((r) => r.values.id)).join() === [...rows.map((r) => r.id), uuid(1)].join(), ''],
            ['全部 synced', all.length === 46 && all.every((x) => x.syncStatus === 'synced'), all.filter((x) => x.syncStatus !== 'synced').length],
          ]);
        } finally { s.cleanup(); }
      }),

    t('SA-08', '設定の問題（合言葉違いなど）：syncLastError に残し、同じ URL・合言葉のままでは自動で送り直さない。変えたら送る',
      'BAD_TOKEN・TOKEN_NOT_SET・HEADER_MISMATCH・SHEETS_API_NOT_ADDED・このアプリ用でない応答 → もう1件保存 → 合言葉を変えて保存',
      '記録は pending、syncLastError は kind・code、次の保存では送らない、合言葉を変えると送って成功し syncLastError は消える。「今すぐ同期」（manual）でも送る',
      async () => {
        const checks = [];
        const cases = [
          ['BAD_TOKEN', gasError('BAD_TOKEN'), 'badToken', 'BAD_TOKEN', null],
          ['TOKEN_NOT_SET', gasError('TOKEN_NOT_SET'), 'scriptError', 'TOKEN_NOT_SET', null],
          ['HEADER_MISMATCH', gas({ action: 'upsert', ok: false, error: { code: 'HEADER_MISMATCH', column: 'C' } }), 'scriptError', 'HEADER_MISMATCH', null],
          ['SHEETS_API_NOT_ADDED', gasError('INTERNAL', { reason: 'SHEETS_API_NOT_ADDED' }), 'scriptError', 'INTERNAL', 'SHEETS_API_NOT_ADDED'],
          ['このアプリ用でない', '<!doctype html>', 'notApp', null, null],
        ];
        for (const [label, answer, kind, code, reason] of cases) {
          let broken = true;
          const good = fakeGas();
          const f = fakeFetch((url, init) => (broken ? reply(answer)(url, init) : good(url, init)));
          const s = setup({ fetchImpl: f });
          try {
            await s.svc.saveNewTrade(entry(1));
            await s.idle();
            const err = s.lastError();
            checks.push([`${label}：pending のまま`, s.db.raw(uuid(1)).syncStatus === 'pending', s.db.raw(uuid(1)).syncStatus]);
            checks.push([`${label}：syncLastError`, err && err.kind === kind && err.code === code && err.reason === reason && err.ids.length === 0, err]);
            checks.push([`${label}：止めている`, s.sender.isBlocked(), s.sender.isBlocked()]);
            await s.svc.saveNewTrade(entry(2));
            await s.idle();
            checks.push([`${label}：同じ設定では次の保存でも送らない`, f.calls.length === 1, f.calls.length]);
            broken = false;
            if (label === 'BAD_TOKEN') {
              s.cfg.token = `${FAKE_TOKEN}-new`;
              await s.svc.saveNewTrade(entry(3));
              await s.idle();
              checks.push([`${label}：合言葉を変えると送る`, f.calls.length === 2 && s.db.raw(uuid(3)).syncStatus === 'synced', f.calls.length]);
              checks.push([`${label}：成功で syncLastError は消える`, s.lastError() === null, s.lastError()]);
            } else {
              await s.sender.requestUnsent({ manual: true });
              await s.idle();
              const all = await s.svc.getAllTrades();
              checks.push([`${label}：「今すぐ同期」（manual）なら未送信をまとめて送る`, f.calls.length === 2 && all.every((x) => x.syncStatus === 'synced'), f.calls.length]);
            }
          } finally { s.cleanup(); }
        }
        return verdict(checks);
      }),

    t('SA-09', '一時的な失敗（オフライン・届かない・時間切れ・BUSY）：syncLastError に残し、記録は pending。止めずに次の保存でまた送る',
      'navigator.onLine が false／fetch が失敗／応答なし（30ms で打ち切り）／BUSY → 直ってから次の保存', '記録は pending・内容は変わらない、次の保存では送って成功',
      async () => {
        const checks = [];
        const cases = [
          ['オフライン', { isOnline: () => false }, 'offline', 0],
          ['届かない', { fetchImpl: networkError() }, 'unreachable', 1],
          ['時間切れ', { fetchImpl: hangUntilAbort(), timeoutMs: 30 }, 'timeout', 1],
          ['BUSY', { fetchImpl: reply(gas({ action: 'upsert', ok: false, error: { code: 'BUSY' } })) }, 'scriptError', 1],
        ];
        for (const [label, opts, kind, fetches] of cases) {
          const offline = { v: Boolean(opts.isOnline) };
          const broken = { v: true };
          const good = fakeGas();
          const bad = opts.fetchImpl || good;
          const f = fakeFetch((url, init) => (broken.v ? bad(url, init) : good(url, init)));
          const s = setup({ ...opts, fetchImpl: f, isOnline: () => !offline.v });
          try {
            const saved = await s.svc.saveNewTrade(entry(1));
            await s.idle();
            checks.push([`${label}：pending・内容は変わらない`, deepEqual(s.db.raw(uuid(1)), saved), s.db.raw(uuid(1)).syncStatus]);
            checks.push([`${label}：syncLastError`, s.lastError() && s.lastError().kind === kind, s.lastError()]);
            checks.push([`${label}：fetch の回数`, f.calls.length === fetches, f.calls.length]);
            checks.push([`${label}：止めない`, !s.sender.isBlocked(), s.sender.isBlocked()]);
            broken.v = false;
            offline.v = false;
            await s.svc.saveNewTrade(entry(2));
            await s.idle();
            checks.push([`${label}：次の保存では送って成功`, s.db.raw(uuid(2)).syncStatus === 'synced', s.db.raw(uuid(2)).syncStatus]);
            checks.push([`${label}：成功で syncLastError は消える`, s.lastError() === null, s.lastError()]);
          } finally { s.cleanup(); }
        }
        return verdict(checks);
      }),

    t('SA-10', '保存は待たされない：送信は保存が終わったあとに始まる。応答が返らなくても保存・次の保存はすぐ終わる',
      '応答が返らない Apps Script で保存を2回', '保存の時点では fetch はまだ呼ばれていない。2回目の保存もすぐ終わり、送信中は1つだけ',
      async () => {
        let release;
        const f = fakeGas({ hold: () => new Promise((r) => { release = r; }) });
        const s = setup({ fetchImpl: f });
        try {
          const started = Date.now();
          await s.svc.saveNewTrade(entry(1));
          const callsAtSave = f.calls.length;
          await waitFor(() => f.calls.length > 0, '最初の送信');
          await s.svc.saveNewTrade(entry(2));
          const took = Date.now() - started;
          await tick();
          const calls = f.calls.length;
          release();
          await waitFor(() => f.calls.length >= 2, '2回目の送信');
          release();
          await s.idle();
          return verdict([
            ['保存の時点では送っていない（あとで始まる）', callsAtSave === 0, callsAtSave],
            ['応答を待たずに2回目の保存が終わる', took < 1000, `${took}ms`],
            ['送信中は1つだけ', calls === 1, calls],
            ['あとで2件目も送る', f.calls.length === 2 && s.db.raw(uuid(2)).syncStatus === 'synced', f.calls.length],
          ]);
        } finally { s.cleanup(); }
      }),

    t('SA-11', '失敗しても記録が壊れない・止まらない：記録の読み直し・書き戻し・syncLastError の保存がそれぞれ失敗したとき',
      'loadTrades が失敗／markResults が失敗／saveLastError が失敗', '保存は成功し記録は pending のまま（内容も同じ）、例外は外に出ない、次の保存は送れる',
      async () => {
        const checks = [];
        const failOnce = (fn) => {
          let failed = false;
          return (...a) => {
            if (!failed) { failed = true; throw new AppError('DB_READ', 'わざと失敗'); }
            return fn(...a);
          };
        };
        for (const label of ['loadTrades', 'markResults', 'saveLastError']) {
          const log = fakeLog();
          const holder = {};
          const wrap = {
            loadTrades: label === 'loadTrades' ? failOnce((ids) => Promise.all(ids.map((id) => holder.svc.getTrade(id)))) : undefined,
            markResults: label === 'markResults' ? failOnce((e) => holder.svc.markSyncResults(e)) : undefined,
            saveLastError: label === 'saveLastError' ? () => { throw new AppError('SETTINGS_WRITE', 'わざと失敗'); } : undefined,
          };
          for (const k of Object.keys(wrap)) if (wrap[k] === undefined) delete wrap[k];
          const s = setup({ log, wrap, fetchImpl: label === 'saveLastError' ? reply(gasError('BUSY')) : fakeGas() });
          holder.svc = s.svc;
          try {
            let thrown = null;
            let saved = null;
            try {
              saved = await s.svc.saveNewTrade(entry(1));
              await s.idle();
            } catch (e) { thrown = e; }
            checks.push([`${label}：保存は成功・例外は外に出ない`, thrown === null && saved !== null, thrown && thrown.message]);
            const stored = s.db.raw(uuid(1));
            if (label === 'saveLastError') {
              checks.push([`${label}：記録は pending のまま・内容も同じ`, deepEqual(stored, saved), stored.syncStatus]);
              checks.push([`${label}：開発者ツールに知らせる（中身なし）`, log.lines.some((l) => String(l[0]).includes('同期のエラーを端末に記録できませんでした')), log.lines.map((l) => l[0])]);
            } else {
              checks.push([`${label}：記録は pending のまま・内容も同じ`, deepEqual(stored, saved), stored.syncStatus]);
              checks.push([`${label}：開発者ツールに知らせる`, log.lines.some((l) => String(l[0]).includes('送信を中断しました')), log.lines.map((l) => l[0])]);
              await s.svc.saveNewTrade(entry(2));
              await s.idle();
              checks.push([`${label}：次の保存は送れる`, s.db.raw(uuid(2)).syncStatus === 'synced', s.db.raw(uuid(2)).syncStatus]);
            }
          } finally { s.cleanup(); }
        }
        return verdict(checks);
      }),

    t('SA-12', 'URL・合言葉・送った値・応答の本文が console にも syncLastError にも出ない（自動送信の全部の失敗で）',
      '成功（rejected あり）・BAD_TOKEN（本文に合言葉）・URL と合言葉入りの例外・HTML・書き戻しの失敗（既定の console に出す）',
      'console に出た文字・syncLastError に秘密も本文も入らない',
      async () => {
        const echo = { ...gasError('BAD_TOKEN'), error: { code: 'BAD_TOKEN', message: `応答の本文 ${FAKE_TOKEN} ${FAKE_URL}` } };
        const scenarios = [
          fakeGas({ decide: () => ({ id: uuid(1), result: 'rejected', reason: 'FORMULA', column: 'memo', message: `応答の本文 ${FAKE_TOKEN}` }) }),
          reply(echo),
          networkError(),
          reply(`<html>${FAKE_URL} ${FAKE_TOKEN}</html>`),
        ];
        const errors = [];
        const logged = await captureConsole(async () => {
          for (const f of scenarios) {
            const s = setup({ fetchImpl: f, log: console });
            try {
              await s.svc.saveNewTrade(entry(1, { memo: '送った値のメモ' }));
              await s.idle();
              errors.push(JSON.stringify(s.lastError()));
            } finally { s.cleanup(); }
          }
          const s = setup({ log: console, wrap: { markResults: () => { throw new Error('書き戻しの失敗'); } } });
          try {
            await s.svc.saveNewTrade(entry(1, { memo: '送った値のメモ' }));
            await s.idle();
          } finally { s.cleanup(); }
        });
        const secrets = [FAKE_URL, FAKE_TOKEN, 'FAKE-DEPLOYMENT-ID', '応答の本文', '送った値のメモ'];
        const bad = leaked(logged, secrets);
        const badErrors = errors.filter((e) => secrets.some((x) => e.includes(x)));
        return verdict([
          ['syncLastError が残った', errors.every((e) => e !== 'null'), errors],
          ['console に秘密・本文が出ない', bad.length === 0, bad.join(' | ')],
          ['syncLastError に秘密・本文が入らない', badErrors.length === 0, badErrors],
          ['開発者ツールには結果の種類が出る', logged.length >= scenarios.length, logged.length],
        ]);
      }),

    t('SA-13', '送った値と記録が同じかの物差し（sameSheetContent）：syncStatus・syncedAt 以外の30列で比べる',
      '同じ記録・syncStatus と syncedAt だけ違う・画像の ID だけ違う（枚数は同じ）・メモが違う・deletedAt が違う', 'true／true／true／false／false',
      () => {
        const base = importedRow(1, { imageIds: ['a'] });
        const sent = sheetRowValues(base, { syncedAt: '2026-10-28T10:00:00+09:00' });
        return verdict([
          ['同じ記録', sameSheetContent(sent, base), ''],
          ['同期の項目だけ違う', sameSheetContent(sent, { ...base, syncStatus: 'error', syncedAt: '2026-10-01T00:00:00+09:00' }), ''],
          ['画像の ID だけ違う（シートは枚数だけ）', sameSheetContent(sent, { ...base, imageIds: ['b'] }), ''],
          ['メモが違う', !sameSheetContent(sent, { ...base, memo: 'x' }), ''],
          ['deletedAt が違う', !sameSheetContent(sent, { ...base, deletedAt: '2026-10-28T10:00:00+09:00' }), ''],
        ]);
      }),
  ];
}

/* ---------------------------------------------------------
   SR：未送信の再送（T-42）。起動時・オンライン復帰・前面に戻ったとき・待ってからの再送・「今すぐ同期」・
   接続テストの成功（SS-R02）・送信中の取りこぼし（SS-R01）・受け付けられなかった記録の知らせ（SS-R03）・1分の上限（SS-R04）
   --------------------------------------------------------- */

/** 送った記録の id（送った順。同じ id が何回送られたか数えるため） */
const sentIds = (f) => f.bodies.flatMap((b) => b.records.map((r) => r.values.id));
const countOf = (list, id) => list.filter((x) => x === id).length;

/**
 * 再送のきっかけ（connectResendTriggers）を、にせものの window・document・タイマーでつなぐ。
 * 時計は送信のしくみと同じもの（s.time）を使う（前回の送信からの時間を比べるため）。
 */
function wireTriggers(s) {
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const timers = [];
  const off = connectResendTriggers(s.sender, {
    win, doc, nowMs: s.time.nowMs,
    setTimer: (fn, ms) => { const h = { fn, ms, done: false }; timers.push(h); return h; },
    clearTimer: (h) => { h.done = true; },
  });
  return {
    timers,
    off,
    waiting: () => timers.filter((h) => !h.done),
    /** 予約された再送を呼ぶ（無ければ false） */
    fire: () => {
      const h = timers.find((x) => !x.done);
      if (!h) return false;
      h.done = true;
      h.fn();
      return true;
    },
    online: () => win.dispatchEvent(new Event('online')),
    show: (state = 'visible') => {
      doc.visibilityState = state;
      doc.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

/** 1回目の要求だけ、外から release(answer) されるまで止める Apps Script（answer：'ok'・'BUSY'・'unreachable'・'timeout'） */
function gatedGas() {
  const good = fakeGas();
  let gate = null;
  let first = true;
  const f = fakeFetch(async (url, init) => {
    if (!first) return good(url, init);
    first = false;
    good.bodies.push(JSON.parse(init.body));
    const answer = await new Promise((r) => { gate = r; });
    if (answer === 'BUSY') return { status: 200, ok: true, text: async () => JSON.stringify(gas({ action: 'upsert', ok: false, error: { code: 'BUSY' } })) };
    if (answer === 'unreachable') throw new TypeError('Failed to fetch');
    if (answer === 'timeout') return new Promise(() => {}); // 時間切れ（timeoutMs）で打ち切られる
    good.bodies.pop();
    return good(url, init);
  });
  f.sheet = good.sheet;
  f.bodies = good.bodies;
  f.isHeld = () => gate !== null;
  f.release = (answer) => { const g = gate; gate = null; g(answer); };
  return f;
}

function resendTests() {
  return [
    t('SR-01', '起動時の再送：未設定のあいだに溜まった未送信（削除済み・CSV の取り込みも含む）を、起動の2秒後にまとめて送る',
      '未設定で保存2件（1件は削除）＋CSV の取り込み1件 → 設定 → 再送のきっかけをつなぐ（起動）→ 2秒の予約を呼ぶ',
      'つないだ時点では送らず、予約を呼ぶと1回で3件（作った順）を送って全件 synced。シートは3行・重複なし。もう一度起動しても送らない',
      async () => {
        const s = setup({ url: null });
        try {
          await s.svc.saveNewTrade(entry(1));
          await s.svc.deleteTrade((await s.svc.saveNewTrade(entry(2))).id);
          await s.svc.importTrades([importedRow(3)], { snapshot: new Map() });
          await s.idle();
          const before = s.fetchImpl.calls.length;
          s.cfg.url = FAKE_URL;
          const tr = wireTriggers(s);
          const waiting = tr.waiting().map((h) => h.ms);
          const atConnect = s.fetchImpl.calls.length;
          tr.fire();
          await s.idle();
          const all = await s.svc.getAllTrades();
          const tr2 = wireTriggers(s);
          tr2.fire();
          await s.idle();
          tr.off();
          tr2.off();
          return verdict([
            ['未設定のあいだは送らない', before === 0, before],
            ['起動の再送は2秒後の予約', waiting.join() === String(RESEND_DELAY_MS) && RESEND_DELAY_MS === 2000, waiting],
            ['つないだ時点では送らない', atConnect === 0, atConnect],
            ['1回で3件・作った順（取り込んだ記録が先）', s.fetchImpl.bodies.length >= 1 && s.fetchImpl.bodies[0].records.map((r) => r.values.id).join() === [uuid(3), uuid(1), uuid(2)].join(), sentIds(s.fetchImpl)],
            ['削除済みも送る', s.fetchImpl.bodies[0].records[2].values.deletedAt !== '', s.fetchImpl.bodies[0].records[2].values.deletedAt],
            ['全件 synced', all.length === 3 && all.every((x) => x.syncStatus === 'synced'), all.map((x) => x.syncStatus)],
            ['シートは3行・記録と同じ', s.fetchImpl.sheet.size === 3 && all.every((x) => deepEqual(s.fetchImpl.sheet.get(x.id), sheetRowValues(x, { syncedAt: x.syncedAt }))), s.fetchImpl.sheet.size],
            ['自動の読み出しは pending だけ', s.unsentLoads.every((x) => x === false), s.unsentLoads],
            ['2回目の起動では送らない（未送信なし）', s.fetchImpl.calls.length === 1, s.fetchImpl.calls.length],
          ]);
        } finally { s.cleanup(); }
      }),

    t('SR-02', 'オンライン復帰の再送：オフラインで3件保存（1件は決済も）→ online → 3件を1回で送って全件 synced',
      'navigator.onLine が false のあいだに保存・決済 → true にして online イベントを2回 → 予約を呼ぶ',
      'オフラインのあいだは fetch 0回・記録は保存したとおり pending・syncLastError は offline・待ってからの再送は予約しない。復帰後は1回で3件、syncLastError は消える',
      async () => {
        const net = { online: false };
        const s = setup({ isOnline: () => net.online });
        try {
          const tr = wireTriggers(s);
          tr.fire(); // 起動の再送（まだ何もない）
          await s.idle();
          const saved = [];
          saved.push(await s.svc.saveNewTrade(entry(1)));
          saved.push(await s.svc.saveNewTrade(entry(2)));
          saved.push(await s.svc.saveNewTrade(entry(3)));
          await s.idle();
          saved[0] = await s.svc.closeTrade(uuid(1), { exitPrice: 150.4, exitAt: '2026-10-15T23:00:00+09:00' });
          await s.idle();
          const offlineState = saved.map((x) => deepEqual(s.db.raw(x.id), x));
          const err = s.lastError();
          const retry = s.time.live().length;
          const kept = s.sender.queuedCount();
          net.online = true;
          tr.online();
          tr.online();
          const waiting = tr.waiting().length;
          tr.fire();
          await s.idle();
          const all = await s.svc.getAllTrades();
          tr.off();
          return verdict([
            ['オフラインのあいだは送らない', s.fetchImpl.bodies.length === 1, s.fetchImpl.bodies.length],
            ['記録は保存したとおり（pending）', offlineState.every(Boolean), offlineState],
            ['syncLastError は offline', err && err.kind === 'offline', err],
            ['オフラインでは待ってからの再送を予約しない（online を待つ）', retry === 0, retry],
            ['送る列に3件残っている（SS-R01）', kept === 3, kept],
            ['online が2回でも予約は1つ', waiting === 1, waiting],
            ['復帰後は1回で3件', s.fetchImpl.bodies[0].records.length === 3, s.fetchImpl.bodies[0].records.length],
            ['決済の値を送った', s.fetchImpl.bodies[0].records[0].values.status === 'closed', s.fetchImpl.bodies[0].records[0].values.status],
            ['全件 synced・updatedAt は保存のまま', all.every((x) => x.syncStatus === 'synced' && x.updatedAt === saved.find((y) => y.id === x.id).updatedAt), all.map((x) => x.syncStatus)],
            ['syncLastError は消える', s.lastError() === null, s.lastError()],
          ]);
        } finally { s.cleanup(); }
      }),

    t('SR-03', '前面に戻ったときの再送：前回の送信・確認から1分たったときだけ。裏に回ったときは何もしない',
      '未送信1件 → 前面 → 送信 → 30秒後に未送信1件 → 前面（送らない）・裏（送らない）→ 61秒後に前面（送る）→ すぐ前面（予約しない）→ つなぐのをやめる',
      '予約の数 1・0・0・1・0、送信は2回、つなぐのをやめたら online でも予約しない',
      async () => {
        const s = setup();
        try {
          const tr = wireTriggers(s);
          tr.fire();
          await s.idle();
          const pendingOne = async (n) => {
            s.cfg.url = null;
            await s.svc.saveNewTrade(entry(n));
            await s.idle();
            s.cfg.url = FAKE_URL;
          };
          const counts = [];
          await pendingOne(1);
          tr.show();
          counts.push(tr.waiting().length);
          tr.fire();
          await s.idle();
          await pendingOne(2);
          s.time.ms += 30 * 1000;
          tr.show();
          counts.push(tr.waiting().length);
          tr.show('hidden');
          counts.push(tr.waiting().length);
          s.time.ms += 31 * 1000;
          tr.show();
          counts.push(tr.waiting().length);
          tr.fire();
          await s.idle();
          tr.show();
          counts.push(tr.waiting().length);
          tr.off();
          tr.online();
          const afterOff = tr.waiting().length;
          return verdict([
            ['予約の数（前面・30秒後・裏・61秒後・すぐ）', counts.join() === '1,0,0,1,0', counts],
            ['間隔は1分', VISIBLE_RESEND_INTERVAL_MS === 60000, VISIBLE_RESEND_INTERVAL_MS],
            ['送信は2回（1件ずつ）', sentIds(s.fetchImpl).join() === [uuid(1), uuid(2)].join(), sentIds(s.fetchImpl)],
            ['どちらも synced', ['1', '2'].every((n) => s.db.raw(uuid(Number(n))).syncStatus === 'synced'), ''],
            ['つなぐのをやめたら予約しない', afterOff === 0, afterOff],
          ]);
        } finally { s.cleanup(); }
      }),

    t('SR-04', '二重に送らない：再送のきっかけが重なっても、送信中に同じ記録を読み出しても、1件は1回だけ送る',
      '未送信5件 → 自動の再送を3回同時に → 1回目の応答を待たせている間に自動の再送・「今すぐ同期」・online → 応答',
      '未送信の読み出しは重なりを1つにまとめる、fetch は1回、どの記録も1回だけ送る、シートは5行、全件 synced',
      async () => {
        const f = gatedGas();
        const s = setup({ fetchImpl: f, url: null });
        try {
          for (let n = 1; n <= 5; n += 1) await s.svc.saveNewTrade(entry(n));
          await s.idle();
          s.cfg.url = FAKE_URL;
          const counts = await Promise.all([s.sender.requestUnsent(), s.sender.requestUnsent(), s.sender.requestUnsent()]);
          const loadsAtStart = s.unsentLoads.length;
          await waitFor(() => f.isHeld(), '1回目の送信');
          const tr = wireTriggers(s);
          const again = await s.sender.requestUnsent();
          const manual = s.sender.syncNow();
          tr.online();
          tr.fire();
          tr.fire();
          await tick();
          f.release('ok');
          await manual;
          await s.idle();
          tr.off();
          const all = await s.svc.getAllTrades();
          const ids = sentIds(f);
          return verdict([
            ['同時の3回は同じ結果（5件）', counts.every((c) => c === 5), counts],
            ['未送信の読み出しは1回にまとめた', loadsAtStart === 1, loadsAtStart],
            ['送信中の再送も5件を読み出した', again === 5, again],
            ['fetch は1回', f.calls.length === 1, f.calls.length],
            ['どの記録も1回だけ', all.every((x) => countOf(ids, x.id) === 1), ids],
            ['シートは5行', f.sheet.size === 5, f.sheet.size],
            ['全件 synced', all.every((x) => x.syncStatus === 'synced'), all.map((x) => x.syncStatus)],
          ]);
        } finally { s.cleanup(); }
      }),

    t('SR-05', 'SS-R01：一時的な失敗のとき、その送信中に保存した記録も送る列に残し、次のきっかけで一緒に送る',
      '記録1を送っている間に記録2・3を保存 → 応答が BUSY／届かない／時間切れ → BUSY は次の保存、ほかは30秒後の再送で',
      '失敗の直後：3件とも pending・内容は同じ・列に3件・30秒後の再送を予約。次のきっかけで 1・2・3（・4）を1回で送り全件 synced・syncLastError は消える',
      async () => {
        const checks = [];
        for (const answer of ['BUSY', 'unreachable', 'timeout']) {
          const f = gatedGas();
          const s = setup({ fetchImpl: f, timeoutMs: answer === 'timeout' ? 200 : undefined });
          try {
            const saved = [await s.svc.saveNewTrade(entry(1))];
            await waitFor(() => f.isHeld(), '1回目の送信');
            saved.push(await s.svc.saveNewTrade(entry(2)));
            saved.push(await s.svc.saveNewTrade(entry(3)));
            f.release(answer); // 時間切れは、release の前に200ミリ秒で打ち切られている
            await s.idle();
            checks.push([`${answer}：1回だけ送った`, f.calls.length === 1, f.calls.length]);
            checks.push([`${answer}：3件とも pending・内容は同じ`, saved.every((x) => deepEqual(s.db.raw(x.id), x)), saved.map((x) => s.db.raw(x.id).syncStatus)]);
            checks.push([`${answer}：送る列に3件（失敗した回の1件＋送信中に保存した2件）`, s.sender.queuedCount() === 3 && s.sender.isPaused(), s.sender.queuedCount()]);
            checks.push([`${answer}：30秒後の再送を予約`, s.time.live().length === 1 && s.time.live()[0].ms === 30000, s.time.live().map((h) => h.ms)]);
            checks.push([`${answer}：syncLastError`, s.lastError() && s.lastError().kind === (answer === 'BUSY' ? 'scriptError' : answer), s.lastError()]);
            let expectIds = [uuid(1), uuid(2), uuid(3)];
            if (answer === 'BUSY') {
              await s.svc.saveNewTrade(entry(4)); // 次の保存（新しいきっかけ）
              expectIds = [...expectIds, uuid(4)];
            } else {
              s.time.fire(); // 30秒後の再送
            }
            await s.idle();
            const all = await s.svc.getAllTrades();
            checks.push([`${answer}：次のきっかけで1回にまとめて送る`, f.calls.length === 2 && f.bodies[f.bodies.length - 1].records.map((r) => r.values.id).join() === expectIds.join(), f.bodies.map((b) => b.records.map((r) => r.values.id.slice(-1)).join(''))]);
            checks.push([`${answer}：全件 synced`, all.every((x) => x.syncStatus === 'synced'), all.map((x) => x.syncStatus)]);
            checks.push([`${answer}：syncLastError は消え、再送の予約も消える`, s.lastError() === null && s.time.live().length === 0, s.lastError()]);
            checks.push([`${answer}：シートは重複なし`, f.sheet.size === expectIds.length, f.sheet.size]);
          } finally { s.cleanup(); }
        }
        return verdict(checks);
      }),

    t('SR-06', '待ってからの再送の間隔：30秒・2分・10分の3回まで。それでも失敗したら予約せず次のきっかけを待つ。成功で最初に戻る',
      '届かない Apps Script で保存 → 予約を順に呼ぶ → 保存 → 直して自動の再送 → また失敗／オフライン／設定の問題',
      '予約 30000・120000・600000 → 予約なし。成功後の失敗は 30000 から。オフラインは予約しない。設定の問題は予約を消す',
      async () => {
        const mode = { v: 'down' };
        const good = fakeGas();
        const f = fakeFetch((url, init) => {
          if (mode.v === 'down') return Promise.reject(new TypeError('Failed to fetch'));
          if (mode.v === 'header') return reply(gas({ action: 'upsert', ok: false, error: { code: 'HEADER_MISMATCH', column: 'C' } }))(url, init);
          return good(url, init);
        });
        const net = { online: true };
        const s = setup({ fetchImpl: f, isOnline: () => net.online });
        try {
          const delays = [];
          await s.svc.saveNewTrade(entry(1));
          await s.idle();
          for (let i = 0; i < 3; i += 1) {
            delays.push(s.time.live().map((h) => h.ms).join() || '-');
            s.time.fire();
            await s.idle();
          }
          delays.push(s.time.live().map((h) => h.ms).join() || '-');
          const gaveUp = s.log.lines.some((l) => String(l[0]).includes('続けて失敗したため'));
          await s.svc.saveNewTrade(entry(2));
          await s.idle();
          const afterSave = s.time.live().length;
          const callsDown = f.calls.length;
          mode.v = 'up';
          await s.sender.requestUnsent();
          await s.idle();
          const allSynced = (await s.svc.getAllTrades()).every((x) => x.syncStatus === 'synced');
          mode.v = 'down';
          await s.svc.saveNewTrade(entry(3));
          await s.idle();
          const reset = s.time.live().map((h) => h.ms).join();
          mode.v = 'header';
          s.time.fire();
          await s.idle();
          const afterHeader = s.time.live().length;
          const blocked = s.sender.isBlocked();
          // オフライン（別のしくみで）
          const s2 = setup({ isOnline: () => false });
          let offlineRetry;
          try {
            await s2.svc.saveNewTrade(entry(1));
            await s2.idle();
            offlineRetry = s2.time.live().length;
          } finally { s2.cleanup(); }
          return verdict([
            ['予約の間隔', delays.join(' / ') === '30000 / 120000 / 600000 / -', delays],
            ['3回でやめたことを開発者ツールに出す', gaveUp, s.log.lines.map((l) => l[0])],
            ['やめたあとの保存では送るが予約しない', afterSave === 0 && callsDown === 5, `${afterSave}/${callsDown}`],
            ['直ったら自動の再送で全件 synced', allSynced, ''],
            ['成功のあとの失敗は30秒から', reset === '30000', reset],
            ['設定の問題では予約を消して止める', afterHeader === 0 && blocked, `${afterHeader}/${blocked}`],
            ['オフラインでは予約しない', offlineRetry === 0, offlineRetry],
            ['間隔の定数', RETRY_DELAYS_MS.join() === '30000,120000,600000', RETRY_DELAYS_MS],
          ]);
        } finally { s.cleanup(); }
      }),

    t('SR-07', 'SS-R02：設定の問題で止まったあと、シートを直して接続テストが成功すると、自動の送信を再開して未送信を送る',
      'HEADER_MISMATCH で2件 → 自動の再送・online・前面では送らない → シートを直す → resumeAfterTest（接続テストの成功）',
      '止めている間は fetch も未送信の読み出しもしない。再開で2件を1回で送り synced・止めるのをやめる・syncLastError は消える',
      async () => {
        const broken = { v: true };
        const good = fakeGas();
        const f = fakeFetch((url, init) => (broken.v
          ? reply(gas({ action: 'upsert', ok: false, error: { code: 'HEADER_MISMATCH', column: 'C' } }))(url, init)
          : good(url, init)));
        const s = setup({ fetchImpl: f });
        try {
          await s.svc.saveNewTrade(entry(1));
          await s.idle();
          await s.svc.saveNewTrade(entry(2));
          await s.idle();
          const tr = wireTriggers(s);
          tr.fire();
          tr.online();
          tr.fire();
          s.time.ms += 2 * 60 * 1000;
          tr.show();
          tr.fire();
          await s.sender.requestUnsent();
          await s.idle();
          tr.off();
          const whileBlocked = { calls: f.calls.length, loads: s.unsentLoads.length, blocked: s.sender.isBlocked(), err: s.lastError() };
          broken.v = false;
          const n = await s.sender.resumeAfterTest();
          await s.idle();
          const all = await s.svc.getAllTrades();
          return verdict([
            ['止めている間は送らない（最初の1回だけ）', whileBlocked.calls === 1, whileBlocked.calls],
            ['止めている間は未送信も読み出さない', whileBlocked.loads === 0, whileBlocked.loads],
            ['止めていた・syncLastError は HEADER_MISMATCH', whileBlocked.blocked && whileBlocked.err && whileBlocked.err.code === 'HEADER_MISMATCH', whileBlocked.err],
            ['再開で2件を読み出す（pending だけ）', n === 2 && s.unsentLoads.join() === 'false', `${n}/${s.unsentLoads}`],
            ['1回で2件を送る', f.calls.length === 2 && good.bodies[0].records.length === 2, f.calls.length],
            ['全件 synced', all.every((x) => x.syncStatus === 'synced'), all.map((x) => x.syncStatus)],
            ['止めるのをやめた・syncLastError は消える', !s.sender.isBlocked() && s.lastError() === null, s.lastError()],
          ]);
        } finally { s.cleanup(); }
      }),

    t('SR-08', 'SS-R03：受け付けられなかった記録の知らせは、オフライン・設定の問題で上書きされても rejected 欄に残り、直ったら rejected に戻る',
      '記録1が rejected → オフラインで記録2 → オンラインで記録3 → 見出し違いで記録4 → 直して接続テストの成功 → 記録1を直す',
      'offline・scriptError の syncLastError に rejected { at, reason, count, ids } が付く。成功のあとは kind: rejected（最初の時刻・id）に戻る。記録1が synced になったら消える',
      async () => {
        const reject = new Set([uuid(1)]);
        const mode = { v: 'up' };
        const good = fakeGas({ decide: (r) => (reject.has(r.values.id) ? { id: r.values.id, result: 'rejected', reason: 'BAD_DATETIME', column: 'entryAt' } : null) });
        const f = fakeFetch((url, init) => (mode.v === 'header'
          ? reply(gas({ action: 'upsert', ok: false, error: { code: 'HEADER_MISMATCH', column: 'C' } }))(url, init)
          : good(url, init)));
        const net = { online: true };
        const s = setup({ fetchImpl: f, isOnline: () => net.online });
        try {
          await s.svc.saveNewTrade(entry(1));
          await s.idle();
          const first = s.lastError();
          net.online = false;
          await s.svc.saveNewTrade(entry(2));
          await s.idle();
          const offline = s.lastError();
          net.online = true;
          await s.svc.saveNewTrade(entry(3));
          await s.idle();
          const back = s.lastError();
          mode.v = 'header';
          await s.svc.saveNewTrade(entry(4));
          await s.idle();
          const header = s.lastError();
          mode.v = 'up';
          await s.sender.resumeAfterTest();
          await s.idle();
          const resumed = s.lastError();
          const status1 = s.db.raw(uuid(1)).syncStatus;
          reject.delete(uuid(1));
          await s.svc.saveTrade({ ...s.db.raw(uuid(1)), memo: '直した' });
          await s.idle();
          const carried = { at: first.at, reason: 'BAD_DATETIME', count: 1, ids: [uuid(1)] };
          return verdict([
            ['最初は rejected', first && first.kind === 'rejected' && first.reason === 'BAD_DATETIME' && first.ids.join() === uuid(1), first],
            ['オフラインでも知らせを持ち越す', offline && offline.kind === 'offline' && deepEqual(offline.rejected, carried), offline],
            ['オンラインで成功 → rejected に戻る（最初の時刻）', back && deepEqual(back, { at: first.at, kind: 'rejected', code: null, reason: 'BAD_DATETIME', count: 1, ids: [uuid(1)] }), back],
            ['設定の問題でも持ち越す', header && header.kind === 'scriptError' && header.code === 'HEADER_MISMATCH' && deepEqual(header.rejected, carried), header],
            ['直って再開 → rejected に戻る', resumed && resumed.kind === 'rejected' && resumed.ids.join() === uuid(1) && resumed.rejected === undefined, resumed],
            ['記録1は error のまま（接続テストでは送らない）', status1 === 'error', status1],
            ['記録1を直して受け付けられたら消える', s.db.raw(uuid(1)).syncStatus === 'synced' && s.lastError() === null, s.lastError()],
            ['rejectedInfoOf', deepEqual(rejectedInfoOf(offline), carried) && deepEqual(rejectedInfoOf(first), carried) && rejectedInfoOf(null) === null
              && rejectedInfoOf({ ...offline, rejected: undefined }) === null, ''],
          ]);
        } finally { s.cleanup(); }
      }),

    t('SR-09', '受け付けられなかった記録（error）は、自動では送り直さない（起動・online・前面・待ってからの再送）。「今すぐ同期」と、記録を直したときだけ送る',
      'rejected の記録1 → 起動・online・前面の再送 → 届かない失敗のあと30秒後の再送（記録2）→ 今すぐ同期 → 記録1を直す',
      '記録1を送るのは 最初・今すぐ同期・直したとき の3回だけ。自動の読み出しは pending だけ',
      async () => {
        const reject = new Set([uuid(1)]);
        const down = { v: false };
        const good = fakeGas({ decide: (r) => (reject.has(r.values.id) ? 'rejected' : null) });
        const f = fakeFetch((url, init) => (down.v ? Promise.reject(new TypeError('Failed to fetch')) : good(url, init)));
        const s = setup({ fetchImpl: f });
        try {
          await s.svc.saveNewTrade(entry(1));
          await s.idle();
          const tr = wireTriggers(s);
          tr.fire();
          await s.idle();
          tr.online();
          tr.fire();
          await s.idle();
          s.time.ms += 2 * 60 * 1000;
          tr.show();
          tr.fire();
          await s.idle();
          const autoCount = countOf(sentIds(good), uuid(1));
          down.v = true;
          await s.svc.saveNewTrade(entry(2));
          await s.idle();
          down.v = false;
          s.time.fire();
          await s.idle();
          const afterRetry = { one: countOf(sentIds(good), uuid(1)), two: s.db.raw(uuid(2)).syncStatus };
          const n = await s.sender.syncNow();
          const afterManual = { one: countOf(sentIds(good), uuid(1)), status: s.db.raw(uuid(1)).syncStatus };
          reject.delete(uuid(1));
          await s.svc.saveTrade({ ...s.db.raw(uuid(1)), memo: '直した' });
          await s.idle();
          tr.off();
          return verdict([
            ['自動の再送では送らない（最初の1回だけ）', autoCount === 1, autoCount],
            ['待ってからの再送でも送らない（記録2は送る）', afterRetry.one === 1 && afterRetry.two === 'synced', afterRetry],
            ['自動の読み出しは pending だけ', s.unsentLoads.slice(0, -1).every((x) => x === false), s.unsentLoads],
            ['今すぐ同期は error も読み出して送る', n === 1 && s.unsentLoads[s.unsentLoads.length - 1] === true && afterManual.one === 2, `${n}/${afterManual.one}`],
            ['今すぐ同期でもまた受け付けられなければ error', afterManual.status === 'error', afterManual.status],
            ['直したら自動で送って synced', countOf(sentIds(good), uuid(1)) === 3 && s.db.raw(uuid(1)).syncStatus === 'synced', s.db.raw(uuid(1)).syncStatus],
          ]);
        } finally { s.cleanup(); }
      }),

    t('SR-10', '「今すぐ同期」（syncNow）：未設定なら何もしない。設定の問題で止めていても送る。オフラインなら送らず記録はそのまま。送り終わるまで待つ',
      '未設定で syncNow → 合言葉違いで止める → Apps Script 側を直して syncNow → オフラインで保存して syncNow → 全部 synced で syncNow',
      '0・fetch なし／2件を送って終わるまで待つ／offline・pending／0・fetch なし',
      async () => {
        const broken = { v: true };
        const good = fakeGas();
        const f = fakeFetch((url, init) => (broken.v ? reply(gasError('BAD_TOKEN'))(url, init) : good(url, init)));
        const net = { online: true };
        const s = setup({ fetchImpl: f, url: null, isOnline: () => net.online });
        try {
          const unset = await s.sender.syncNow();
          const unsetCalls = f.calls.length;
          const unsetLoads = s.unsentLoads.length;
          s.cfg.url = FAKE_URL;
          await s.svc.saveNewTrade(entry(1));
          await s.idle();
          await s.svc.saveNewTrade(entry(2));
          await s.idle();
          const blocked = s.sender.isBlocked() && f.calls.length === 1;
          broken.v = false;
          const n = await s.sender.syncNow(); // 終わるまで待つ（whenIdle を呼ばない）
          const right = [1, 2].map((k) => s.db.raw(uuid(k)).syncStatus);
          net.online = false;
          const saved = await s.svc.saveNewTrade(entry(3));
          const nOff = await s.sender.syncNow();
          const offState = { err: s.lastError(), same: deepEqual(s.db.raw(uuid(3)), saved), calls: f.calls.length };
          net.online = true;
          await s.sender.syncNow();
          const callsBefore = f.calls.length;
          const none = await s.sender.syncNow();
          return verdict([
            ['未設定：0・送らない・読み出さない', unset === 0 && unsetCalls === 0 && unsetLoads === 0, `${unset}/${unsetCalls}/${unsetLoads}`],
            ['合言葉違いで止めた', blocked, s.sender.isBlocked()],
            ['今すぐ同期は止めていても送る（2件）', n === 2 && right.every((x) => x === 'synced'), right],
            ['止めるのをやめた', !s.sender.isBlocked(), s.sender.isBlocked()],
            ['オフライン：送らず offline・記録はそのまま', nOff === 1 && offState.err.kind === 'offline' && offState.same && offState.calls === 2, offState],
            ['全部 synced なら送らない', none === 0 && f.calls.length === callsBefore, `${none}/${f.calls.length - callsBefore}`],
          ]);
        } finally { s.cleanup(); }
      }),

    t('SR-11', 'オフラインで記録が壊れない：オフラインで保存・決済・編集・削除・取り消し・CSV の取り込み → 復帰後に全部送る',
      '本物の業務処理で操作（navigator.onLine が false）→ online の再送', '操作の結果どおりに保存され pending、fetch 0回。復帰後は全件 synced・updatedAt は操作のまま・シートの行＝記録',
      async () => {
        const net = { online: false };
        const s = setup({ isOnline: () => net.online });
        try {
          const checks = [];
          const a = await s.svc.saveNewTrade(entry(1));
          const closed = await s.svc.closeTrade(a.id, { exitPrice: 150.4, exitAt: '2026-10-15T23:00:00+09:00' });
          const edited = await s.svc.saveTrade({ ...closed, memo: 'オフラインで編集' }, { expectedUpdatedAt: closed.updatedAt });
          const b = await s.svc.saveNewTrade(entry(2));
          const del = await s.svc.deleteTrade(b.id);
          const restored = await s.svc.undoDeleteTrade(b.id, del.deletedAt);
          const c = await s.svc.saveNewTrade(entry(3));
          const delC = await s.svc.deleteTrade(c.id);
          await s.svc.importTrades([importedRow(4), importedRow(5)], { snapshot: new Map() });
          await s.idle();
          const expected = new Map([[a.id, edited], [b.id, restored], [c.id, delC]]);
          for (const [id, want] of expected) checks.push([`${id.slice(-1)}：操作の結果どおり`, deepEqual(s.db.raw(id), want), s.db.raw(id).syncStatus]);
          const all0 = await s.svc.getAllTrades();
          checks.push(['全件 pending・fetch 0回', all0.length === 5 && all0.every((x) => x.syncStatus === 'pending') && s.fetchImpl.calls.length === 0, s.fetchImpl.calls.length]);
          const updatedAt = new Map(all0.map((x) => [x.id, x.updatedAt]));
          net.online = true;
          const tr = wireTriggers(s);
          tr.online();
          tr.fire();
          tr.fire();
          await s.idle();
          tr.off();
          const all = await s.svc.getAllTrades();
          const ids = sentIds(s.fetchImpl);
          checks.push(['全件 synced', all.every((x) => x.syncStatus === 'synced'), all.map((x) => x.syncStatus)]);
          checks.push(['updatedAt は操作のまま', all.every((x) => x.updatedAt === updatedAt.get(x.id)), '']);
          checks.push(['どれも1回だけ送る', all.every((x) => countOf(ids, x.id) === 1), ids.length]);
          checks.push(['シートの行＝記録（5行）', s.fetchImpl.sheet.size === 5 && all.every((x) => deepEqual(s.fetchImpl.sheet.get(x.id), sheetRowValues(x, { syncedAt: x.syncedAt }))), s.fetchImpl.sheet.size]);
          checks.push(['削除済みは削除済みとして送る', s.fetchImpl.sheet.get(c.id).deletedAt === delC.deletedAt && s.fetchImpl.sheet.get(b.id).deletedAt === '', '']);
          return verdict(checks);
        } finally { s.cleanup(); }
      }),

    t('SR-12', 'SS-R04：1分に40件まで。100件の取り込みは20件ずつ、どの1分を取っても40件以下。1件ずつの保存では待たない',
      'CSV の取り込み100件（にせものの時計）→ 1件ずつ3回保存', '件数 20×5、直前60秒の合計はいつも40以下、待ったのは2回（60秒ずつ）。1件ずつの保存では待たない',
      async () => {
        const at = [];
        const holder = {};
        const f = fakeGas({ hold: async (body) => { at.push({ t: holder.time.ms, n: body.records.length }); } });
        const s = setup({ fetchImpl: f });
        holder.time = s.time;
        try {
          await s.svc.importTrades(Array.from({ length: 100 }, (_, i) => importedRow(200 + i)), { snapshot: new Map() });
          await s.idle();
          const worst = Math.max(...at.map((x) => at.filter((y) => y.t > x.t - 60000 && y.t <= x.t).reduce((sum, y) => sum + y.n, 0)));
          const waits = s.time.waits.length;
          s.time.ms += 10 * 60 * 1000;
          for (let n = 1; n <= 3; n += 1) {
            await s.svc.saveNewTrade(entry(n));
            await s.idle();
          }
          const all = await s.svc.getAllTrades();
          return verdict([
            ['件数', at.slice(0, 5).map((x) => x.n).join() === '20,20,20,20,20', at.map((x) => x.n)],
            ['直前60秒の合計はいつも40以下', worst <= SYNC_RECORDS_PER_MINUTE, worst],
            ['待ったのは2回（60秒ずつ）', waits === 2 && s.time.waits.every((w) => w === 60000), s.time.waits],
            ['1件ずつの保存では待たない', s.time.waits.length === waits, s.time.waits],
            ['全件 synced', all.length === 103 && all.every((x) => x.syncStatus === 'synced'), all.filter((x) => x.syncStatus !== 'synced').length],
            ['待ったことを開発者ツールに出す（秒だけ）', s.log.lines.some((l) => /1分あたりの件数の上限に近いため、\d+秒待って/.test(String(l[0]))), ''],
          ]);
        } finally { s.cleanup(); }
      }),

    t('SR-13', '再送でも壊れない・秘密を出さない：未送信の読み出しの失敗は例外を外に出さない。URL・合言葉・本文は console にも syncLastError にも出ない',
      '読み出しが失敗／届かない（message に URL と合言葉）で再送 → 30秒後の再送 → 3回目まで失敗 → 1分の上限で待つ・オフラインの持ち越し（既定の console）',
      'requestUnsent は 0 を返し開発者ツールに知らせる。console・syncLastError に秘密も本文も入らない',
      async () => {
        const failing = setup({ wrap: { loadUnsentIds: async () => { throw new AppError('DB_READ', 'わざと失敗'); } } });
        let n;
        let thrown = null;
        try {
          try { n = await failing.sender.requestUnsent(); } catch (e) { thrown = e; }
        } finally { failing.cleanup(); }
        const errors = [];
        const logged = await captureConsole(async () => {
          const s = setup({ fetchImpl: networkError(), log: console, recordsPerMinute: 20, batchSize: 20 });
          try {
            await s.svc.importTrades([importedRow(1, { memo: '送った値のメモ' })], { snapshot: new Map() });
            await s.idle();
            for (let i = 0; i < 4; i += 1) { s.time.fire(); await s.idle(); }
            errors.push(JSON.stringify(s.lastError()));
          } finally { s.cleanup(); }
          const reject = fakeGas({ decide: (r) => ({ id: r.values.id, result: 'rejected', reason: 'FORMULA', message: `応答の本文 ${FAKE_TOKEN}` }) });
          const net = { online: true };
          const s2 = setup({ fetchImpl: reject, log: console, isOnline: () => net.online, recordsPerMinute: 1, batchSize: 1 });
          try {
            await s2.svc.saveNewTrade(entry(1, { memo: '送った値のメモ' }));
            await s2.idle();
            await s2.svc.saveNewTrade(entry(2, { memo: '送った値のメモ' })); // 1分の上限で待つ
            await s2.idle();
            net.online = false;
            await s2.svc.saveNewTrade(entry(3, { memo: '送った値のメモ' }));
            await s2.idle();
            errors.push(JSON.stringify(s2.lastError()));
          } finally { s2.cleanup(); }
        });
        const secrets = [FAKE_URL, FAKE_TOKEN, 'FAKE-DEPLOYMENT-ID', '応答の本文', '送った値のメモ'];
        const bad = leaked(logged, secrets);
        return verdict([
          ['読み出しの失敗：0 を返し例外を出さない', thrown === null && n === 0, thrown && thrown.message],
          ['読み出しの失敗：開発者ツールに知らせる', failing.log.lines.some((l) => String(l[0]).includes('未送信の記録を読み出せませんでした')), failing.log.lines.map((l) => l[0])],
          ['console に何か出た（結果の種類・待つ秒・やめた知らせ）', logged.length >= 5, logged.length],
          ['console に秘密・本文が出ない', bad.length === 0, bad.join(' | ')],
          ['syncLastError が残った', errors.length === 2 && errors.every((e) => e !== 'null'), errors],
          ['syncLastError に秘密・本文が入らない', errors.every((e) => !secrets.some((x) => e.includes(x))), errors],
        ]);
      }),

    t('SR-14', '小さな道具：送る順（作った順）・再送のきっかけの定数・window／document が無い環境でもつなげる',
      'createdAt の違う記録・同じ createdAt・壊れた記録／win・doc なし', '作った順、同じなら id 順、id の無いものは除く。例外にならない',
      () => {
        const list = [
          { id: 'c', createdAt: '2026-10-20T10:00:00+09:00' }, { id: 'b', createdAt: '2026-10-10T10:00:00+09:00' },
          { id: 'a', createdAt: '2026-10-20T10:00:00+09:00' }, null, { id: '' }, { createdAt: '2026-10-01T00:00:00+09:00' },
        ];
        let threw = null;
        let off = null;
        try {
          off = connectResendTriggers({ requestUnsent: async () => 0, lastSendAt: () => -Infinity }, { win: null, doc: null, setTimer: () => null, clearTimer: () => {} });
          off();
        } catch (e) { threw = e; }
        return verdict([
          ['作った順・同じなら id 順', unsentIdsInOrder(list).join() === 'b,a,c', unsentIdsInOrder(list)],
          ['起動・online の再送は2秒後、前面は1分おき', RESEND_DELAY_MS === 2000 && VISIBLE_RESEND_INTERVAL_MS === 60000, `${RESEND_DELAY_MS}/${VISIBLE_RESEND_INTERVAL_MS}`],
          ['window・document が無くても例外にならない', threw === null && typeof off === 'function', threw && threw.message],
        ]);
      }),
  ];
}

/* ---------------------------------------------------------
   SB：本物の IndexedDB（ブラウザだけ）
   --------------------------------------------------------- */

async function withTestDb(id, fn) {
  const name = `${TEST_DB_PREFIX}${id}-${Math.random().toString(36).slice(2, 8)}`;
  const db = createDb({ name, version: DB_VERSION, migrations: MIGRATIONS });
  try {
    return await fn(db);
  } finally {
    await db.deleteDatabase();
  }
}

function dbTests() {
  return [
    tdb('SB-01', '書き戻し（markSyncResults）：syncStatus・syncedAt だけを変え、updatedAt は変えない。送ったときから変わっていたら書き戻さない。通知は出さない',
      '本物の IndexedDB。synced・error・updatedAt が違う・sameAsSent が false・無い記録・削除済み', 'architecture 3.3・20.2 のとおり',
      () => withTestDb('SB-01', async (db) => {
        const svc = createTradeService({ db, now: makeClock(), getLotUnitSize: () => 10000 });
        const events = [];
        const off = on(TRADES_CHANGED, (d) => events.push(d));
        try {
          const a = await svc.saveNewTrade(entry(1));
          const b = await svc.saveNewTrade(entry(2));
          const c = await svc.saveNewTrade(entry(3));
          const d = await svc.deleteTrade((await svc.saveNewTrade(entry(4))).id);
          const e = await svc.saveNewTrade(entry(5));
          const before = events.length;
          const at = '2026-10-28T12:00:00+09:00';
          const marked = await svc.markSyncResults([
            { id: a.id, updatedAt: a.updatedAt, syncStatus: 'synced', syncedAt: at },
            { id: b.id, updatedAt: b.updatedAt, syncStatus: 'error', syncedAt: at },
            { id: c.id, updatedAt: '2026-01-01T00:00:00+09:00', syncStatus: 'synced', syncedAt: at },
            { id: d.id, updatedAt: d.updatedAt, syncStatus: 'synced', syncedAt: at },
            { id: e.id, updatedAt: e.updatedAt, syncStatus: 'synced', syncedAt: at, sameAsSent: () => false },
            { id: uuid(99), updatedAt: at, syncStatus: 'synced', syncedAt: at },
          ]);
          const [a2, b2, c2, d2, e2] = await Promise.all([a, b, c, d, e].map((x) => svc.getTrade(x.id)));
          const only = (x, y) => deepEqual({ ...x, syncStatus: null, syncedAt: null }, { ...y, syncStatus: null, syncedAt: null });
          let badArg = null;
          try { await svc.markSyncResults([{ id: a.id, updatedAt: a.updatedAt, syncStatus: 'pending' }]); } catch (err) { badArg = err.name; }
          return verdict([
            ['書き戻した id', marked.join() === [a.id, b.id, d.id].join(), marked],
            ['synced・syncedAt', a2.syncStatus === 'synced' && a2.syncedAt === at, `${a2.syncStatus}/${a2.syncedAt}`],
            ['ほかの項目（updatedAt を含む）は変わらない', only(a, a2) && a2.updatedAt === a.updatedAt, ''],
            ['error は syncedAt を変えない', b2.syncStatus === 'error' && b2.syncedAt === null && only(b, b2), `${b2.syncStatus}/${b2.syncedAt}`],
            ['updatedAt が違えば書き戻さない', c2.syncStatus === 'pending' && deepEqual(c, c2), c2.syncStatus],
            ['削除済みも書き戻す', d2.syncStatus === 'synced' && d2.deletedAt === d.deletedAt, d2.syncStatus],
            ['sameAsSent が false なら書き戻さない', e2.syncStatus === 'pending', e2.syncStatus],
            ['通知は出さない', events.length === before, events.length - before],
            ['pending は渡せない', badArg === 'TypeError', badArg],
          ]);
        } finally { off(); }
      })),

    tdb('SB-02', '本物の IndexedDB での一連の操作：保存 → 決済 → 編集 → 削除 → 取り消し → 決済の取り消し → CSV の取り込み。失敗しても記録は壊れない',
      '本物の IndexedDB・本物の業務処理・にせものの Apps Script（途中で1回だけ通信の失敗）', '操作ごとに送って synced、シートの行は記録をシートの形にしたものと同じ。失敗した回の記録は pending のまま内容も同じ',
      () => withTestDb('SB-02', async (db) => {
        const svc = createTradeService({ db, now: makeClock(), getLotUnitSize: () => 10000 });
        const good = fakeGas();
        let failNext = false;
        const f = fakeFetch((url, init) => {
          if (failNext) { failNext = false; return Promise.reject(new TypeError('Failed to fetch')); }
          return good(url, init);
        });
        const store = createSettingsStore({ storage: fakeStorage(), prefix: 'fxnote-test:' });
        const sender = createSyncSender({
          getConfig: () => readSyncConfig(FAKE_URL, FAKE_TOKEN),
          loadTrades: (ids) => Promise.all(ids.map((id) => svc.getTrade(id))),
          markResults: (entries) => svc.markSyncResults(entries),
          readLastError: () => store.get('syncLastError'),
          saveLastError: (v) => { store.set('syncLastError', v); },
          now: makeClock(), fetchImpl: f, isOnline: () => true, log: fakeLog(),
          // 待ってからの再送（T-42）は予約だけにする（テストのあとで本物のタイマーが動かないように）
          setTimer: () => null, clearTimer: () => {},
        });
        const off = connectSender(sender);
        const checks = [];
        const after = async (label, ids) => {
          await withLimit(sender.whenIdle(), '送信');
          for (const id of ids) {
            const stored = await svc.getTrade(id);
            checks.push([`${label}：synced`, stored.syncStatus === 'synced', stored.syncStatus]);
            checks.push([`${label}：シートの行＝記録`, deepEqual(good.sheet.get(id), sheetRowValues(stored, { syncedAt: stored.syncedAt })), '']);
          }
        };
        try {
          const a = await svc.saveNewTrade(entry(1));
          await after('保存', [a.id]);
          const closed = await svc.closeTrade(a.id, { exitPrice: 150.4, exitAt: '2026-10-15T23:00:00+09:00' });
          await after('決済', [a.id]);
          await svc.saveTrade({ ...(await svc.getTrade(a.id)), tags: ['ルール違反', 'a|b'] }, { expectedUpdatedAt: closed.updatedAt });
          await after('編集（同期のあとも編集を始めたときの updatedAt で保存できる）', [a.id]);
          const del = await svc.deleteTrade(a.id);
          await after('削除', [a.id]);
          await svc.undoDeleteTrade(a.id, del.deletedAt);
          await after('削除の取り消し', [a.id]);
          await svc.reopenTrade(a.id);
          await after('決済の取り消し', [a.id]);
          await svc.importTrades([importedRow(2), importedRow(3)], { snapshot: new Map() });
          await after('CSV の取り込み', [uuid(2), uuid(3)]);
          failNext = true;
          const before = await svc.getTrade(a.id);
          const saved = await svc.saveTrade({ ...before, memo: '失敗する回' });
          await withLimit(sender.whenIdle(), '送信');
          const failed = await svc.getTrade(a.id);
          checks.push(['通信の失敗：pending のまま・内容も同じ', deepEqual(failed, saved), failed.syncStatus]);
          checks.push(['通信の失敗：syncLastError', store.get('syncLastError') && store.get('syncLastError').kind === 'unreachable', store.get('syncLastError')]);
          checks.push(['fetch は操作ごとに1回（計8回）', f.calls.length === 8, f.calls.length]);
          return verdict(checks);
        } finally { off(); }
      })),

    tdb('SB-03', '未送信の読み出し（unsentLoader：T-42）：本物の IndexedDB の syncStatus インデックスから、自動は pending だけ、「今すぐ同期」は error も',
      '本物の IndexedDB に pending（削除済みを含む）・error・synced の記録', '自動：pending を作った順（削除済みも）。今すぐ同期：error も。synced は含まない',
      () => withTestDb('SB-03', async (db) => {
        const svc = createTradeService({ db, now: makeClock(), getLotUnitSize: () => 10000 });
        await svc.importTrades([importedRow(1, { createdAt: '2026-10-12T09:00:00+09:00' })], { snapshot: new Map() });
        const b = await svc.saveNewTrade(entry(2));
        const c = await svc.saveNewTrade(entry(3));
        const d = await svc.deleteTrade((await svc.saveNewTrade(entry(4))).id);
        const e = await svc.saveNewTrade(entry(5));
        const at = '2026-10-28T12:00:00+09:00';
        await svc.markSyncResults([
          { id: c.id, updatedAt: c.updatedAt, syncStatus: 'error', syncedAt: at },
          { id: e.id, updatedAt: e.updatedAt, syncStatus: 'synced', syncedAt: at },
        ]);
        const load = unsentLoader(db);
        const auto = await load({ includeErrors: false });
        const manual = await load({ includeErrors: true });
        const byDefault = await load();
        return verdict([
          ['自動：pending を作った順（削除済みも）', auto.join() === [uuid(1), b.id, d.id].join(), auto],
          ['今すぐ同期：error も（作った順）', manual.join() === [uuid(1), b.id, c.id, d.id].join(), manual],
          ['指定なしは自動と同じ', byDefault.join() === auto.join(), byDefault],
          ['synced は含まない', !manual.includes(e.id), manual],
        ]);
      })),
  ];
}

export function collectSyncSendTests() {
  return [...protocolTests(), ...senderTests(), ...resendTests(), ...dbTests()];
}
