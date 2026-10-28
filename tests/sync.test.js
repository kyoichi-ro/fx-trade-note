/* =========================================================
   tests/sync.test.js
   スプレッドシート同期の設定（T-40）のテスト。design 14.6.8・14.6.12、docs/sheets-setup.md 11章。
   ・SY-xx：入力チェック（js/sync.js の checkGasUrl・checkSyncToken：U-1〜U-4・K-1〜K-4）と、gas/Code.gs の合言葉の決まりとの一致
   ・SP-xx：接続テスト（pingAppsScript）。にせものの fetch で Apps Script の応答をまね、T-OK・T-1〜T-6 の振り分け、
            送り方（headers なし・redirect: 'follow' など）、時間切れ、URL・合言葉が console に出ないことを確かめる
   ・SS-xx：設定の保存（settings-store.js）が URL・合言葉の中身を警告・エラー文に出さないこと（にせものの保存場所を使う）
   ・SC-xx：CSP の connect-src（architecture 14.3）と、Service Worker（sw.js）が Apps Script への通信を横取りしないこと
   ・SG-xx：設定の「スプレッドシート同期」グループの画面（screens/settings-sync.js）。document を使うのでブラウザだけ
   本物の Apps Script には送らない（URL・合言葉はオーナーしか持っていない）。下の URL・合言葉はテスト用の作りもの。
   本物の設定（fxnote:）にも触れない（画面のテストは接頭辞 fxnote-test: のにせものの保存場所を使う）。
   ========================================================= */
import {
  checkGasUrl, checkSyncToken, SYNC_INPUT_MESSAGES, TOKEN_FORMAT, TOKEN_MIN_LENGTH, TOKEN_MAX_LENGTH,
  pingAppsScript, classifyPingResponse, pingResultText, PING_RESULT_TEXTS, PING_TIMEOUT_MS, SYNC_APP_ID, SYNC_PROTOCOL_VERSION,
} from '../js/sync.js';
import { createSettingsStore } from '../js/settings-store.js';
import { show } from './helpers.js';

const CATEGORY = 'スプレッドシート同期';
const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run });
/** document を使うテスト（ブラウザだけ） */
const td = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run, requires: 'dom' });

const IS_NODE = typeof window === 'undefined';

/** テスト用の作りものの URL・合言葉（本物ではない） */
const FAKE_URL = 'https://script.google.com/macros/s/FAKE-DEPLOYMENT-ID-FOR-TESTS/exec';
const FAKE_TOKEN = 'fake-token-for-tests-0123';
const BASE = 'https://script.google.com/macros/s/FAKE-ID';

/** 確認項目 [名前, 合否, 実際の値] の並びから結果を作る（不合格の項目だけ実際の値を出す） */
function verdict(checks) {
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) return { actual: `確認${checks.length}項目すべて一致`, pass: true };
  return { actual: failed.map(([label, , detail]) => `×${label}（実際：${show(detail)}）`).join('／'), pass: false };
}

/** プロジェクトのファイルを文字で読む（Node.js は直接、ブラウザは同じサーバーから） */
async function readText(path) {
  const url = new URL(`../${path}`, import.meta.url);
  if (IS_NODE) {
    const fs = await import('node:fs/promises');
    return fs.readFile(url, 'utf8');
  }
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} を読めません（${res.status}）`);
  return res.text();
}

/* ---------------------------------------------------------
   にせものの fetch（Apps Script の応答をまねる）
   --------------------------------------------------------- */

/** 呼ばれ方を覚える fetch。handler(url, init) の結果を返す */
function fakeFetch(handler) {
  const calls = [];
  const fn = (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}

/** 応答を返す（body がオブジェクトなら JSON の文字にする。Apps Script はいつも 200） */
const reply = (body, status = 200) => fakeFetch(async () => ({
  status, ok: status >= 200 && status < 300, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
}));

/** Apps Script の応答の共通部分（sheets-setup 11.4） */
const gas = (extra) => ({ app: 'fx-trade-note', v: 1, script: '1.1.0', ...extra });
const gasError = (code, extra = {}) => gas({ action: null, ok: false, error: { code, message: '（開発者向けの説明）', ...extra } });

/** 打ち切られるまで終わらない fetch（本物と同じく、打ち切られたら AbortError で失敗する） */
const hangUntilAbort = () => fakeFetch((url, init) => new Promise((resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
}));

/** 何をしても終わらない fetch（signal を無視する実装でも時間で終わるか） */
const neverEnds = () => fakeFetch(() => new Promise(() => {}));

/** 応答は届くが、本文の読み込みが終わらない（打ち切られるまで） */
const slowBody = () => fakeFetch(async (url, init) => ({
  status: 200,
  ok: true,
  text: () => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  }),
}));

/** 通信できない（CORS で読めない・DNS など。本物は TypeError: Failed to fetch／Load failed）。message にわざと URL・合言葉を入れる */
const networkError = () => fakeFetch(async () => {
  throw new TypeError(`Failed to fetch ${FAKE_URL} ${FAKE_TOKEN}`);
});

/** 開発者ツールへの出し先のにせもの（何が出たかを覚える） */
function fakeLog() {
  const lines = [];
  return { lines, warn: (...a) => lines.push(a), info: (...a) => lines.push(a), error: (...a) => lines.push(a), log: (...a) => lines.push(a) };
}

/** 1回の接続テスト（既定はオンライン・テスト用の URL と合言葉） */
const ping = (fetchImpl, opts = {}) => pingAppsScript({ url: FAKE_URL, token: FAKE_TOKEN, fetchImpl, isOnline: () => true, log: fakeLog(), ...opts });

/** 値を文字にする（console に出たものの中に秘密が入っていないかを調べるため。Error は name・message・stack・cause まで） */
function deepText(v, depth = 0) {
  if (depth > 4) return '';
  if (v instanceof Error) return `${v.name} ${v.message} ${v.stack || ''} ${deepText(v.cause, depth + 1)}`;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch (e) {
    return String(v);
  }
}

/** console の出力をすべて受け止めながら fn を動かし、出たものを返す（終わったら元に戻す） */
async function captureConsole(fn) {
  const names = ['log', 'info', 'warn', 'error', 'debug'];
  const original = {};
  const logged = [];
  for (const n of names) {
    original[n] = console[n];
    console[n] = (...args) => logged.push(args);
  }
  try {
    await fn();
  } finally {
    for (const n of names) console[n] = original[n];
  }
  return logged;
}

/** 出たものの中に secrets のどれかが入っていれば、その行を返す */
const leaked = (logged, secrets) => logged.map((args) => args.map((a) => deepText(a)).join(' '))
  .filter((line) => secrets.some((s) => line.includes(s)));

/* ---------------------------------------------------------
   SY：入力チェック
   --------------------------------------------------------- */

/** [入力, 期待（'ok' か コード）, 期待する保存値] */
const URL_CASES = [
  ['', 'ok', null],
  ['  \n　', 'ok', null],
  [FAKE_URL, 'ok', FAKE_URL],
  [`  ${FAKE_URL}\n`, 'ok', FAKE_URL],
  [`　${FAKE_URL}　`, 'ok', FAKE_URL],
  ['https://script.google.com/a/macros/example.com/s/FAKE-ID/exec', 'ok', 'https://script.google.com/a/macros/example.com/s/FAKE-ID/exec'],
  ['HTTPS://SCRIPT.GOOGLE.COM/macros/s/FAKE-ID/exec', 'ok', 'HTTPS://SCRIPT.GOOGLE.COM/macros/s/FAKE-ID/exec'],
  ['script.google.com/macros/s/FAKE-ID/exec', 'U-1'],
  ['http://script.google.com/macros/s/FAKE-ID/exec', 'U-1'],
  ['https://', 'U-1'],
  ['ここに貼り付け', 'U-1'],
  [`${BASE} X/exec`, 'U-1'],
  [`${BASE}\n2/exec`, 'U-1'],
  ['https://someone@script.google.com/macros/s/FAKE-ID/exec', 'U-1'],
  ['http://script.googleusercontent.com/macros/echo?x=1', 'U-1'],
  ['https://script.googleusercontent.com/macros/echo?user_content_key=FAKE', 'U-2'],
  ['https://script.google.com.example.com/macros/s/FAKE-ID/exec', 'U-2'],
  ['https://script.google.com:8443/macros/s/FAKE-ID/exec', 'U-2'],
  ['https://docs.google.com/spreadsheets/d/FAKE-ID/edit', 'U-2'],
  [`${BASE}/dev`, 'U-3'],
  [`${BASE}/dev/`, 'U-3'],
  [`${BASE}/dev?x=1`, 'U-3'],
  [`${BASE}/exec/`, 'U-4'],
  [`${BASE}/exec?x=1`, 'U-4'],
  [`${BASE}/exec#top`, 'U-4'],
  [`${BASE}/exec?`, 'U-4'],
  [`${BASE}/edit`, 'U-4'],
  [BASE, 'U-4'],
  ['https://script.google.com/home/projects/FAKE-ID/edit', 'U-4'],
];

