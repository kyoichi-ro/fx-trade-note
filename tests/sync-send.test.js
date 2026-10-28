/* =========================================================
   tests/sync-send.test.js
   スプレッドシートへの記録の送信（T-41）のテスト。docs/sheets-setup.md 4.3・6章・10.1・10.3・11.3〜11.5、architecture 3.3・20.2。
   ・SQ-xx：Apps Script との約束（js/sync.js の buildUpsertRecords・classifyUpsertResponse・upsertToAppsScript）。
            要求の形・送り方、応答の振り分け、一時的な失敗の見分け、gas/Code.gs の列の定義との一致、秘密が console に出ないこと
   ・SA-xx：自動送信（js/sync-sender.js）。本物の業務処理（trades.js の createTradeService）を、メモリの中のにせものの DB で動かし、
            にせものの Apps Script（fetch）に送る。送るきっかけ（保存・決済・編集・決済の取り消し・削除・削除の取り消し・画像の削除・
            CSV の取り込み）、送る値が CSV と同じ作り方、結果の反映、送っている間の編集、ループしないこと、1つずつ・20件ずつ、
            未設定のとき送らないこと、設定の問題のとき繰り返さないこと、失敗しても記録が壊れないこと、syncLastError、秘密
   ・SB-xx：本物の IndexedDB（別名のテスト用 DB）での書き戻し（trades.js の markSyncResults）と、一連の操作。ブラウザだけ
   本物の Apps Script には送らない。本物の設定（fxnote:）にも触れない（startAutoSync は呼ばない：本物の URL・合言葉で送ってしまうため）。
   ========================================================= */
import {
  buildUpsertRecords, classifyUpsertResponse, upsertToAppsScript, isTransientSyncFailure, readSyncConfig,
  SYNC_BATCH_SIZE, UPSERT_TIMEOUT_MS,
} from '../js/sync.js';
import { createSyncSender, connectSender, idsFromChange, sameSheetContent, SYNC_ERROR_KINDS } from '../js/sync-sender.js';
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
function setup({
  fetchImpl = fakeGas(), url = FAKE_URL, token = FAKE_TOKEN, clock = makeClock(), batchSize, isOnline = () => true,
  log = fakeLog(), timeoutMs, wrap = {},
} = {}) {
  const db = memoryDb();
  const svc = createTradeService({ db, now: clock, getLotUnitSize: () => 10000 });
  const cfg = { url, token };
  // syncLastError は本物の settings-store の確かめ方を通す（形が違えば TypeError）。保存場所はにせもの
  const store = createSettingsStore({ storage: fakeStorage(), prefix: 'fxnote-test:' });
  const deps = {
    getConfig: () => readSyncConfig(cfg.url, cfg.token),
    loadTrades: (ids) => Promise.all(ids.map((id) => svc.getTrade(id))),
    markResults: (entries) => svc.markSyncResults(entries),
    loadUnsentIds: async () => (await svc.getAllTrades()).filter((x) => x.syncStatus !== 'synced').map((x) => x.id),
    readLastError: () => store.get('syncLastError'),
    saveLastError: (v) => { store.set('syncLastError', v); },
  };
  const sender = createSyncSender({
    ...deps, ...wrap, now: clock, fetchImpl, isOnline, log, batchSize, timeoutMs,
  });
  const events = [];
  const offEvents = on(TRADES_CHANGED, (d) => events.push(d));
  const off = connectSender(sender);
  return {
    db, svc, sender, cfg, store, fetchImpl, log, events,
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
  ];
}

export function collectSyncSendTests() {
  return [...protocolTests(), ...senderTests(), ...dbTests()];
}
