/* =========================================================
   tests/ui.test.js
   画面の部品（js/ui/*.js）を実際に作って確かめるテスト（T-33）。
   document を使うものは requires: 'dom'（ブラウザのテストページだけで実行。Node.js ではスキップ）。
   UI-04（javascript: の URL の判定）は document を使わないので Node.js でも実行する。
   画像の保存（IndexedDB）は使わず、業務処理（service）を差し替えた偽物で動かす（本物の記録・画像には触れない）。

   ID：UI-xx
   ========================================================= */
import { imageField } from '../js/ui/image-field.js';
import { h, isDangerousUrl } from '../js/ui/dom.js';
import { show } from './helpers.js';

const CATEGORY = '画面の部品';
const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run, requires: 'dom' });
/** document を使わないテスト（Node.js でも実行する） */
const tn = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run });

/** javascript: の URL の書き方のゆれ（ブラウザはどれも javascript: として実行する：T-31 の S-06） */
const SNEAKY_JS_URLS = [
  'javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', 'java\rscript:alert(1)',
  '\x01javascript:alert(1)', '\x00javascript:alert(1)', 'javascript\u3000:alert(1)', '\u3000javascript:alert(1)',
];
/** 入れてよい URL（アプリが使う形） */
const SAFE_URLS = ['#/trades/abc', '#/new', 'blob:http://localhost:8000/1234', 'https://example.com/javascript:', 'icons/icon-192.png'];

/** 確認項目 [説明, 合否, 実際の値] の一覧から合否を作る（db.test.js と同じ形） */
function verdict(checks) {
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) return { actual: `確認${checks.length}項目すべて一致`, pass: true };
  return { actual: failed.map(([label, , detail]) => `×${label}（実際：${show(detail)}）`).join('／'), pass: false };
}