const TOKEN_CASES = [
  ['', 'ok', null],
  [' \n ', 'ok', null],
  ['abcdefghijkl', 'ok', 'abcdefghijkl'], // 12文字ちょうど
  ['a'.repeat(128), 'ok', 'a'.repeat(128)],
  ['!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~', 'ok', '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'], // 記号はすべて使える
  [`  ${FAKE_TOKEN}\n`, 'ok', FAKE_TOKEN], // 貼り付けで混ざった前後の空白・改行は取り除く
  [`　${FAKE_TOKEN}　`, 'ok', FAKE_TOKEN],
  ['abcdef ghijklm', 'K-1'],
  ['abcdef　ghijklm', 'K-1'],
  ['abcdef\tghijklm', 'K-1'],
  ['abcdef\nghijklm', 'K-1'],
  ['ab cd', 'K-1'], // 空白は短さより先
  ['ａｂｃｄｅｆｇｈｉｊｋｌ', 'K-3'], // 全角の英字
  ['abcdefghijklあ', 'K-3'],
  ['abcdefghijkl😀', 'K-3'],
  ['abcdefghijké', 'K-3'],
  ['ａｂ', 'K-3'], // 全角は短さより先
  ['abcdefghijk', 'K-2'], // 11文字
  ['a', 'K-2'],
  ['a'.repeat(129), 'K-4'],
];

function runCases(check, cases) {
  const checks = cases.map(([input, expected, value]) => {
    const r = check(input);
    const ok = expected === 'ok'
      ? r.ok === true && r.value === value
      : r.ok === false && r.code === expected && r.message === SYNC_INPUT_MESSAGES[expected];
    return [`${show(input.length > 40 ? `${input.slice(0, 37)}…` : input)} → ${expected}`, ok, r.ok ? `ok:${show(r.value)}` : r.code];
  });
  return verdict(checks);
}

function inputTests() {
  return [
    t('SY-01', 'Apps Script の URL のチェック（U-1〜U-4 の順・空欄は未設定・前後の空白を取り除く）',
      `${URL_CASES.length}通り`, 'design 14.6.8 の表のとおり（最初に当てはまった1つ）',
      () => runCases(checkGasUrl, URL_CASES)),
    t('SY-02', '合言葉のチェック（K-1 空白 → K-3 半角以外 → K-2 12文字未満 → K-4 129文字以上）',
      `${TOKEN_CASES.length}通り`, 'sheets-setup 11.6 の決まり（12〜128文字・半角の英字・数字・記号）',
      () => runCases(checkSyncToken, TOKEN_CASES)),
    t('SY-03', '入力チェックのエラー文が design 14.6.8 の文と同じ（K-2 は 12文字）',
      'SYNC_INPUT_MESSAGES', 'U-1〜U-4・K-1・K-2 は design の表の文、K-3・K-4 は sheets-setup 13.2 ② の例の文',
      () => {
        const expected = {
          'U-1': 'https:// で始まるURLを貼り付けてください。',
          'U-2': 'Apps Scriptのウェブアプリのアドレス（script.google.com）を入力してください。',
          'U-3': 'テスト用のURL（末尾が /dev）です。「デプロイを管理」に表示される、末尾が /exec のURLを入力してください。',
          'U-4': '末尾が /exec のURLを入力してください。',
          'K-1': '合言葉に空白は使えません。',
          'K-2': '合言葉は12文字以上で入力してください。',
          'K-3': '合言葉は半角の英字・数字・記号で入力してください。',
          'K-4': '合言葉は128文字以内で入力してください。',
        };
        return verdict(Object.entries(expected).map(([code, text]) => [code, SYNC_INPUT_MESSAGES[code] === text, SYNC_INPUT_MESSAGES[code]]));
      }),
    t('SY-04', '合言葉の決まりが gas/Code.gs（Apps Script）と同じ',
      'gas/Code.gs の TOKEN_FORMAT・TOKEN_MIN_LENGTH・TOKEN_MAX_LENGTH・APP_ID・PROTOCOL_VERSION', 'アプリの値と一字一句同じ',
      async () => {
        const code = await readText('gas/Code.gs');
        const pick = (re) => (code.match(re) || [])[1];
        const format = pick(/const TOKEN_FORMAT = \/(.+)\/;/);
        return verdict([
          ['TOKEN_FORMAT', format === TOKEN_FORMAT.source, format],
          ['TOKEN_MIN_LENGTH', Number(pick(/const TOKEN_MIN_LENGTH = (\d+);/)) === TOKEN_MIN_LENGTH, pick(/const TOKEN_MIN_LENGTH = (\d+);/)],
          ['TOKEN_MAX_LENGTH', Number(pick(/const TOKEN_MAX_LENGTH = (\d+);/)) === TOKEN_MAX_LENGTH, pick(/const TOKEN_MAX_LENGTH = (\d+);/)],
          ['APP_ID', pick(/const APP_ID = '([^']+)';/) === SYNC_APP_ID, pick(/const APP_ID = '([^']+)';/)],
          ['PROTOCOL_VERSION', Number(pick(/const PROTOCOL_VERSION = (\d+);/)) === SYNC_PROTOCOL_VERSION, pick(/const PROTOCOL_VERSION = (\d+);/)],
          // チェックを通った合言葉は、Apps Script の式でも必ず通る（12〜128 の境目と記号）
          ['チェックを通った値は TOKEN_FORMAT も通る', TOKEN_CASES.filter(([, e, v]) => e === 'ok' && v).every(([, , v]) => new RegExp(format).test(v)), ''],
        ]);
      }),
  ];
}

