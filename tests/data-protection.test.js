/* =========================================================
   tests/data-protection.test.js
   データ保護まわりの判定（js/data-protection.js）のテスト（T-29。architecture 12.5、design 14.3.8・14.6.1・14.6.2・14.6.6）。
   ・ホーム画面版（standalone）の判定：navigator.standalone（iPhone）と display-mode: standalone（Android・PC）
   ・iPhone・iPad の判定（iPadOS の「Mac を名乗るタッチ端末」を含む）
   ・一覧のお知らせ行「ホーム画面に追加すると…」を出す条件
   ・「ホーム画面への追加」画面の今の状態の文言
   ・永続化リクエスト：すでに保護済みなら頼まない／機能がない・失敗は null／1回の起動で1回だけ
   ・「データの保護」の値と説明文、使用量の表示（MB・小数なし・1MB未満）
   本物のブラウザの機能は使わず、にせものの navigator・matchMedia を渡すので、Node.js でもブラウザでも実行する。

   ID：DP-xx（データ保護）
   ========================================================= */
import {
  isStandalone, isIos, shouldShowInstallNotice, installState, INSTALL_NOTICE,
  readPersisted, requestPersistence, createPersistRequester,
  protectionLabel, protectionNote, PROTECTION_NOTE, PROTECTION_OFF_NOTE,
  readUsage, formatUsage,
} from '../js/data-protection.js';
import { show } from './helpers.js';

const CATEGORY = 'データ保護';

const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run });

/** 確認項目 [名前, 合否, 実際の値] の並びから結果を作る（不合格の項目だけ実際の値を出す） */
function verdict(checks) {
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) return { actual: `確認${checks.length}項目すべて一致`, pass: true };
  return { actual: failed.map(([label, , detail]) => `×${label}（実際：${show(detail)}）`).join('／'), pass: false };
}

/* ---------------------------------------------------------
   にせものの端末
   --------------------------------------------------------- */

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
  ipadOs: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

/**
 * にせものの env（navigator と matchMedia）を作る。
 * @param {{ ua?: string, touch?: number, standalone?: boolean, displayStandalone?: boolean, storage?: object|null }} opts
 */
function fakeEnv({ ua = UA.iphoneSafari, touch = 5, standalone, displayStandalone = false, storage = null } = {}) {
  const navigator = { userAgent: ua, maxTouchPoints: touch };
  if (standalone !== undefined) navigator.standalone = standalone;
  if (storage) navigator.storage = storage;
  return {
    navigator,
    matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' ? displayStandalone : false }),
  };
}

/**
 * にせものの navigator.storage。呼ばれた回数を数える。
 * @param {{ persisted?: boolean, grant?: boolean, throwPersisted?: boolean, usage?: any, throwEstimate?: boolean }} opts
 */
function fakeStorage({ persisted = false, grant = true, throwPersisted = false, usage = 0, throwEstimate = false } = {}) {
  const calls = { persisted: 0, persist: 0, estimate: 0 };
  let state = persisted;
  return {
    calls,
    persisted: async () => { calls.persisted += 1; if (throwPersisted) throw new Error('x'); return state; },
    persist: async () => { calls.persist += 1; state = grant; return grant; },
    estimate: async () => { calls.estimate += 1; if (throwEstimate) throw new Error('x'); return { usage, quota: 1e9 }; },
  };
}

const MB = 1000 * 1000;

