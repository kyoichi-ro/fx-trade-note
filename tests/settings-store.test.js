/* =========================================================
   tests/settings-store.test.js
   設定の保存（js/settings-store.js：localStorage の窓口）のテスト（T-15。architecture 7章、requirements 6.3）。
   localStorage を使うので、ブラウザのテストページでだけ実行する（Node.js ではスキップ：runner.js）。

   本物の設定を壊さないための約束：
   ・テストページ（/tests/）とアプリ（/）は同じ保存場所（オリジン）を使うため、本物の接頭辞「fxnote:」では読み書きしない。
     本物の localStorage を使うテストは接頭辞「fxnote-test:」を使い、各テストの最後に自分のキーを消す。
   ・容量不足・localStorage が使えない場面は、にせものの保存場所（fakeStorage）で再現する。
   ・途中で止まって残った「fxnote-test:」のキーは cleanupTestSettings() でまとめて消す（テストページが最後に呼ぶ）。

   ID：ST-xx（設定の保存）
   ========================================================= */
import { createSettingsStore, settingsStore, SETTING_KEYS, THEMES } from '../js/settings-store.js';
import { LS_PREFIX } from '../js/config.js';
import { isAppError } from '../js/util.js';
import { sameArray, show } from './helpers.js';

const CATEGORY = '設定の保存';

/** 本物の localStorage を使うテストの接頭辞（本物の「fxnote:」とは必ず違う名前） */
export const TEST_PREFIX = 'fxnote-test:';

/**
 * requirements.md 6.3 のキー名（テスト側で独立に書き写したもの。並び順も表のとおり）。
 * settings-store.js の SETTING_KEYS と見比べ、どちらかが打ち間違えていたら不合格になるようにする。
 * syncLastError（同期の最後のエラー）は T-41 で追加（roadmap 7.20 #1 の決定。requirements 6.3 への追記は pm に申し送り済み）。
 */
const REQ_6_3 = [
  'lotUnitSize.demo', 'lotUnitSize.real', 'favoritePairs', 'lastInput', 'listFilter', 'choices', 'theme',
  'lastExportAt', 'gasUrl', 'syncToken', 'syncLastError',
];

/* ---------------------------------------------------------
   小さな道具
   --------------------------------------------------------- */

/** にせものの保存場所（中身は Map）。setItem を失敗させる設定ができる */
function fakeStorage({ failWrite = null } = {}) {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (failWrite) throw failWrite;
      map.set(k, String(v));
    },
    removeItem: (k) => { map.delete(k); },
  };
}

/** 容量不足のエラー（ブラウザが投げるものに似せる） */
function quotaError() {
  try {
    return new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  } catch (e) {
    const err = new Error('The quota has been exceeded.');
    err.name = 'QuotaExceededError';
    return err;
  }
}

/** にせものの保存場所に、生の文字を入れた状態の窓口を作る */
function storeWithRaw(entries) {
  const storage = fakeStorage();
  for (const [k, v] of Object.entries(entries)) storage.map.set(`fxnote:${k}`, v);
  return { store: createSettingsStore({ storage, prefix: 'fxnote:' }), storage };
}

/** 本物の localStorage・テスト用の接頭辞の窓口。使い終わったら自分のキーを消す */
async function withRealStore(fn) {
  const store = createSettingsStore({ storage: () => window.localStorage, prefix: TEST_PREFIX });
  try {
    return await fn(store, window.localStorage);
  } finally {
    for (const k of SETTING_KEYS) window.localStorage.removeItem(`${TEST_PREFIX}${k}`);
  }
}

/** 例外を投げたら、その例外を返す（投げなければ null） */
function caught(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

/** 値を短く見せる（オブジェクトは JSON） */
const j = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : show(v));

/** 1件のテスト定義を作る（localStorage が必要：Node.js ではスキップ） */
const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, requires: 'localStorage', run });

/**
 * 途中で止まって残ったテスト用のキー（fxnote-test:…）をまとめて消す。
 * @returns {number} 消した件数
 */
export function cleanupTestSettings() {
  const ls = window.localStorage;
  const keys = [];
  for (let i = 0; i < ls.length; i += 1) {
    const k = ls.key(i);
    if (k && k.startsWith(TEST_PREFIX)) keys.push(k);
  }
  for (const k of keys) ls.removeItem(k);
  return keys.length;
}

/* ---------------------------------------------------------
   テスト
   --------------------------------------------------------- */