/* ---------------------------------------------------------
   SP：接続テスト
   --------------------------------------------------------- */

function pingTests() {
  return [
    t('SP-01', '送り方：POST・headers なし・redirect: follow・credentials: omit・cache: no-store・打ち切り用の signal',
      '成功の応答', 'sheets-setup 11.3 の送り方。本文は { app, v: 1, token, action: "ping" }',
      async () => {
        const f = reply(gas({ action: 'ping', ok: true, sheet: { name: 'trades', state: 'ready' } }));
        await ping(f);
        const { url, init } = f.calls[0] || {};
        let body = null;
        try { body = JSON.parse(init.body); } catch (e) { /* 下で不合格 */ }
        return verdict([
          ['1回だけ送る', f.calls.length === 1, f.calls.length],
          ['保存済みの URL に送る', url === FAKE_URL, url === FAKE_URL ? '' : '別の URL'],
          ['method', init.method === 'POST', init.method],
          ['headers を付けない', !('headers' in init), Object.keys(init).join(',')],
          ['redirect', init.redirect === 'follow', init.redirect],
          ['credentials', init.credentials === 'omit', init.credentials],
          ['cache', init.cache === 'no-store', init.cache],
          ['signal', init.signal instanceof AbortSignal, typeof init.signal],
          ['本文は文字（JSON）', typeof init.body === 'string', typeof init.body],
          ['本文の中身', body && body.app === 'fx-trade-note' && body.v === 1 && body.token === FAKE_TOKEN && body.action === 'ping'
            && Object.keys(body).length === 4, body ? Object.keys(body).join(',') : '読めない'],
        ]);
      }),
    t('SP-02', '応答の振り分け（sheets-setup 11.5 の順の 4〜7）',
      '成功（ready・missing・empty）・BAD_TOKEN・app の印なし・JSON でない・ほかのエラーコード',
      'T-OK／T-2／T-5／T-6 に振り分ける',
      async () => {
        const cases = [
          ['成功（ready）', gas({ action: 'ping', ok: true, sheet: { name: 'trades', state: 'ready' } }), 'ok'],
          ['成功（タブがまだ無い）', gas({ action: 'ping', ok: true, sheet: { name: 'trades', state: 'missing' } }), 'ok'],
          ['成功（タブが空）', gas({ action: 'ping', ok: true, sheet: { name: 'trades', state: 'empty' } }), 'ok'],
          ['BAD_TOKEN', gasError('BAD_TOKEN'), 'badToken'],
          ['app の印がない', { v: 1, action: 'ping', ok: true }, 'notApp'],
          ['app の印がない BAD_TOKEN', { ok: false, error: { code: 'BAD_TOKEN' } }, 'notApp'],
          ['別のアプリの名前', { ...gas({ action: 'ping', ok: true }), app: 'other-app' }, 'notApp'],
          ['JSON でない（HTML のページ）', '<!doctype html><title>Google Drive</title>', 'notApp'],
          ['JSON でない（空）', '', 'notApp'],
          ['JSON の配列', '[]', 'notApp'],
          ['SHEETS_API_NOT_ADDED', gasError('INTERNAL', { reason: 'SHEETS_API_NOT_ADDED' }), 'scriptError'],
          ['TOKEN_NOT_SET', gasError('TOKEN_NOT_SET'), 'scriptError'],
          ['HEADER_MISMATCH', gas({ action: 'ping', ok: false, error: { code: 'HEADER_MISMATCH', column: 'C', expected: 'pair', actual: 'x' } }), 'scriptError'],
          ['NO_SPREADSHEET', gasError('NO_SPREADSHEET'), 'scriptError'],
          ['UNSUPPORTED_VERSION', gasError('UNSUPPORTED_VERSION'), 'scriptError'],
          ['BAD_REQUEST', gasError('BAD_REQUEST'), 'scriptError'],
          ['INTERNAL', gasError('INTERNAL'), 'scriptError'],
          ['error の無い失敗', gas({ action: 'ping', ok: false }), 'scriptError'],
          ['ok だが ping の答えでない', gas({ action: 'upsert', ok: true, results: [] }), 'scriptError'],
        ];
        const checks = [];
        for (const [label, body, expected] of cases) {
          const r = await ping(reply(body));
          checks.push([`${label} → ${expected}`, r.result === expected, r.result]);
        }
        const api = await ping(reply(gasError('INTERNAL', { reason: 'SHEETS_API_NOT_ADDED' })));
        checks.push(['SHEETS_API_NOT_ADDED の reason を覚える', api.code === 'INTERNAL' && api.reason === 'SHEETS_API_NOT_ADDED', `${api.code}/${api.reason}`]);
        const ok = await ping(reply(gas({ action: 'ping', ok: true, sheet: { name: 'trades', state: 'missing' } })));
        checks.push(['成功のタブの状態', ok.sheetState === 'missing', ok.sheetState]);
        return verdict(checks);
      }),
    t('SP-03', '通信できない：オンラインなら T-3（届かない）、オフラインなら T-1。HTTP 200 以外も T-3',
      'fetch が TypeError で失敗（navigator.onLine が true／false）、HTTP 404・500 の応答', 'unreachable／offline／unreachable',
      async () => verdict([
        ['オンラインで失敗 → unreachable', (await ping(networkError())).result === 'unreachable', (await ping(networkError())).result],
        ['オフラインで失敗 → offline', (await ping(networkError(), { isOnline: () => false })).result === 'offline', ''],
        ['HTTP 404 → unreachable', (await ping(reply('Not Found', 404))).result === 'unreachable', ''],
        ['HTTP 500（Apps Script の印付きでも）→ unreachable', (await ping(reply(gas({ action: 'ping', ok: true }), 500))).result === 'unreachable', ''],
      ])),
    t('SP-04', '時間切れ（目安20秒）：打ち切って T-4。signal を無視する fetch・本文の読み込みが終わらない場合も',
      'timeoutMs: 30 で、終わらない fetch 3通り', 'timeout（30ms ほどで終わり、fetch の signal は打ち切られている）',
      async () => {
        const checks = [['既定の時間切れは20秒', PING_TIMEOUT_MS === 20000, PING_TIMEOUT_MS]];
        for (const [label, make] of [['打ち切りに従う fetch', hangUntilAbort], ['signal を無視する fetch', neverEnds], ['本文の読み込みが終わらない', slowBody]]) {
          const f = make();
          const started = Date.now();
          const r = await ping(f, { timeoutMs: 30 });
          const ms = Date.now() - started;
          checks.push([`${label} → timeout`, r.result === 'timeout', r.result]);
          checks.push([`${label}：時間で終わる`, ms < 2000, `${ms}ms`]);
          checks.push([`${label}：signal を打ち切った`, f.calls[0].init.signal.aborted === true, f.calls[0].init.signal.aborted]);
        }
        const off = await ping(hangUntilAbort(), { timeoutMs: 30, isOnline: () => false });
        checks.push(['時間切れでもオフラインなら offline（11.5 の順）', off.result === 'offline', off.result]);
        return verdict(checks);
      }),
    t('SP-05', '画面を離れたとき（呼び出し側の signal）に打ち切ると aborted（画面には何も出さない）',
      '送信中に AbortController.abort()', 'aborted・fetch の signal も打ち切られる・結果の文は null',
      async () => {
        const f = hangUntilAbort();
        const outer = new AbortController();
        const p = ping(f, { signal: outer.signal, timeoutMs: 5000 });
        outer.abort();
        const r = await p;
        const before = new AbortController();
        before.abort();
        const r2 = await ping(hangUntilAbort(), { signal: before.signal, timeoutMs: 5000 });
        return verdict([
          ['aborted', r.result === 'aborted', r.result],
          ['fetch の signal も打ち切られる', f.calls[0].init.signal.aborted, f.calls[0].init.signal.aborted],
          ['始める前に打ち切られていても aborted', r2.result === 'aborted', r2.result],
          ['結果の文は出さない', pingResultText('aborted') === null, pingResultText('aborted')],
        ]);
      }),
    t('SP-06', '結果の文（design 14.6.8 の T-OK・T-1〜T-6）',
      'pingResultText', '表の文と同じ。成功は「接続できました（時:分）」',
      () => {
        const expected = {
          offline: 'オフラインです。通信できる場所でもう一度試してください。',
          badToken: '合言葉が違います。Apps Scriptに設定した合言葉と同じものを入力してください。',
          unreachable: 'Apps Scriptに接続できませんでした。URLと、デプロイの「アクセスできるユーザー」が「全員」になっているかを確認してください。',
          timeout: '応答がありませんでした。時間をおいてもう一度試してください。',
          notApp: 'このアプリ用のApps Scriptではないようです。URLを確認してください。',
          scriptError: 'Apps Scriptでエラーが起きました。手順書の「シートの準備」を確認してください。',
        };
        return verdict([
          ['T-OK', pingResultText('ok', '22:40') === '接続できました（22:40）', pingResultText('ok', '22:40')],
          ...Object.entries(expected).map(([k, text]) => [k, pingResultText(k) === text && PING_RESULT_TEXTS[k] === text, pingResultText(k)]),
        ]);
      }),
    t('SP-07', 'URL・合言葉・要求と応答の本文が console に出ない（全部の結果の種類で）',
      '成功・BAD_TOKEN・SHEETS_API_NOT_ADDED・本文に合言葉を含む応答・URL と合言葉入りの例外・時間切れ・オフライン・HTTP 404・JSON でない応答',
      'console に出た文字に URL・合言葉・応答の本文（error.message）が1つも入っていない。開発者ツールには結果の種類だけ出る',
      async () => {
        const echo = { ...gasError('BAD_TOKEN'), error: { code: 'BAD_TOKEN', message: `応答の本文 ${FAKE_TOKEN} ${FAKE_URL}` } };
        const scenarios = [
          () => reply(gas({ action: 'ping', ok: true, sheet: { name: 'trades', state: 'ready' } })),
          () => reply(echo),
          () => reply(gasError('INTERNAL', { reason: 'SHEETS_API_NOT_ADDED', message: '応答の本文の説明' })),
          () => reply(`<html>${FAKE_URL} ${FAKE_TOKEN}</html>`),
          () => reply(`${FAKE_TOKEN}`, 404),
          networkError,
          hangUntilAbort,
        ];
        let results = [];
        const logged = await captureConsole(async () => {
          results = [];
          for (const make of scenarios) {
            // 既定の出し先（console）を使う
            results.push((await pingAppsScript({ url: FAKE_URL, token: FAKE_TOKEN, fetchImpl: make(), isOnline: () => true, timeoutMs: 30 })).result);
          }
          results.push((await pingAppsScript({ url: FAKE_URL, token: FAKE_TOKEN, fetchImpl: networkError(), isOnline: () => false })).result);
        });
        const bad = leaked(logged, [FAKE_URL, FAKE_TOKEN, 'FAKE-DEPLOYMENT-ID', '応答の本文']);
        return verdict([
          ['シナリオがすべて動いた', results.join(',') === 'ok,badToken,scriptError,notApp,unreachable,unreachable,timeout,offline', results.join(',')],
          ['開発者ツールに結果の種類は出る', logged.length === results.length, logged.length],
          ['URL・合言葉・応答の本文が出ていない', bad.length === 0, bad.join(' | ')],
        ]);
      }),
    t('SP-08', '応答の振り分けは応答の中の変な文字をそのまま返さない（開発者ツールに出す code・reason は英大文字・数字・_ だけ）',
      'error.code に URL・改行入りの文字', 'code は null（出さない）・結果は T-6',
      () => {
        const r = classifyPingResponse(JSON.stringify(gasError(`${FAKE_URL}\n`, { reason: FAKE_TOKEN })));
        return verdict([
          ['scriptError', r.result === 'scriptError', r.result],
          ['code は null', r.code === null, r.code],
          ['reason は null', r.reason === null, r.reason],
        ]);
      }),
  ];
}