/** 外から終わらせられる Promise（縮小が終わる時点をテストで決めるため） */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** 小さな本物の画像の Blob（表示用 URL を作れるように。中身は 1x1 の PNG） */
function tinyBlob() {
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

/**
 * 画像の業務処理の偽物。prepareImage は gates に積んだ順に、テストが resolve するまで終わらない。
 * saveImage は ID を 'img-1'・'img-2'… と順に振る。
 */
function fakeService() {
  const gates = [];
  let seq = 0;
  const deleted = [];
  return {
    gates,
    deleted,
    loadImage: async (id) => ({ status: 'ok', image: { id, kind: 'entry', blob: tinyBlob() } }),
    checkLowStorage: async () => false,
    prepareImage: async () => {
      const g = deferred();
      gates.push(g);
      await g.promise;
      return { blob: tinyBlob(), width: 1, height: 1 };
    },
    saveImage: async ({ tradeId, kind, blob }) => { seq += 1; return { id: `img-${seq}`, tradeId, kind, blob }; },
    deleteImages: async (ids) => { deleted.push(...ids); },
    getImage: async (id) => ({ id }),
  };
}

/** 入力欄（type=file）に画像を選んだことにする（画面の操作と同じく change イベントで渡す） */
function pick(field, count) {
  const input = field.el.querySelector('input[type="file"]');
  const dt = new DataTransfer();
  for (let i = 0; i < count; i += 1) dt.items.add(new File([tinyBlob()], `p${i}.png`, { type: 'image/png' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
}

/** Promise の後続（then）が全部動き終わるまで少し待つ */
const settle = () => new Promise((r) => { setTimeout(r, 0); });

export function collectUiTests() {
  return [
    tn('UI-04', 'javascript: の URL の判定は、制御文字・空白を取り除いてから行う（T-33：T-31 の S-06）', 'isDangerousUrl（タブ・改行・制御文字・全角空白・大文字を混ぜた javascript:／アプリが使う URL）',
      '混ぜたものはすべて true。#/…・blob:・https:（途中に javascript: を含むもの）・相対パスは false',
      () => {
        const missed = SNEAKY_JS_URLS.filter((u) => !isDangerousUrl(u));
        const wrong = SAFE_URLS.filter((u) => isDangerousUrl(u));
        return verdict([
          ['見逃しなし', missed.length === 0, missed],
          ['安全な URL を止めない', wrong.length === 0, wrong],
        ]);
      }),

    t('UI-05', 'h() は書き方をゆらした javascript: の URL も href・src に入れない（T-33 S-06）', "h('a', { href: 'java\\tscript:…' }) など",
      'すべて TypeError（要素を作らない）。#/… の href は入る',
      () => {
        const passed = SNEAKY_JS_URLS.filter((u) => {
          try { h('a', { href: u }); return true; } catch (e) { return !(e instanceof TypeError); }
        });
        const okLink = h('a', { href: '#/trades/abc' });
        return verdict([
          ['どれも入らない', passed.length === 0, passed],
          ['#/… は入る', okLink.getAttribute('href') === '#/trades/abc', okLink.getAttribute('href')],
        ]);
      }),

    t('UI-01', '保存中は「画像を追加」と × を押せない（R-04）', 'imageField（追加済み1枚）→ setDisabled(true) → × を押す／setDisabled(false)',
      '無効中：追加の行と × が disabled、× を押しても外れない／解除後：どちらも押せる',
      async () => {
        const service = fakeService();
        const field = imageField({ tradeId: 't1', kind: 'entry', addedIds: ['a1'], service });
        document.body.append(field.el);
        try {
          await field.ready;
          const addBtn = () => field.el.querySelector('.img-add');
          const removeBtn = () => field.el.querySelector('.img-thumb__remove');
          field.setDisabled(true);
          const whileSaving = [addBtn().disabled, removeBtn() && removeBtn().disabled];
          removeBtn().click(); // disabled のボタンは click() でも反応しないが、念のため中の処理でも止めていることを確かめる
          await settle();
          const countAfterClick = field.count();
          field.setDisabled(false);
          const after = [addBtn().disabled, removeBtn() && removeBtn().disabled];
          return verdict([
            ['無効中：追加の行が disabled', whileSaving[0] === true, whileSaving[0]],
            ['無効中：× が disabled（× は消さない）', whileSaving[1] === true, whileSaving[1]],
            ['無効中に × を押しても外れない', countAfterClick === 1 && service.deleted.length === 0, `${countAfterClick}枚／削除 ${service.deleted.length}`],
            ['解除後：追加の行が押せる', after[0] === false, after[0]],
            ['解除後：× が押せる', after[1] === false, after[1]],
          ]);
        } finally {
          field.dispose();
          field.el.remove();
        }
      }),

    t('UI-02', 'whenIdle は待っている間に足した画像も待つ（R-04）', '1枚目の縮小中に whenIdle → 待っている間に2枚目を追加 → 1枚目・2枚目の順に縮小が終わる',
      '1枚目が終わっただけでは whenIdle は終わらない。2枚目まで終わってから終わり、getAddedIds に2枚とも入る',
      async () => {
        const service = fakeService();
        const field = imageField({ tradeId: 't1', kind: 'entry', service });
        document.body.append(field.el);
        try {
          pick(field, 1);
          await settle();
          let idle = false;
          const waiting = field.whenIdle().then(() => { idle = true; });
          pick(field, 1); // 保存を押したあと（whenIdle の待ちの途中）に足した2枚目
          await settle();
          service.gates[0].resolve();
          await settle();
          await settle();
          const idleAfterFirst = idle;
          const addedAfterFirst = field.getAddedIds().length;
          // 2枚目の縮小は、1枚目が終わってから順に始まる（同時に処理しない）
          for (let i = 0; i < 20 && service.gates.length < 2; i += 1) await settle();
          service.gates[1].resolve();
          await waiting;
          return verdict([
            ['1枚目だけでは終わらない', idleAfterFirst === false, idleAfterFirst],
            ['1枚目の時点で追加済みは1枚', addedAfterFirst === 1, addedAfterFirst],
            ['2枚目まで終わってから終わる', idle === true, idle],
            ['2枚とも追加済み', field.getAddedIds().join(',') === 'img-1,img-2', field.getAddedIds()],
          ]);
        } finally {
          field.dispose();
          field.el.remove();
        }
      }),

    t('UI-03', 'whenIdle は処理中の画像がなければすぐ終わる・処理が途中で止まっても待ち続けない', '画像なしで whenIdle／縮小の前の確認（空き容量）が例外で止まった',
      'どちらも終わる（いつまでも「保存中」にならない）',
      async () => {
        const plain = imageField({ tradeId: 't1', kind: 'entry', service: fakeService() });
        const broken = fakeService();
        broken.checkLowStorage = async () => { throw new Error('テスト用の失敗'); };
        const stuck = imageField({ tradeId: 't2', kind: 'entry', service: broken });
        document.body.append(plain.el, stuck.el);
        try {
          const timeout = (p) => Promise.race([p.then(() => true), new Promise((r) => { setTimeout(() => r(false), 1000); })]);
          const a = await timeout(plain.whenIdle());
          pick(stuck, 1);
          await settle();
          const b = await timeout(stuck.whenIdle());
          return verdict([['画像なし', a === true, a], ['処理が途中で止まった', b === true, b]]);
        } finally {
          plain.dispose();
          stuck.dispose();
          plain.el.remove();
          stuck.el.remove();
        }
      }),
  ];
}