export function collectSettingsStoreTests() {
  return [
    t('ST-01', 'キー名が requirements 6.3 と完全に一致する（11個・並び順も同じ。syncLastError は T-41 で追加）',
      'SETTING_KEYS', REQ_6_3.join(', '),
      () => ({ actual: SETTING_KEYS.join(', '), pass: sameArray([...SETTING_KEYS], REQ_6_3) })),

    t('ST-02', 'アプリ本体の保存キーは接頭辞「fxnote:」付き（architecture 7.1）',
      "settingsStore.storageKey('lotUnitSize.demo') / ('theme')", "'fxnote:lotUnitSize.demo' / 'fxnote:theme'",
      () => {
        const a = settingsStore.storageKey('lotUnitSize.demo');
        const b = settingsStore.storageKey('theme');
        return { actual: `${show(a)} / ${show(b)}`, pass: LS_PREFIX === 'fxnote:' && a === 'fxnote:lotUnitSize.demo' && b === 'fxnote:theme' };
      }),

    t('ST-03', '何も保存されていないときは全キーが初期値（requirements 6.3）',
      '空の保存場所', '1lot 10000/10000、よく使う通貨ペア6つ、テーマ auto、選択肢 6/7/3件、他は null',
      () => {
        const { store } = storeWithRaw({});
        const v = Object.fromEntries(SETTING_KEYS.map((k) => [k, store.get(k)]));
        const c = v.choices;
        const pass = v['lotUnitSize.demo'] === 10000 && v['lotUnitSize.real'] === 10000
          && sameArray(v.favoritePairs, ['USD/JPY', 'EUR/USD', 'GBP/JPY', 'EUR/JPY', 'AUD/JPY', 'GBP/USD'])
          && v.theme === 'auto'
          && sameArray(c.entryReasons, ['トレンドフォロー', '押し目買い・戻り売り', 'ブレイクアウト', 'レンジ逆張り', '経済指標・ニュース', 'その他'])
          && sameArray(c.emotions, ['冷静', '自信', '不安', '焦り', '興奮', '取り返したい', '退屈'])
          && c.tags.length === 3
          && [v.lastInput, v.listFilter, v.lastExportAt, v.gasUrl, v.syncToken].every((x) => x === null);
        return {
          actual: `1lot ${v['lotUnitSize.demo']}/${v['lotUnitSize.real']}、ペア${v.favoritePairs.length}つ、テーマ ${v.theme}、選択肢 ${c.entryReasons.length}/${c.emotions.length}/${c.tags.length}件、`
            + `null：${[v.lastInput, v.listFilter, v.lastExportAt, v.gasUrl, v.syncToken].filter((x) => x === null).length}/5`,
          pass,
        };
      }),

    t('ST-04', '本物の localStorage に保存し、読み直すと同じ値（JSON 文字列で保存）',
      "set('lotUnitSize.real', 100000) → get", "保存値 '100000'、読んだ値 100000",
      () => withRealStore((store, ls) => {
        store.set('lotUnitSize.real', 100000);
        const raw = ls.getItem(`${TEST_PREFIX}lotUnitSize.real`);
        const back = store.get('lotUnitSize.real');
        return { actual: `保存値 ${show(raw)}、読んだ値 ${show(back)}`, pass: raw === '100000' && back === 100000 };
      })),

    t('ST-05', 'テーマは JSON 文字列で保存（boot-theme.js が同じ形で読む）',
      "set('theme', 'dark')", `保存値 '"dark"'、読んだ値 'dark'`,
      () => withRealStore((store, ls) => {
        store.set('theme', 'dark');
        const raw = ls.getItem(`${TEST_PREFIX}theme`);
        return { actual: `保存値 ${show(raw)}、読んだ値 ${show(store.get('theme'))}`, pass: raw === '"dark"' && store.get('theme') === 'dark' };
      })),

    t('ST-06', '保存値が JSON として壊れていても止まらず初期値',
      "fxnote:lotUnitSize.demo = '{'、fxnote:theme = 'dark'（引用符なし）", '10000 / auto（例外なし）',
      () => {
        const { store } = storeWithRaw({ 'lotUnitSize.demo': '{', theme: 'dark' });
        const a = store.get('lotUnitSize.demo');
        const b = store.get('theme');
        return { actual: `${show(a)} / ${show(b)}`, pass: a === 10000 && b === 'auto' };
      }),

    t('ST-07', '1lotの通貨数が1以上の整数でなければ初期値',
      "'\"abc\"'、'0'、'-5'、'1.5'、'1e20'、'null'、'\"10000\"'", 'すべて 10000',
      () => {
        const raws = ['"abc"', '0', '-5', '1.5', '1e20', 'null', '"10000"'];
        const got = raws.map((raw) => storeWithRaw({ 'lotUnitSize.demo': raw }).store.get('lotUnitSize.demo'));
        return { actual: got.join(', '), pass: got.every((x) => x === 10000) };
      }),

    t('ST-08', 'テーマが auto / light / dark 以外なら auto',
      `'"purple"'、'1'、'["dark"]'`, 'auto, auto, auto',
      () => {
        const got = ['"purple"', '1', '["dark"]'].map((raw) => storeWithRaw({ theme: raw }).store.get('theme'));
        return { actual: got.join(', '), pass: got.every((x) => x === 'auto') && sameArray([...THEMES], ['auto', 'light', 'dark']) };
      }),

    t('ST-09', 'よく使う通貨ペア：壊れた要素だけ取り除く。0個・配列でないなら初期値',
      `["USD/JPY",5,"usd/jpy","EUR/USD","EUR/USD"] ／ [] ／ "USD/JPY"`, '[USD/JPY, EUR/USD] ／ 初期値6つ ／ 初期値6つ',
      () => {
        const a = storeWithRaw({ favoritePairs: '["USD/JPY",5,"usd/jpy","EUR/USD","EUR/USD"]' }).store.get('favoritePairs');
        const b = storeWithRaw({ favoritePairs: '[]' }).store.get('favoritePairs');
        const c = storeWithRaw({ favoritePairs: '"USD/JPY"' }).store.get('favoritePairs');
        return {
          actual: `${j(a)} ／ ${b.length}つ ／ ${c.length}つ`,
          pass: sameArray(a, ['USD/JPY', 'EUR/USD']) && b.length === 6 && c.length === 6,
        };
      }),

    t('ST-10', '選択肢：壊れた種類だけ初期値にし、正しい種類（0件も含む）は保存値のまま',
      `{"entryReasons":["独自の根拠"],"emotions":"x","tags":[]}`, 'entryReasons [独自の根拠]、emotions 初期値7件、tags []',
      () => {
        const v = storeWithRaw({ choices: '{"entryReasons":["独自の根拠"],"emotions":"x","tags":[]}' }).store.get('choices');
        return {
          actual: `entryReasons ${j(v.entryReasons)}、emotions ${v.emotions.length}件、tags ${j(v.tags)}`,
          pass: sameArray(v.entryReasons, ['独自の根拠']) && v.emotions.length === 7 && v.tags.length === 0,
        };
      }),

    t('ST-11', '前回入力値：使えない項目だけ null にする（architecture 7.2 の形）',
      `{"accountType":"foo","pair":"USD/JPY","lots":{"demo":"1","real":3}}`,
      `{"accountType":null,"pair":"USD/JPY","lots":{"demo":"1","real":null}}`,
      () => {
        const v = storeWithRaw({ lastInput: '{"accountType":"foo","pair":"USD/JPY","lots":{"demo":"1","real":3}}' }).store.get('lastInput');
        const expected = '{"accountType":null,"pair":"USD/JPY","lots":{"demo":"1","real":null}}';
        return { actual: j(v), pass: JSON.stringify(v) === expected };
      }),

    t('ST-12', 'localStorage そのものが使えない環境：読むと初期値、保存は SETTINGS_WRITE',
      '保存場所を取り出すと例外 → get / set', '10000 ／ AppError SETTINGS_WRITE',
      () => {
        const store = createSettingsStore({ storage: () => { throw new Error('SecurityError'); }, prefix: 'fxnote:' });
        const a = store.get('lotUnitSize.demo');
        const e = caught(() => store.set('lotUnitSize.demo', 20000));
        return { actual: `${show(a)} ／ ${e ? `${e.name} ${e.code || ''}` : '例外なし'}`, pass: a === 10000 && isAppError(e, 'SETTINGS_WRITE') };
      }),

    t('ST-13', '容量不足で保存できない：SETTINGS_WRITE になり、保存値は変わらない',
      "保存値 50000 の状態で setItem が QuotaExceededError → set(…, 20000)", 'AppError SETTINGS_WRITE、読んだ値 50000',
      () => {
        const storage = fakeStorage();
        storage.map.set('fxnote:lotUnitSize.demo', '50000');
        const store = createSettingsStore({ storage, prefix: 'fxnote:' });
        storage.setItem = () => { throw quotaError(); };
        const e = caught(() => store.set('lotUnitSize.demo', 20000));
        const after = store.get('lotUnitSize.demo');
        return {
          actual: `${e ? `${e.name} ${e.code || ''}（元：${e.cause && e.cause.name}）` : '例外なし'}、読んだ値 ${show(after)}`,
          pass: isAppError(e, 'SETTINGS_WRITE') && after === 50000,
        };
      }),

    t('ST-14', '形の違う値は保存しない（TypeError。壊れた値を書き込まない最後の守り）',
      "set('lotUnitSize.demo', 0) ／ set('theme', 'blue')", 'どちらも TypeError、何も保存されない',
      () => {
        const storage = fakeStorage();
        const store = createSettingsStore({ storage, prefix: 'fxnote:' });
        const e1 = caught(() => store.set('lotUnitSize.demo', 0));
        const e2 = caught(() => store.set('theme', 'blue'));
        return {
          actual: `${e1 && e1.name} ／ ${e2 && e2.name}、保存された件数 ${storage.map.size}`,
          pass: e1 instanceof TypeError && e2 instanceof TypeError && storage.map.size === 0,
        };
      }),

    t('ST-15', 'requirements 6.3 にないキー（打ち間違い）は TypeError',
      "get('lotUnitsize.demo')", 'TypeError',
      () => {
        const e = caught(() => settingsStore.get('lotUnitsize.demo'));
        return { actual: e ? e.name : '例外なし', pass: e instanceof TypeError };
      }),

    t('ST-16', '読んだ配列・オブジェクトを書き換えても、保存値・初期値は変わらない',
      "get('favoritePairs').push('XXX/YYY') のあと、もう一度 get", '6つのまま',
      () => {
        const { store } = storeWithRaw({});
        store.get('favoritePairs').push('CHF/JPY');
        store.get('choices').tags.push('追加');
        const again = store.get('favoritePairs');
        return { actual: `ペア${again.length}つ、タグ${store.get('choices').tags.length}件`, pass: again.length === 6 && store.get('choices').tags.length === 3 };
      }),

    t('ST-17', '壊れた値を読んでも、保存されている文字は書き換えない（次に正しい値を保存したときに直る）',
      "fxnote:theme = 'dark'（壊れた値）→ get → set('theme','light')", "読んだ後も 'dark'、保存後は '\"light\"'",
      () => {
        const { store, storage } = storeWithRaw({ theme: 'dark' });
        store.get('theme');
        const kept = storage.map.get('fxnote:theme');
        store.set('theme', 'light');
        const fixed = storage.map.get('fxnote:theme');
        return { actual: `読んだ後 ${show(kept)}、保存後 ${show(fixed)}`, pass: kept === 'dark' && fixed === '"light"' };
      }),

    t('ST-18', 'reset で保存値を消すと初期値に戻る',
      "set('lotUnitSize.demo', 25000) → reset → get", '10000、保存値なし',
      () => withRealStore((store, ls) => {
        store.set('lotUnitSize.demo', 25000);
        store.reset('lotUnitSize.demo');
        const raw = ls.getItem(`${TEST_PREFIX}lotUnitSize.demo`);
        return { actual: `${show(store.get('lotUnitSize.demo'))}、保存値 ${show(raw)}`, pass: store.get('lotUnitSize.demo') === 10000 && raw === null };
      })),

    t('ST-19', 'テストは本物の設定（fxnote:）に触れない',
      'テスト用の窓口で保存した後の localStorage', '「fxnote-test:」のキーだけが増減し、「fxnote:」のキーの数・値は変わらない',
      () => {
        const snapshot = () => {
          const out = {};
          for (let i = 0; i < window.localStorage.length; i += 1) {
            const k = window.localStorage.key(i);
            if (k && k.startsWith('fxnote:')) out[k] = window.localStorage.getItem(k);
          }
          return JSON.stringify(out);
        };
        const before = snapshot();
        return withRealStore((store) => {
          store.set('theme', 'dark');
          store.set('lotUnitSize.demo', 30000);
          const after = snapshot();
          return { actual: before === after ? '変わらない' : `変わった：${before} → ${after}`, pass: before === after };
        });
      }),
  ];
}