/* ---------------------------------------------------------
   SS：設定の保存が URL・合言葉を出さない
   --------------------------------------------------------- */

function fakeStorage() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
}

function storeTests() {
  return [
    t('SS-01', '保存値が壊れているときの警告に URL・合言葉の中身を出さない',
      'fxnote-test:gasUrl・syncToken に JSON でない文字／形の違う値（にせものの保存場所）',
      '初期値（null）を返し、console の警告に中身が入らない',
      async () => {
        const storage = fakeStorage();
        const store = createSettingsStore({ storage, prefix: 'fxnote-test:' });
        const values = [];
        const logged = await captureConsole(() => {
          storage.setItem('fxnote-test:gasUrl', `{broken ${FAKE_URL}`);
          storage.setItem('fxnote-test:syncToken', JSON.stringify({ x: FAKE_TOKEN }));
          values.push(store.get('gasUrl'), store.get('syncToken'));
        });
        const bad = leaked(logged, [FAKE_URL, FAKE_TOKEN]);
        return verdict([
          ['初期値（null）', values[0] === null && values[1] === null, values],
          ['警告は出る', logged.length === 2, logged.length],
          ['中身は出ない', bad.length === 0, bad.join(' | ')],
        ]);
      }),
    t('SS-02', '保存できない値のエラー文に URL・合言葉の中身を出さない（ほかの設定は今までどおり値を出す）',
      'set("syncToken", 空白だけ・オブジェクト)・set("theme", "purple")', 'TypeError の文に中身が入らない',
      () => {
        const store = createSettingsStore({ storage: fakeStorage(), prefix: 'fxnote-test:' });
        const messageOf = (fn) => {
          try { fn(); return ''; } catch (e) { return `${e.name}: ${e.message}`; }
        };
        const a = messageOf(() => store.set('syncToken', { token: FAKE_TOKEN }));
        const b = messageOf(() => store.set('gasUrl', [FAKE_URL]));
        const c = messageOf(() => store.set('theme', 'purple'));
        return verdict([
          ['合言葉：TypeError', a.startsWith('TypeError'), a],
          ['合言葉：中身が出ない', !a.includes(FAKE_TOKEN), a],
          ['URL：中身が出ない', b.startsWith('TypeError') && !b.includes(FAKE_URL), b],
          ['ほかの設定は値を出す（今までどおり）', c.includes('purple'), c],
        ]);
      }),
  ];
}