export function collectDataProtectionTests() {
  return [
    t('DP-01', 'ホーム画面版の判定：iPhone は navigator.standalone、Android・PC は display-mode: standalone', '6通り',
      'standalone=true／display-mode=standalone はホーム画面版。Safari のタブ・PC のブラウザ・navigator が無い環境は違う',
      () => verdict([
        ['iPhone ホーム画面版', isStandalone(fakeEnv({ standalone: true })) === true, isStandalone(fakeEnv({ standalone: true }))],
        ['iPhone Safari のタブ', isStandalone(fakeEnv({ standalone: false })) === false, isStandalone(fakeEnv({ standalone: false }))],
        ['Android のインストール版', isStandalone(fakeEnv({ ua: UA.android, displayStandalone: true })) === true,
          isStandalone(fakeEnv({ ua: UA.android, displayStandalone: true }))],
        ['PC のブラウザ', isStandalone(fakeEnv({ ua: UA.windows, touch: 0 })) === false, isStandalone(fakeEnv({ ua: UA.windows, touch: 0 }))],
        ['navigator・matchMedia が無い（Node など）', isStandalone({}) === false, isStandalone({})],
        ['matchMedia が例外', isStandalone({ navigator: {}, matchMedia: () => { throw new Error('x'); } }) === false, 'throw'],
      ])),

    t('DP-02', 'iPhone・iPad の判定：iPadOS の「Mac を名乗るタッチ端末」も iPad、本物の Mac・Android・PC は違う', '6通り',
      'iPhone Safari・iPhone Chrome・iPadOS は true。Mac（タッチなし）・Android・Windows・navigator なしは false',
      () => verdict([
        ['iPhone Safari', isIos(fakeEnv({ ua: UA.iphoneSafari })) === true, isIos(fakeEnv({ ua: UA.iphoneSafari }))],
        ['iPhone Chrome', isIos(fakeEnv({ ua: UA.iphoneChrome })) === true, isIos(fakeEnv({ ua: UA.iphoneChrome }))],
        ['iPadOS（Mac を名乗る・タッチ5点）', isIos(fakeEnv({ ua: UA.ipadOs, touch: 5 })) === true, isIos(fakeEnv({ ua: UA.ipadOs, touch: 5 }))],
        ['Mac（タッチなし）', isIos(fakeEnv({ ua: UA.mac, touch: 0 })) === false, isIos(fakeEnv({ ua: UA.mac, touch: 0 }))],
        ['Android', isIos(fakeEnv({ ua: UA.android })) === false, isIos(fakeEnv({ ua: UA.android }))],
        ['navigator が無い', isIos({}) === false, isIos({})],
      ])),

    t('DP-03', 'お知らせ行「ホーム画面に追加すると…」を出す条件', 'iPhone・ホーム画面版・× で閉じた の組み合わせ',
      'iPhone をブラウザで開いていて、まだ閉じていないときだけ出す（ホーム画面版・閉じた後・iPhone 以外は出さない）',
      () => verdict([
        ['iPhone のブラウザ', shouldShowInstallNotice({ ios: true, standalone: false, dismissed: false }) === true, 'true 期待'],
        ['iPhone のホーム画面版', shouldShowInstallNotice({ ios: true, standalone: true, dismissed: false }) === false, 'false 期待'],
        ['× で閉じた後', shouldShowInstallNotice({ ios: true, standalone: false, dismissed: true }) === false, 'false 期待'],
        ['Android・PC のブラウザ', shouldShowInstallNotice({ ios: false, standalone: false, dismissed: false }) === false, 'false 期待'],
      ])),

    t('DP-04', 'お知らせ行の文言と行き先（design 14.3.8）', 'INSTALL_NOTICE',
      '1行目「ホーム画面に追加すると、記録が消えにくくなります」・［方法］・#/settings/install。感嘆符なし',
      () => verdict([
        ['1行目', INSTALL_NOTICE.text === 'ホーム画面に追加すると、記録が消えにくくなります', INSTALL_NOTICE.text],
        ['ボタン', INSTALL_NOTICE.actionLabel === '方法', INSTALL_NOTICE.actionLabel],
        ['行き先', INSTALL_NOTICE.hash === '#/settings/install', INSTALL_NOTICE.hash],
        ['感嘆符なし', !/[!！]/.test(INSTALL_NOTICE.text), INSTALL_NOTICE.text],
      ])),

    t('DP-05', '「ホーム画面への追加」画面の今の状態（design 14.6.6）', 'ホーム画面版／iPhone Safari／iPhone Chrome／Android',
      'ホーム画面版は ✓「ホーム画面のアプリで開いています」。iPhone Safari は ⚠「Safariで開いています」、Safari 以外は ⚠「ブラウザで開いています」',
      () => {
        const home = installState(fakeEnv({ standalone: true }));
        const safari = installState(fakeEnv({ ua: UA.iphoneSafari, standalone: false }));
        const chrome = installState(fakeEnv({ ua: UA.iphoneChrome, standalone: false }));
        const android = installState(fakeEnv({ ua: UA.android }));
        return verdict([
          ['ホーム画面版', home.standalone && home.tone === 'ok' && home.text === 'ホーム画面のアプリで開いています', home],
          ['iPhone Safari', !safari.standalone && safari.tone === 'warning' && safari.text === 'Safariで開いています', safari],
          ['iPhone Chrome', chrome.tone === 'warning' && chrome.text === 'ブラウザで開いています', chrome],
          ['Android のブラウザ', android.tone === 'warning' && android.text === 'ブラウザで開いています', android],
        ]);
      }),

    t('DP-06', '永続化リクエスト：未保護なら persist() を頼み、その結果を返す', 'persisted=false → persist() が true／false',
      '許可なら true、断られたら false。どちらも persist() は1回だけ呼ぶ',
      async () => {
        const ok = fakeStorage({ persisted: false, grant: true });
        const ng = fakeStorage({ persisted: false, grant: false });
        const r1 = await requestPersistence(fakeEnv({ storage: ok }));
        const r2 = await requestPersistence(fakeEnv({ storage: ng }));
        return verdict([
          ['許可', r1 === true && ok.calls.persist === 1, { r1, calls: ok.calls }],
          ['拒否', r2 === false && ng.calls.persist === 1, { r2, calls: ng.calls }],
        ]);
      }),

    t('DP-07', '永続化リクエスト：すでに保護済みなら頼まない', 'persisted=true',
      'true を返し、persist() は呼ばない（PC の Firefox などで確認の画面を余計に出さないため）',
      async () => {
        const s = fakeStorage({ persisted: true });
        const r = await requestPersistence(fakeEnv({ storage: s }));
        return { actual: `結果 ${show(r)}・persist ${s.calls.persist}回`, pass: r === true && s.calls.persist === 0 };
      }),

    t('DP-08', '永続化リクエスト：機能がない・失敗したら null（例外にしない）', 'storage なし／persist だけ無い／persisted が例外',
      'どれも null を返し、例外にならない',
      async () => {
        const r1 = await requestPersistence(fakeEnv({}));
        const r2 = await requestPersistence(fakeEnv({ storage: { persisted: async () => false } }));
        const r3 = await requestPersistence(fakeEnv({ storage: fakeStorage({ throwPersisted: true }) }));
        const r4 = await requestPersistence({});
        return verdict([
          ['storage なし', r1 === null, r1],
          ['persist が無い', r2 === null, r2],
          ['persisted が例外', r3 === null, r3],
          ['navigator が無い', r4 === null, r4],
        ]);
      }),

    t('DP-09', '1回の起動で1回だけ頼む（拒否されても繰り返し求めない：architecture 12.5）', '同じ requester を3回呼ぶ',
      'persist() は1回だけ。2回目以降も1回目と同じ結果（false）',
      async () => {
        const s = fakeStorage({ persisted: false, grant: false });
        const request = createPersistRequester(fakeEnv({ storage: s }));
        const results = [await request(), await request(), await request()];
        return {
          actual: `結果 ${show(results)}・persist ${s.calls.persist}回`,
          pass: results.every((r) => r === false) && s.calls.persist === 1,
        };
      }),

    t('DP-10', '保護の状態を読むだけ（readPersisted）は頼まない', 'persisted=true／false／機能なし／例外',
      'true／false／null／null。どの場合も persist() は呼ばない（設定画面を開くたびに頼まないため）',
      async () => {
        const on = fakeStorage({ persisted: true });
        const off = fakeStorage({ persisted: false });
        const r1 = await readPersisted(fakeEnv({ storage: on }));
        const r2 = await readPersisted(fakeEnv({ storage: off }));
        const r3 = await readPersisted(fakeEnv({}));
        const r4 = await readPersisted(fakeEnv({ storage: fakeStorage({ throwPersisted: true }) }));
        return verdict([
          ['保護済み', r1 === true, r1],
          ['ブラウザ任せ', r2 === false, r2],
          ['機能なし', r3 === null, r3],
          ['例外', r4 === null, r4],
          ['persist を呼ばない', on.calls.persist === 0 && off.calls.persist === 0, { on: on.calls, off: off.calls }],
        ]);
      }),

    t('DP-11', '「データの保護」の値（design 14.6.2）', 'true／false／null',
      '「有効」／「ブラウザ任せ」／null（機能がない環境では行を出さない）',
      () => verdict([
        ['true', protectionLabel(true) === '有効', protectionLabel(true)],
        ['false', protectionLabel(false) === 'ブラウザ任せ', protectionLabel(false)],
        ['null', protectionLabel(null) === null, protectionLabel(null)],
      ])),

    t('DP-12', '「このアプリについて」の説明文（design 14.6.1）', 'true／false／null',
      '基本は「記録はこの端末の中だけに保存されています。…CSVを書き出してください。」。「ブラウザ任せ」のときだけ先頭に「データの保護が有効になっていません。…」',
      () => verdict([
        ['基本の文', PROTECTION_NOTE === '記録はこの端末の中だけに保存されています。機種変更やアプリの削除の前に、CSVを書き出してください。', PROTECTION_NOTE],
        ['有効', protectionNote(true) === PROTECTION_NOTE, protectionNote(true)],
        ['ブラウザ任せ', protectionNote(false) === `${PROTECTION_OFF_NOTE}${PROTECTION_NOTE}`
          && PROTECTION_OFF_NOTE === 'データの保護が有効になっていません。ホーム画面に追加して使うと有効になりやすくなります。', protectionNote(false)],
        ['機能なし（注意を足さない）', protectionNote(null) === PROTECTION_NOTE, protectionNote(null)],
        ['感嘆符なし', !/[!！]/.test(protectionNote(false)), protectionNote(false)],
      ])),

    t('DP-13', '使用量の表示：MB・小数なし・1MB未満（design 14.6.2）', '0／0.999MB／1MB／1.4MB／1.5MB／12.3MB／1234MB',
      '「1 MB未満」「1 MB未満」「1 MB」「1 MB」「2 MB」「12 MB」「1,234 MB」',
      () => verdict([
        ['0', formatUsage(0) === '1 MB未満', formatUsage(0)],
        ['0.999MB', formatUsage(MB - 1) === '1 MB未満', formatUsage(MB - 1)],
        ['1MB ちょうど', formatUsage(MB) === '1 MB', formatUsage(MB)],
        ['1.4MB', formatUsage(1.4 * MB) === '1 MB', formatUsage(1.4 * MB)],
        ['1.5MB（四捨五入）', formatUsage(1.5 * MB) === '2 MB', formatUsage(1.5 * MB)],
        ['12.3MB', formatUsage(12.3 * MB) === '12 MB', formatUsage(12.3 * MB)],
        ['1234MB（3桁区切り）', formatUsage(1234 * MB) === '1,234 MB', formatUsage(1234 * MB)],
      ])),

    t('DP-14', '使用量が無いときは表示しない', 'null／undefined／NaN／負の数／文字',
      'すべて null（設定画面で行を出さない）',
      () => verdict([null, undefined, NaN, -1, '12'].map((v) => [show(v), formatUsage(v) === null, formatUsage(v)]))),

    t('DP-15', '使用量を読む（readUsage）：estimate() の usage を返し、使えない環境は null', 'usage=12MB／estimate なし／例外／usage が無い',
      '12000000／null／null／null',
      async () => {
        const r1 = await readUsage(fakeEnv({ storage: fakeStorage({ usage: 12 * MB }) }));
        const r2 = await readUsage(fakeEnv({ storage: { persist: async () => true, persisted: async () => true } }));
        const r3 = await readUsage(fakeEnv({ storage: fakeStorage({ throwEstimate: true }) }));
        const r4 = await readUsage(fakeEnv({ storage: { estimate: async () => ({ quota: 1e9 }) } }));
        const r5 = await readUsage({});
        return verdict([
          ['12MB', r1 === 12 * MB, r1],
          ['estimate なし', r2 === null, r2],
          ['例外', r3 === null, r3],
          ['usage が無い', r4 === null, r4],
          ['navigator が無い', r5 === null, r5],
        ]);
      }),
  ];
}