/* ---------------------------------------------------------
   SC：CSP と Service Worker
   --------------------------------------------------------- */

/** architecture 14.3 の Phase 1 ＋ Phase 2（connect-src に Apps Script の2つのドメイン） */
const EXPECTED_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; "
  + "connect-src 'self' https://script.google.com https://script.googleusercontent.com; manifest-src 'self'; worker-src 'self'; "
  + "object-src 'none'; base-uri 'self'; form-action 'none'";

/** sw.js を Node.js の vm で読み込み、fetch の受け持ちに「にせものの要求」を渡して、横取りする（respondWith）かを見る */
async function loadSwFetchHandler() {
  const vm = await import('node:vm');
  const code = await readText('sw.js');
  const handlers = {};
  const scope = 'https://example.test/fx-trade-note/';
  const self = {
    registration: { scope },
    location: { origin: 'https://example.test', href: `${scope}sw.js` },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    clients: { get: async () => null, claim: async () => {} },
    skipWaiting: () => {},
  };
  const caches = {
    match: async () => null, has: async () => false, open: async () => ({ match: async () => null, put: async () => {} }),
    keys: async () => [], delete: async () => true,
  };
  const context = vm.createContext({ self, caches, fetch: async () => ({ ok: false }), URL, Request: class {}, console, Promise, Set });
  vm.runInContext(code, context, { filename: 'sw.js' });
  /** 要求を1つ渡して、Service Worker が横取りしたか（respondWith を呼んだか） */
  return (url, method, mode = 'cors') => {
    let responded = false;
    handlers.fetch({
      request: { url, method, mode },
      clientId: '',
      respondWith: (p) => { responded = true; Promise.resolve(p).catch(() => {}); },
    });
    return responded;
  };
}

function cspTests() {
  return [
    t('SC-01', 'index.html の CSP：connect-src に Apps Script の2つのドメイン（ほかは Phase 1 のまま）',
      'index.html の <meta http-equiv="Content-Security-Policy">', EXPECTED_CSP,
      async () => {
        const html = await readText('index.html');
        const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1];
        return { actual: show(csp), pass: csp === EXPECTED_CSP };
      }),
    t('SC-02', 'Service Worker は Apps Script への送信（POST）と転送先（googleusercontent）への通信を横取りしない',
      'sw.js の fetch の受け持ちに、script.google.com への POST・script.googleusercontent.com への GET などを渡す',
      'Apps Script への通信はどれも素通し（respondWith しない）。アプリのファイルは今までどおり受け持つ',
      async () => {
        if (!IS_NODE) return { skipped: true, skipReason: 'node-vm', actual: 'Node.js の vm で sw.js を読み込むため、ブラウザではスキップ（node tests/run-node.mjs で確かめる）' };
        const handle = await loadSwFetchHandler();
        return verdict([
          ['script.google.com への POST', handle(FAKE_URL, 'POST') === false, ''],
          ['転送先の script.googleusercontent.com への GET', handle('https://script.googleusercontent.com/macros/echo?user_content_key=FAKE', 'GET') === false, ''],
          ['script.google.com への GET', handle(FAKE_URL, 'GET') === false, ''],
          ['自分のサイトへの POST も触らない', handle('https://example.test/fx-trade-note/x', 'POST') === false, ''],
          ['（確かめ方の確認）アプリのファイルは受け持つ', handle('https://example.test/fx-trade-note/js/app.js', 'GET', 'no-cors') === true, ''],
        ]);
      }),
  ];
}

/* ---------------------------------------------------------
   SG：設定の「スプレッドシート同期」グループ（ブラウザだけ）
   --------------------------------------------------------- */

/** 外から終わらせられる Promise */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * テスト用のグループを作って画面（document）に置く。ping は呼ばれるたびに deferred を積む。
 * @returns 部品と後片付け
 */
async function mountGroup({ gasUrl = null, syncToken = null } = {}) {
  const { syncGroup } = await import('../js/screens/settings-sync.js');
  const store = createSettingsStore({ storage: fakeStorage(), prefix: 'fxnote-test:' });
  if (gasUrl) store.set('gasUrl', gasUrl);
  if (syncToken) store.set('syncToken', syncToken);
  const toasts = [];
  const pings = [];
  const ping = (opts) => {
    const d = deferred();
    pings.push({ opts, ...d });
    return d.promise;
  };
  const g = syncGroup({ store, ping, now: () => '2026-10-28T22:40:05+09:00', toast: (m) => toasts.push(m) });
  const host = document.createElement('div');
  document.body.append(host);
  host.append(g.group);
  const q = (sel) => g.group.querySelector(sel);
  const urlBox = q('textarea');
  const tokenBox = q('input');
  const toggle = q('.form-row__action');
  const testRow = q('.sync-test');
  const messages = () => [...g.group.querySelectorAll('.field-message')].map((m) => m.textContent.replace(/^エラー：/, ''));
  const okText = () => (q('.sync-result') ? q('.sync-result').textContent : null);
  const note = () => q('.sync-note').textContent;
  const type = (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const leave = (el) => el.dispatchEvent(new Event('blur'));
  return {
    g, store, toasts, pings, urlBox, tokenBox, toggle, testRow, messages, okText, note, type, leave,
    cleanup() { g.dispose(); host.remove(); },
  };
}

function groupTests() {
  return [
    td('SG-01', '未設定で開いたとき：見出し・行の並び・見本の文字・伏せ字・「表示」と接続テストは押せない・未設定の説明文',
      '保存値なし', 'design 14.6.8 のワイヤーフレーム①',
      async () => {
        const m = await mountGroup();
        try {
          const rows = [...m.g.group.querySelector('.list-group__body').children];
          return verdict([
            ['見出し', m.g.group.querySelector('.list-group__header').textContent === 'スプレッドシート同期', m.g.group.querySelector('.list-group__header').textContent],
            ['行は3つ（同期状態の行は無い）', rows.length === 3, rows.length],
            ['1行目は URL（縦積み）', rows[0].classList.contains('form-row--stacked') && rows[0].textContent.startsWith('Apps Script URL'), rows[0].textContent],
            ['URL の見本', m.urlBox.placeholder === 'ここに貼り付け', m.urlBox.placeholder],
            ['URL の欄の属性', m.urlBox.getAttribute('inputmode') === 'url' && m.urlBox.getAttribute('autocapitalize') === 'off'
              && m.urlBox.getAttribute('autocorrect') === 'off' && m.urlBox.getAttribute('spellcheck') === 'false'
              && m.urlBox.getAttribute('autocomplete') === 'off' && m.urlBox.getAttribute('enterkeyhint') === 'next' && m.urlBox.rows === 1, ''],
            ['2行目は合言葉', rows[1].textContent.startsWith('合言葉'), rows[1].textContent],
            ['合言葉は伏せ字', m.tokenBox.type === 'password', m.tokenBox.type],
            ['合言葉の見本', m.tokenBox.placeholder === '未設定', m.tokenBox.placeholder],
            ['合言葉の enterkeyhint', m.tokenBox.getAttribute('enterkeyhint') === 'done', m.tokenBox.getAttribute('enterkeyhint')],
            ['「表示」は押せない（空）', m.toggle.textContent === '表示' && m.toggle.disabled, `${m.toggle.textContent}/${m.toggle.disabled}`],
            ['3行目は接続テスト', m.testRow.textContent === '接続テスト' && m.testRow.disabled, `${m.testRow.textContent}/${m.testRow.disabled}`],
            ['未設定の説明文', m.note() === 'URLと合言葉を入れると、接続テストができます。記録の控えをGoogleスプレッドシートに送ります（画像は送りません）。', m.note()],
          ]);
        } finally { m.cleanup(); }
      }),
    td('SG-02', '欄から離れたら保存してトースト（前後の空白は取り除く）。同じ値で離れてもトーストは出さない。そろうと接続テストが押せる',
      'URL を「 URL\\n」、合言葉を「 合言葉 」と入れて離れる → もう一度離れる', '保存値は空白なし・トースト2回・説明文が設定済みの文に',
      async () => {
        const m = await mountGroup();
        try {
          m.type(m.urlBox, `  ${FAKE_URL}  `);
          m.leave(m.urlBox);
          const afterUrl = m.testRow.disabled;
          m.type(m.tokenBox, ` ${FAKE_TOKEN} `);
          m.leave(m.tokenBox);
          m.leave(m.tokenBox);
          m.leave(m.urlBox);
          return verdict([
            ['URL を保存', m.store.get('gasUrl') === FAKE_URL, m.store.get('gasUrl') === FAKE_URL ? '' : '違う'],
            ['合言葉を保存', m.store.get('syncToken') === FAKE_TOKEN, m.store.get('syncToken') === FAKE_TOKEN ? '' : '違う'],
            ['欄の文字も空白なしに', m.urlBox.value === FAKE_URL && m.tokenBox.value === FAKE_TOKEN, ''],
            ['トーストは2回だけ', m.toasts.length === 2 && m.toasts.every((x) => x === '設定を保存しました'), m.toasts],
            ['URL だけでは押せない', afterUrl === true, afterUrl],
            ['そろうと押せる', m.testRow.disabled === false, m.testRow.disabled],
            ['設定済みの説明文', m.note() === '記録の控えをGoogleスプレッドシートに送ります（画像は送りません）。URLと合言葉はこの端末の中にだけ保存されます。', m.note()],
            ['「表示」が押せる', m.toggle.disabled === false, m.toggle.disabled],
          ]);
        } finally { m.cleanup(); }
      }),
    td('SG-03', '誤った値で離れたら：行を赤・エラー文（URL → 合言葉の順に2つ）・保存しない・接続テストは押せない。直すと消える',
      '保存済みの状態から、URL を /dev、合言葉を11文字にして離れる → 直して離れる', 'U-3・K-2 の文、保存値は元のまま',
      async () => {
        const m = await mountGroup({ gasUrl: FAKE_URL, syncToken: FAKE_TOKEN });
        try {
          m.type(m.tokenBox, 'abcdefghijk');
          m.leave(m.tokenBox);
          m.type(m.urlBox, `${BASE}/dev`);
          m.leave(m.urlBox);
          const msgs = m.messages();
          const red = [m.urlBox, m.tokenBox].map((el) => el.closest('.form-row').classList.contains('is-error') && el.getAttribute('aria-invalid') === 'true');
          const disabled = m.testRow.disabled;
          m.type(m.urlBox, FAKE_URL);
          m.leave(m.urlBox);
          m.type(m.tokenBox, FAKE_TOKEN);
          m.leave(m.tokenBox);
          return verdict([
            ['エラー文は URL → 合言葉の順', msgs.length === 2 && msgs[0] === SYNC_INPUT_MESSAGES['U-3'] && msgs[1] === SYNC_INPUT_MESSAGES['K-2'], msgs],
            ['両方の行が赤', red.every(Boolean), red],
            ['保存していない', m.toasts.length === 0, m.toasts],
            ['エラーの間は接続テストを押せない', disabled === true, disabled],
            ['直すとエラー文が消える', m.messages().length === 0, m.messages()],
            ['直すと押せる', m.testRow.disabled === false, m.testRow.disabled],
            ['保存値は元のまま', m.store.get('gasUrl') === FAKE_URL && m.store.get('syncToken') === FAKE_TOKEN, ''],
          ]);
        } finally { m.cleanup(); }
      }),
    td('SG-04', '空にして離れたら「未設定」として保存（エラーにしない）。接続テストは押せなくなり、説明文は未設定の文に',
      '保存済みの状態から URL を空にして離れる', '保存値 null・トースト・押せない',
      async () => {
        const m = await mountGroup({ gasUrl: FAKE_URL, syncToken: FAKE_TOKEN });
        try {
          m.type(m.urlBox, '  ');
          m.leave(m.urlBox);
          return verdict([
            ['保存値は null', m.store.get('gasUrl') === null, m.store.get('gasUrl')],
            ['エラー文なし', m.messages().length === 0, m.messages()],
            ['トースト', m.toasts.length === 1, m.toasts],
            ['押せない', m.testRow.disabled === true, m.testRow.disabled],
            ['未設定の説明文', m.note().startsWith('URLと合言葉を入れると'), m.note()],
          ]);
        } finally { m.cleanup(); }
      }),
    td('SG-05', '「表示」で文字を見せ「隠す」で戻す（aria-pressed）。押してもフォーカスは欄に残る。作り直すと伏せ字',
      '保存済み。合言葉の欄にフォーカス → 表示 → 隠す', 'type が text ↔ password、ボタンの文字が 表示 ↔ 隠す',
      async () => {
        const m = await mountGroup({ gasUrl: FAKE_URL, syncToken: FAKE_TOKEN });
        try {
          m.tokenBox.focus();
          const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
          m.toggle.dispatchEvent(down);
          m.toggle.click();
          const shownState = [m.tokenBox.type, m.toggle.textContent, m.toggle.getAttribute('aria-pressed')];
          const focusKept = document.activeElement === m.tokenBox;
          m.toggle.click();
          const hiddenState = [m.tokenBox.type, m.toggle.textContent, m.toggle.getAttribute('aria-pressed')];
          m.cleanup();
          const m2 = await mountGroup({ gasUrl: FAKE_URL, syncToken: FAKE_TOKEN });
          const again = m2.tokenBox.type;
          m2.cleanup();
          return verdict([
            ['表示', shownState.join('/') === 'text/隠す/true', shownState],
            ['押してもフォーカスが欄から離れない（mousedown の既定を止める）', down.defaultPrevented && focusKept, `${down.defaultPrevented}/${focusKept}`],
            ['隠す', hiddenState.join('/') === 'password/表示/false', hiddenState],
            ['トーストは出ない', m.toasts.length === 0, m.toasts],
            ['作り直すと伏せ字', again === 'password', again],
          ]);
        } finally { m.cleanup(); }
      }),
    td('SG-06', '接続テスト：実行中は「確認中」＋回転アイコンで押せない。成功の文は消えずに残り、URL を変えると消える',
      '保存済み → 接続テスト → ok で終わる → URL を書き換える', '保存済みの値で送る・「✓ 接続できました（22:40）」',
      async () => {
        const m = await mountGroup({ gasUrl: FAKE_URL, syncToken: FAKE_TOKEN });
        try {
          m.testRow.click();
          const busy = [m.testRow.textContent, m.testRow.disabled, Boolean(m.testRow.querySelector('.spinner__icon')), m.testRow.getAttribute('aria-busy')];
          m.testRow.click(); // 実行中に押しても2回目は送らない
          const sent = m.pings.length === 1 ? m.pings[0].opts : {};
          m.pings[0].resolve({ result: 'ok', sheetState: 'ready' });
          await tick();
          const after = [m.testRow.textContent, m.testRow.disabled, Boolean(m.testRow.querySelector('.spinner__icon'))];
          const ok = m.okText();
          const live = m.g.group.querySelector('[role="status"]').textContent;
          m.type(m.urlBox, `${FAKE_URL}x`);
          const cleared = m.okText();
          return verdict([
            ['実行中の表示', busy[0] === '確認中' && busy[1] === true && busy[2] && busy[3] === 'true', busy],
            ['1回だけ送る', m.pings.length === 1, m.pings.length],
            ['保存済みの URL・合言葉で送る', sent.url === FAKE_URL && sent.token === FAKE_TOKEN && sent.signal instanceof AbortSignal, ''],
            ['終わると元の表示', after[0] === '接続テスト' && after[1] === false && !after[2], after],
            ['成功の文', ok === '接続できました（22:40）', ok],
            ['読み上げにも知らせる', live === '接続できました（22:40）', live],
            ['エラー文は無い', m.messages().length === 0, m.messages()],
            ['URL を変えると消える', cleared === null, cleared],
          ]);
        } finally { m.cleanup(); }
      }),
    td('SG-07', '接続テストの失敗：赤の ⚠＋文。合言葉が違う（T-2）ときは合言葉の行も赤。次のテストを始めると消える',
      'badToken → もう一度押す → scriptError', 'T-2 の文と合言葉の行の赤 → T-6 の文（合言葉の行は赤でない）',
      async () => {
        const m = await mountGroup({ gasUrl: FAKE_URL, syncToken: FAKE_TOKEN });
        try {
          m.testRow.click();
          m.pings[0].resolve({ result: 'badToken', code: 'BAD_TOKEN' });
          await tick();
          const t2 = m.messages();
          const tokenRed = m.tokenBox.closest('.form-row').classList.contains('is-error');
          const urlRed = m.urlBox.closest('.form-row').classList.contains('is-error');
          m.testRow.click();
          const during = m.messages();
          m.pings[1].resolve({ result: 'scriptError', code: 'INTERNAL', reason: 'SHEETS_API_NOT_ADDED' });
          await tick();
          const t6 = m.messages();
          return verdict([
            ['T-2 の文', t2.length === 1 && t2[0] === PING_RESULT_TEXTS.badToken, t2],
            ['合言葉の行が赤', tokenRed, tokenRed],
            ['URL の行は赤でない', !urlRed, urlRed],
            ['次のテストを始めると消える', during.length === 0, during],
            ['T-6 の文', t6.length === 1 && t6[0] === PING_RESULT_TEXTS.scriptError, t6],
            ['T-6 では合言葉の行は赤でない', !m.tokenBox.closest('.form-row').classList.contains('is-error'), ''],
            ['成功の文は出ない', m.okText() === null, m.okText()],
            ['押せる（もう一度試せる）', m.testRow.disabled === false, m.testRow.disabled],
          ]);
        } finally { m.cleanup(); }
      }),
    td('SG-08', '実行中に URL・合言葉を変えたら、その結果は捨てる（保存前の入力中でも）。欄を出入りしただけでは捨てない',
      '実行中に合言葉を書き換えて保存 → ok／実行中に URL を書き換えただけ（離れない）→ ok／実行中に欄を出入りするだけ → ok',
      '1・2回目は結果を出さない・3回目は出す',
      async () => {
        const m = await mountGroup({ gasUrl: FAKE_URL, syncToken: FAKE_TOKEN });
        try {
          m.testRow.click();
          m.type(m.tokenBox, `${FAKE_TOKEN}9`);
          m.leave(m.tokenBox);
          m.pings[0].resolve({ result: 'ok' });
          await tick();
          const first = m.okText();
          m.testRow.click();
          m.type(m.urlBox, `${FAKE_URL}x`);
          m.pings[1].resolve({ result: 'ok' });
          await tick();
          const second = m.okText();
          m.type(m.urlBox, FAKE_URL);
          m.testRow.click();
          m.tokenBox.focus();
          m.leave(m.tokenBox);
          m.pings[2].resolve({ result: 'ok' });
          await tick();
          return verdict([
            ['変えて保存したら結果を出さない', first === null, first],
            ['入力中に変えただけでも結果を出さない', second === null, second],
            ['欄を出入りしただけなら出す', m.okText() === '接続できました（22:40）', m.okText()],
          ]);
        } finally { m.cleanup(); }
      }),
    td('SG-09', 'commitFocused：欄に入ったまま画面を離れたとき、正しい値なら保存・誤った値なら保存しない。dispose で実行中のテストを打ち切る',
      'URL の欄に正しい値 → commitFocused／合言葉の欄に誤った値 → commitFocused／実行中に dispose', '1回だけ保存・signal が打ち切られる',
      async () => {
        const m = await mountGroup({ syncToken: FAKE_TOKEN });
        try {
          m.urlBox.focus();
          m.urlBox.value = FAKE_URL;
          m.g.commitFocused();
          const savedUrl = m.store.get('gasUrl');
          m.tokenBox.focus();
          m.tokenBox.value = 'short';
          m.g.commitFocused();
          const savedToken = m.store.get('syncToken');
          m.tokenBox.value = FAKE_TOKEN;
          m.leave(m.tokenBox);
          m.testRow.click();
          const signal = m.pings[0].opts.signal;
          m.g.dispose();
          return verdict([
            ['正しい値は保存', savedUrl === FAKE_URL, savedUrl === FAKE_URL ? '' : '違う'],
            ['誤った値は保存しない', savedToken === FAKE_TOKEN, savedToken === FAKE_TOKEN ? '' : '変わった'],
            ['dispose で打ち切る', signal.aborted === true, signal.aborted],
          ]);
        } finally { m.cleanup(); }
      }),
    td('SG-10', 'URL の欄：改行キーで合言葉の欄へ進み、貼り付けで混ざった改行は取り除く',
      'URL の欄で Enter／改行入りの文字を入れる', '合言葉の欄にフォーカス・URL を保存・改行なし（最大4行の伸び方は画面で目視：テストページは画面の CSS を読まないため）',
      async () => {
        const m = await mountGroup();
        try {
          m.urlBox.focus();
          m.urlBox.value = FAKE_URL;
          const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
          m.urlBox.dispatchEvent(enter);
          const moved = document.activeElement === m.tokenBox;
          const saved = m.store.get('gasUrl');
          m.type(m.urlBox, `${BASE}\n/exec\r\n`);
          const noBreak = m.urlBox.value;
          return verdict([
            ['改行キーの既定（改行の入力）を止める', enter.defaultPrevented, enter.defaultPrevented],
            ['合言葉の欄へ進む', moved, document.activeElement && document.activeElement.tagName],
            ['進んだとき URL を保存（欄から離れた）', saved === FAKE_URL, saved === FAKE_URL ? '' : '違う'],
            ['改行を取り除く', noBreak === `${BASE}/exec`, noBreak],
          ]);
        } finally { m.cleanup(); }
      }),
    td('SG-11', 'URL・合言葉は入力欄の中にだけ出る（グループの文・トースト・属性・console に出ない）',
      '保存済み → 接続テスト（badToken）→ URL を誤った値にする', 'グループの textContent・属性・トースト・console に URL・合言葉が無い',
      async () => {
        let m;
        const logged = await captureConsole(async () => {
          m = await mountGroup({ gasUrl: FAKE_URL, syncToken: FAKE_TOKEN });
          m.toggle.click();
          m.testRow.click();
          m.pings[0].resolve({ result: 'badToken' });
          await tick();
          m.type(m.urlBox, `${FAKE_URL}/dev`);
          m.leave(m.urlBox);
        });
        try {
          const html = m.g.group.outerHTML; // 属性も含めた要素の文字（入力欄の値はプロパティなので入らない）
          const text = m.g.group.textContent;
          const secrets = [FAKE_URL, FAKE_TOKEN, 'FAKE-DEPLOYMENT-ID'];
          return verdict([
            ['入力欄には入っている', m.tokenBox.value === FAKE_TOKEN, ''],
            ['グループの文に出ない', !secrets.some((s) => text.includes(s)), ''],
            ['属性に出ない', !secrets.some((s) => html.includes(s)), ''],
            ['トーストに出ない', !m.toasts.some((x) => secrets.some((s) => x.includes(s))), m.toasts],
            ['console に出ない', leaked(logged, secrets).length === 0, leaked(logged, secrets).join(' | ')],
          ]);
        } finally { m.cleanup(); }
      }),
  ];
}

export function collectSyncTests() {
  return [...inputTests(), ...pingTests(), ...storeTests(), ...cspTests(), ...groupTests()];
}
