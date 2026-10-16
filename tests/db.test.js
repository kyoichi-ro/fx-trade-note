/* =========================================================
   tests/db.test.js
   保存処理のテスト（T-12：js/db.js と、その上の trades.js / images.js / drafts.js の保存の土台）。
   IndexedDB を使うので、ブラウザのテストページでだけ実行する（Node.js ではスキップ：runner.js）。

   本物の記録を壊さないための約束：
   ・テストは毎回「fx-trade-note-test-…」という別名の DB を作って使い、終わったら DB ごと削除する。
     本物の DB「fx-trade-note」には一切触れない（db.js の deleteDatabase() は本物の名前を拒否する）。
   ・途中で止まって残った別名の DB は cleanupTestDatabases() でまとめて消す（テストページが最後に呼ぶ）。

   ID の意味：DB-xx ＝ db.js（IndexedDB の窓口）、SV-xx ＝ 業務処理（trades / images / drafts）の保存の土台
   ========================================================= */
import {
  createDb, appDb, MIGRATIONS, STORE, INDEX, TRADE_KEYS, IMAGE_KEYS, DRAFT_KEYS, toAppError,
} from '../js/db.js';
import { DB_NAME, DB_VERSION } from '../js/config.js';
import { createTradeService } from '../js/trades.js';
import { createImageService } from '../js/images.js';
import { createDraftService, draftKeyOf } from '../js/drafts.js';
import { toJstString, nowJst } from '../js/datetime.js';
import { on } from '../js/events.js';
import { AppError } from '../js/util.js';

/** テスト用 DB の名前の先頭（本物の DB_NAME とは必ず違う名前にする） */
export const TEST_DB_PREFIX = 'fx-trade-note-test-';

const CATEGORY = '保存処理';

/* ---------------------------------------------------------
   requirements.md 6章のキー名（テスト側で独立に書き写したもの）
   db.js の TRADE_KEYS などと見比べ、どちらかが打ち間違えていたら不合格になるようにする
   --------------------------------------------------------- */
const REQ_6_1 = [
  'id', 'accountType', 'pair', 'side', 'entryPrice', 'entryAt', 'lots', 'lotUnitSize', 'slPrice', 'tpPrice',
  'riskReward', 'exitPrice', 'exitAt', 'pips', 'profitJpy', 'profitSource', 'quoteToJpyRate', 'status',
  'entryReasons', 'timeframe', 'session', 'emotion', 'exitReason', 'exitEmotion', 'tags', 'memo', 'imageIds',
  'syncStatus', 'syncedAt', 'deletedAt', 'createdAt', 'updatedAt',
];
const REQ_6_2 = ['id', 'tradeId', 'kind', 'blob', 'width', 'height', 'createdAt'];
const REQ_6_4 = [
  'key', 'kind', 'tradeId', 'fields', 'uiState', 'addedImageIds', 'removedImageIds', 'baseUpdatedAt',
  'createdAt', 'updatedAt',
];

/* ---------------------------------------------------------
   小さな道具
   --------------------------------------------------------- */

/** 日本時間の固定形式（architecture 6.6）：YYYY-MM-DDTHH:mm:ss+09:00（25文字） */
const JST_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/;
/** UUID v4 の形 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 呼ぶたびに1秒進む時計（日時の付き方を決まった値で確かめるため）。最初は 2026-10-15T21:30:00+09:00 */
function makeClock(startUtc = '2026-10-15T12:30:00Z') {
  const base = Date.parse(startUtc);
  let n = 0;
  return () => toJstString(new Date(base + (n++) * 1000));
}

/** 項目の並び順に関係なく、中身が同じか（Blob は含めない値どうしで使う） */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

/** fn() が失敗したらそのエラーを、成功したら null を返す */
async function errorOf(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

/** エラーの表示用の短い説明 */
const errText = (e) => (e == null ? 'エラーなし' : e instanceof AppError ? `AppError ${e.code}` : `${e.name || 'Error'}`);

/**
 * 確認項目の一覧から合否を作る。checks：[説明, 合否, 実際の値（不合格のときに表示）] の配列。
 * すべて合格なら「確認n項目すべて一致」、不合格があればその項目を並べる。
 */
function verdict(checks) {
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) return { actual: `確認${checks.length}項目すべて一致`, pass: true };
  return {
    actual: failed.map(([label, , detail]) => `×${label}${detail !== undefined ? `（実際：${detail}）` : ''}`).join('／'),
    pass: false,
  };
}

/**
 * 別名のテスト用 DB を作って fn を実行し、成功・失敗にかかわらず最後に DB ごと削除する。
 * @param {string} id テストID（DB 名に入れて、残ったときにどのテストのものか分かるように）
 * @param {(db: object, name: string) => Promise<any>} fn
 * @param {{version?: number, migrations?: object}} [opts]
 */
async function withTestDb(id, fn, { version = DB_VERSION, migrations = MIGRATIONS } = {}) {
  const name = `${TEST_DB_PREFIX}${id}-${Math.random().toString(36).slice(2, 8)}`;
  const db = createDb({ name, version, migrations });
  try {
    return await fn(db, name);
  } finally {
    await db.deleteDatabase();
  }
}

/** テスト用の記録（必要な項目だけ。trades.js を通さず db.js に直接入れるときは全項目をそろえる） */
function sampleTrade(over = {}) {
  const base = {};
  for (const k of TRADE_KEYS) base[k] = null;
  return {
    ...base,
    id: 'trade-1', accountType: 'real', pair: 'USD/JPY', side: 'buy', entryPrice: 150, entryAt: '2026-10-15T21:30:00+09:00',
    lots: 1, lotUnitSize: 10000, status: 'open', entryReasons: [], tags: [], imageIds: [],
    syncStatus: 'pending', createdAt: '2026-10-15T21:30:40+09:00', updatedAt: '2026-10-15T21:30:40+09:00',
    ...over,
  };
}

/** 入力画面から渡される想定の、新規エントリーの項目（必須6項目＋a） */
function entryFields(over = {}) {
  return {
    accountType: 'real', pair: 'USD/JPY', side: 'buy', entryPrice: 150.123, entryAt: '2026-10-15T21:30:00+09:00',
    lots: 0.5, lotUnitSize: 10000, status: 'open', ...over,
  };
}

/** テスト用の小さな画像（中身は文字だが、型は JPEG の Blob） */
const sampleBlob = (text = 'jpeg-data') => new Blob([text], { type: 'image/jpeg' });

function sampleImage(over = {}) {
  return { id: 'img-1', tradeId: 'trade-1', kind: 'entry', blob: sampleBlob(), width: 1280, height: 720, createdAt: '2026-10-15T21:31:00+09:00', ...over };
}

function sampleDraft(over = {}) {
  return {
    key: 'new', kind: 'new', tradeId: 'trade-1', fields: { entryPrice: '150.10' }, uiState: null,
    addedImageIds: [], removedImageIds: [], baseUpdatedAt: null,
    createdAt: '2026-10-15T21:30:00+09:00', updatedAt: '2026-10-15T21:30:05+09:00', ...over,
  };
}

/** 'trades-changed' の通知を記録する。終わったら stop() で受け取りをやめる */
function recordTradeEvents() {
  const list = [];
  const stop = on('trades-changed', (d) => list.push(d));
  return { list, stop };
}

/** 生の IndexedDB 接続から、ストアの形（keyPath・インデックス）を読む */
function describeStores(idb) {
  const names = [...idb.objectStoreNames];
  const tx = idb.transaction(names, 'readonly');
  const out = {};
  for (const n of names) {
    const s = tx.objectStore(n);
    out[n] = {
      keyPath: s.keyPath,
      indexes: [...s.indexNames].map((i) => {
        const ix = s.index(i);
        return { name: i, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry };
      }),
    };
  }
  return out;
}

/* ---------------------------------------------------------
   テストの定義
   --------------------------------------------------------- */

/** テスト1件の定義を作る（分類・ブラウザ専用の印を共通で付ける） */
const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, requires: 'indexedDB', run });

export function collectDbTests() {
  return [
    /* ===== db.js（IndexedDB の窓口） ===== */

    t('DB-01', 'DB の形（ストア・キー・インデックス・バージョン）', 'MIGRATIONS で新しく DB を作る',
      'trades(id・index syncStatus)／images(id・index tradeId)／drafts(key)、バージョン1、DB名 fx-trade-note（architecture 6.1〜6.3）',
      () => withTestDb('DB-01', async (db) => {
        const idb = await db.openDb();
        const s = describeStores(idb);
        const ix = (store) => (s[store] ? s[store].indexes : []);
        return verdict([
          ['config の DB 名', DB_NAME === 'fx-trade-note', DB_NAME],
          ['config のバージョン', DB_VERSION === 1, DB_VERSION],
          ['開いた DB のバージョン', idb.version === 1, idb.version],
          ['ストアは3つ', sameList([...idb.objectStoreNames].sort(), ['drafts', 'images', 'trades']), [...idb.objectStoreNames].join(',')],
          ['trades のキー', s.trades && s.trades.keyPath === 'id'],
          ['images のキー', s.images && s.images.keyPath === 'id'],
          ['drafts のキー', s.drafts && s.drafts.keyPath === 'key'],
          ['trades のインデックス', deepEqual(ix('trades'), [{ name: 'syncStatus', keyPath: 'syncStatus', unique: false, multiEntry: false }]), JSON.stringify(ix('trades'))],
          ['images のインデックス', deepEqual(ix('images'), [{ name: 'tradeId', keyPath: 'tradeId', unique: false, multiEntry: false }]), JSON.stringify(ix('images'))],
          ['drafts はインデックスなし', ix('drafts').length === 0],
          ['定数 STORE・INDEX', STORE.TRADES === 'trades' && STORE.IMAGES === 'images' && STORE.DRAFTS === 'drafts'
            && INDEX.TRADES_SYNC_STATUS === 'syncStatus' && INDEX.IMAGES_TRADE_ID === 'tradeId'],
        ]);
      })),

    t('DB-02', 'キー名が requirements.md 6章と完全一致', 'db.js の TRADE_KEYS・IMAGE_KEYS・DRAFT_KEYS',
      '6.1 の32項目・6.2 の7項目・6.4 の10項目と、名前も順番も一致',
      async () => verdict([
        ['trades（6.1）32項目', sameList(TRADE_KEYS, REQ_6_1), TRADE_KEYS.length],
        ['images（6.2）7項目', sameList(IMAGE_KEYS, REQ_6_2), IMAGE_KEYS.length],
        ['drafts（6.4）10項目', sameList(DRAFT_KEYS, REQ_6_4), DRAFT_KEYS.length],
      ])),

    t('DB-03', '接続の使い回し', 'openDb() を2回呼ぶ', '同じ接続が返る（毎回開き直さない：6.10）',
      () => withTestDb('DB-03', async (db) => {
        const a = await db.openDb();
        const b = await db.openDb();
        return verdict([['同じ接続', a === b]]);
      })),

    t('DB-04', 'trades の追加と1件取得', "addTrade(記録) → getTrade(id)、getTrade('ない ID')",
      '保存した内容がそのまま返る。ない ID は null',
      () => withTestDb('DB-04', async (db) => {
        const trade = sampleTrade({ memo: 'テスト', tags: ['指標前'] });
        await db.addTrade(trade);
        const got = await db.getTrade('trade-1');
        const none = await db.getTrade('no-such-id');
        return verdict([
          ['内容が一致', deepEqual(got, trade), JSON.stringify(got)],
          ['ない ID は null', none === null, String(none)],
        ]);
      })),

    t('DB-05', '二重保存の防止', '同じ id で addTrade を2回',
      '2回目は AppError DUPLICATE。記録は1件のまま、1回目の内容が残る（6.10・15.1）',
      () => withTestDb('DB-05', async (db) => {
        await db.addTrade(sampleTrade({ memo: '1回目' }));
        const err = await errorOf(() => db.addTrade(sampleTrade({ memo: '2回目' })));
        const all = await db.getAllTrades();
        return verdict([
          ['DUPLICATE', err instanceof AppError && err.code === 'DUPLICATE', errText(err)],
          ['日本語の説明付き', err instanceof AppError && /[ぁ-ん]/.test(err.message), err && err.message],
          ['1件のまま', all.length === 1, all.length],
          ['1回目の内容', all[0] && all[0].memo === '1回目', all[0] && all[0].memo],
        ]);
      })),

    t('DB-06', '上書き保存と全件取得', 'putTrade で書き換え、削除済み（deletedAt あり）の記録も追加して getAllTrades',
      '書き換えが反映され、全件取得は削除済みも含む（絞り込みは呼び出し側：6.10）',
      () => withTestDb('DB-06', async (db) => {
        await db.addTrade(sampleTrade());
        await db.putTrade(sampleTrade({ exitPrice: 150.25, status: 'closed' }));
        await db.addTrade(sampleTrade({ id: 'trade-2', deletedAt: '2026-10-15T22:00:00+09:00' }));
        const got = await db.getTrade('trade-1');
        const all = await db.getAllTrades();
        return verdict([
          ['書き換えが反映', got.exitPrice === 150.25 && got.status === 'closed', JSON.stringify(got)],
          ['削除済みも含めて2件', all.length === 2, all.length],
        ]);
      })),

    t('DB-07', 'インデックスで取得（未送信キュー）', "syncStatus が pending・synced・error の3件 → getTradesByIndex('syncStatus', 'pending')",
      'pending の1件だけが返る（Phase 2 の未送信キュー：3.3・6.3）',
      () => withTestDb('DB-07', async (db) => {
        await db.addTrade(sampleTrade({ id: 'a', syncStatus: 'pending' }));
        await db.addTrade(sampleTrade({ id: 'b', syncStatus: 'synced' }));
        await db.addTrade(sampleTrade({ id: 'c', syncStatus: 'error' }));
        const pending = await db.getTradesByIndex(INDEX.TRADES_SYNC_STATUS, 'pending');
        const all = await db.getTradesByIndex(INDEX.TRADES_SYNC_STATUS);
        return verdict([
          ['pending は a だけ', pending.length === 1 && pending[0].id === 'a', pending.map((x) => x.id).join(',')],
          ['範囲なしは全件', all.length === 3, all.length],
        ]);
      })),

    t('DB-08', 'images の追加・取得・トレード単位・物理削除', '画像3枚（trade-1 に2枚、trade-2 に1枚）を追加 → 取得 → 1枚削除',
      'Blob の中身・型が保たれる。トレード単位で2枚。削除した画像だけが消える。ID の配列以外は TypeError',
      () => withTestDb('DB-08', async (db) => {
        await db.addImage(sampleImage({ id: 'i1', blob: sampleBlob('one') }));
        await db.addImage(sampleImage({ id: 'i2', kind: 'exit' }));
        await db.addImage(sampleImage({ id: 'i3', tradeId: 'trade-2' }));
        const got = await db.getImage('i1');
        const text = got && got.blob instanceof Blob ? await got.blob.text() : null;
        const ofTrade1 = await db.getImagesByTrade('trade-1');
        await db.deleteImages(['i1', 'no-such-image']);
        const afterDelete = await db.getImage('i1');
        const left = (await db.getImagesByTrade('trade-1')).map((x) => x.id);
        const badArg = await errorOf(() => db.deleteImages('i2'));
        return verdict([
          ['Blob のまま', got && got.blob instanceof Blob],
          ['Blob の中身', text === 'one', text],
          ['Blob の型', got && got.blob.type === 'image/jpeg', got && got.blob.type],
          ['幅・高さ', got && got.width === 1280 && got.height === 720],
          ['trade-1 の画像は2枚', ofTrade1.length === 2, ofTrade1.length],
          ['削除した画像は null', afterDelete === null],
          ['残りは i2 だけ', sameList(left, ['i2']), left.join(',')],
          ['文字列1つは TypeError', badArg instanceof TypeError, errText(badArg)],
          ['i2 は消えていない', (await db.getImage('i2')) !== null],
        ]);
      })),

    t('DB-09', 'drafts の保存・取得・全件・削除', "putDraft を同じキーで2回 → getDraft・getAllDrafts → deleteDraft('new')",
      '同じキーは上書きで1件。削除後は null',
      () => withTestDb('DB-09', async (db) => {
        await db.putDraft(sampleDraft());
        await db.putDraft(sampleDraft({ fields: { entryPrice: '150.12' } }));
        await db.putDraft(sampleDraft({ key: 'close:trade-9', kind: 'close', tradeId: 'trade-9' }));
        const got = await db.getDraft('new');
        const all = await db.getAllDrafts();
        await db.deleteDraft('new');
        await db.deleteDraft('no-such-key'); // ないキーの削除は失敗にしない
        return verdict([
          ['上書きされた', got && got.fields.entryPrice === '150.12', got && JSON.stringify(got.fields)],
          ['全件は2件', all.length === 2, all.length],
          ['削除後は null', (await db.getDraft('new')) === null],
          ['他の下書きは残る', (await db.getDraft('close:trade-9')) !== null],
        ]);
      })),

    t('DB-10', '記録の保存＋下書きの削除を1回で', 'runTx([trades, drafts]) の中で addTrade と deleteDraft',
      '両方が反映される（8章）。fn の戻り値が返る',
      () => withTestDb('DB-10', async (db) => {
        await db.putDraft(sampleDraft());
        const ret = await db.runTx([STORE.TRADES, STORE.DRAFTS], async (ops) => {
          await ops.add(STORE.TRADES, sampleTrade());
          await ops.delete(STORE.DRAFTS, 'new');
          return 'done';
        });
        return verdict([
          ['戻り値', ret === 'done', ret],
          ['記録が保存された', (await db.getTrade('trade-1')) !== null],
          ['下書きが消えた', (await db.getDraft('new')) === null],
        ]);
      })),

    t('DB-11', '途中で失敗したら全部取り消し', 'runTx の中で 記録の書き換え → 下書き削除 → 同じ id の add（失敗）',
      'AppError DUPLICATE。記録の書き換えも下書きの削除も取り消され、元のまま残る',
      () => withTestDb('DB-11', async (db) => {
        await db.addTrade(sampleTrade({ memo: '元の内容' }));
        await db.putDraft(sampleDraft());
        const err = await errorOf(() => db.runTx([STORE.TRADES, STORE.DRAFTS], async (ops) => {
          await ops.put(STORE.TRADES, sampleTrade({ memo: '書き換え' }));
          await ops.delete(STORE.DRAFTS, 'new');
          await ops.add(STORE.TRADES, sampleTrade({ memo: '重複' }));
        }));
        const trade = await db.getTrade('trade-1');
        return verdict([
          ['DUPLICATE', err instanceof AppError && err.code === 'DUPLICATE', errText(err)],
          ['記録は元のまま', trade && trade.memo === '元の内容', trade && trade.memo],
          ['下書きは残っている', (await db.getDraft('new')) !== null],
        ]);
      })),

    t('DB-12', 'プログラムの誤りは握りつぶさない', 'runTx の中で書き込み後に TypeError を投げる',
      '同じ TypeError がそのまま返り（AppError に変えない）、書き込みは取り消される',
      () => withTestDb('DB-12', async (db) => {
        const thrown = new TypeError('わざと起こした誤り');
        const err = await errorOf(() => db.runTx([STORE.TRADES], async (ops) => {
          await ops.put(STORE.TRADES, sampleTrade());
          throw thrown;
        }));
        return verdict([
          ['同じエラーが返る', err === thrown, errText(err)],
          ['書き込みは取り消し', (await db.getTrade('trade-1')) === null],
        ]);
      })),

    t('DB-13', 'DB を開けない（DB_OPEN）', 'IndexedDB がない環境を再現（factory: null）して openDb・addTrade',
      'どちらも AppError DB_OPEN が呼び出し元に返る（15.1）',
      async () => {
        const db = createDb({ name: `${TEST_DB_PREFIX}DB-13`, version: 1, migrations: MIGRATIONS, factory: null });
        const e1 = await errorOf(() => db.openDb());
        const e2 = await errorOf(() => db.addTrade(sampleTrade()));
        return verdict([
          ['openDb は DB_OPEN', e1 instanceof AppError && e1.code === 'DB_OPEN', errText(e1)],
          ['addTrade も DB_OPEN', e2 instanceof AppError && e2.code === 'DB_OPEN', errText(e2)],
        ]);
      }),

    t('DB-14', '古いアプリで新しい DB を開いた（VERSION）', 'バージョン2の DB に記録を入れる → バージョン1のアプリで開く',
      'AppError VERSION。データには触らない（バージョン2で開き直すと記録が残っている：6.11）',
      async () => {
        const name = `${TEST_DB_PREFIX}DB-14-${Math.random().toString(36).slice(2, 8)}`;
        const v2 = createDb({ name, version: 2, migrations: { ...MIGRATIONS, 2: () => {} } });
        const v1 = createDb({ name, version: 1, migrations: MIGRATIONS });
        try {
          await v2.addTrade(sampleTrade());
          await v2.closeDb();
          const err = await errorOf(() => v1.openDb());
          const kept = await v2.getTrade('trade-1');
          return verdict([
            ['VERSION', err instanceof AppError && err.code === 'VERSION', errText(err)],
            ['記録は残っている', kept !== null],
          ]);
        } finally {
          await v1.closeDb();
          await v2.deleteDatabase();
        }
      }),

    t('DB-15', '移行処理（v1 → v2）でデータが残る', 'v1 で記録2件 → インデックス追加と項目追加をする v2 の移行で開き直す',
      'バージョン2になり、インデックスが増え、記録2件の元の値が残ったまま新しい項目が入る（6.11 移行のテスト）',
      async () => {
        const name = `${TEST_DB_PREFIX}DB-15-${Math.random().toString(36).slice(2, 8)}`;
        const v1 = createDb({ name, version: 1, migrations: MIGRATIONS });
        const v2 = createDb({
          name,
          version: 2,
          migrations: {
            ...MIGRATIONS,
            2: (idb, tx) => {
              const store = tx.objectStore('trades');
              store.createIndex('exitAt', 'exitAt', { unique: false });
              store.openCursor().onsuccess = (e) => {
                const cur = e.target.result;
                if (!cur) return;
                cur.update({ ...cur.value, migratedForTest: true });
                cur.continue();
              };
            },
          },
        });
        try {
          await v1.addTrade(sampleTrade({ id: 'a', memo: 'メモA' }));
          await v1.addTrade(sampleTrade({ id: 'b', memo: 'メモB' }));
          await v1.closeDb();
          const idb = await v2.openDb();
          const s = describeStores(idb);
          const all = await v2.getAllTrades();
          const a = all.find((x) => x.id === 'a');
          return verdict([
            ['バージョン2', idb.version === 2, idb.version],
            ['インデックスが2つ', s.trades.indexes.map((i) => i.name).sort().join(',') === 'exitAt,syncStatus', s.trades.indexes.map((i) => i.name).join(',')],
            ['記録は2件', all.length === 2, all.length],
            ['新しい項目が入った', all.every((x) => x.migratedForTest === true)],
            ['元の値が残る', a && a.memo === 'メモA' && a.entryPrice === 150, a && JSON.stringify(a)],
          ]);
        } finally {
          await v1.closeDb();
          await v2.deleteDatabase();
        }
      }),

    t('DB-16', '移行は1段ずつ順番に', 'v1 の DB を v3 で開く／新しい DB を v3 で作る',
      'v1 → v3 は「2 → 3」、新規は「1 → 2 → 3」の順に実行される（6.11）',
      async () => {
        const name = `${TEST_DB_PREFIX}DB-16-${Math.random().toString(36).slice(2, 8)}`;
        const name2 = `${name}-new`;
        const order = [];
        const tracked = {
          1: (idb, tx, oldV) => { MIGRATIONS[1](idb, tx, oldV); order.push(1); },
          2: () => order.push(2),
          3: () => order.push(3),
        };
        const v1 = createDb({ name, version: 1, migrations: MIGRATIONS });
        const v3 = createDb({ name, version: 3, migrations: tracked });
        const fresh = createDb({ name: name2, version: 3, migrations: tracked });
        try {
          await v1.openDb();
          await v1.closeDb();
          await v3.openDb();
          const upgrade = order.join('→');
          order.length = 0;
          await fresh.openDb();
          const created = order.join('→');
          return verdict([
            ['v1 → v3', upgrade === '2→3', upgrade],
            ['新規 → v3', created === '1→2→3', created],
          ]);
        } finally {
          await v1.closeDb();
          await v3.deleteDatabase();
          await fresh.deleteDatabase();
        }
      }),

    t('DB-17', '移行に失敗したら古い DB のまま', 'v1 で記録1件 → 途中で書き換えてから失敗する v2 の移行で開く',
      'AppError DB_OPEN。バージョン1のまま、記録も書き換え前の内容で残る（6.11）',
      async () => {
        const name = `${TEST_DB_PREFIX}DB-17-${Math.random().toString(36).slice(2, 8)}`;
        const v1 = createDb({ name, version: 1, migrations: MIGRATIONS });
        const broken = createDb({
          name,
          version: 2,
          migrations: {
            ...MIGRATIONS,
            2: (idb, tx) => {
              tx.objectStore('trades').put(sampleTrade({ memo: '移行で書き換え' }));
              throw new Error('わざと失敗させた移行');
            },
          },
        });
        try {
          await v1.addTrade(sampleTrade({ memo: '元の内容' }));
          await v1.closeDb();
          const err = await errorOf(() => broken.openDb());
          const idb = await v1.openDb();
          const kept = await v1.getTrade('trade-1');
          return verdict([
            ['DB_OPEN', err instanceof AppError && err.code === 'DB_OPEN', errText(err)],
            ['バージョン1のまま', idb.version === 1, idb.version],
            ['記録は元の内容', kept && kept.memo === '元の内容', kept && kept.memo],
          ]);
        } finally {
          await broken.closeDb();
          await v1.deleteDatabase();
        }
      }),

    t('DB-18', '移行処理が抜けている', 'バージョン3で開くのに、移行処理が 1・2 しかない',
      'AppError DB_OPEN（半端な形の DB を作らない）',
      () => withTestDb('DB-18', async (db) => {
        const err = await errorOf(() => db.openDb());
        return verdict([['DB_OPEN', err instanceof AppError && err.code === 'DB_OPEN', errText(err)]]);
      }, { version: 3, migrations: { ...MIGRATIONS, 2: () => {} } })),

    t('DB-19', 'エラーの変換（容量不足など）', 'IndexedDB のエラー名ごとに toAppError(err, \'DB_WRITE\')',
      'QuotaExceededError→QUOTA、UnknownError・原因なし→DB_WRITE、ConstraintError→DUPLICATE、VersionError→VERSION。元のエラーは cause に残る',
      async () => {
        const dom = (n) => new DOMException('test', n);
        const quota = dom('QuotaExceededError');
        const r = (e, fb = 'DB_WRITE') => toAppError(e, fb);
        const existing = new AppError('NOT_FOUND', '見つかりません');
        return verdict([
          ['容量不足 → QUOTA', r(quota).code === 'QUOTA', r(quota).code],
          ['元のエラーを cause に', r(quota).cause === quota],
          ['UnknownError → DB_WRITE', r(dom('UnknownError')).code === 'DB_WRITE', r(dom('UnknownError')).code],
          ['原因なし（iOS の中断）→ DB_WRITE', r(null).code === 'DB_WRITE', r(null).code],
          ['DB_WRITE は容量不足の可能性も案内', /容量/.test(r(null).message), r(null).message],
          ['読み込みの失敗 → DB_READ', r(dom('UnknownError'), 'DB_READ').code === 'DB_READ'],
          ['ConstraintError → DUPLICATE', r(dom('ConstraintError')).code === 'DUPLICATE'],
          ['VersionError → VERSION', r(dom('VersionError'), 'DB_OPEN').code === 'VERSION'],
          ['AppError はそのまま', r(existing) === existing],
        ]);
      }),

    t('DB-20', '本物の DB を消す関数を出していない', 'アプリ本体が使う appDb',
      'appDb に deleteDatabase がなく、appDb は書き換え不可（本物の記録を消す事故の防止）',
      async () => verdict([
        ['deleteDatabase がない', !('deleteDatabase' in appDb)],
        ['書き換え不可', Object.isFrozen(appDb)],
      ])),

    /* ===== 業務処理の保存の土台（trades / images / drafts） ===== */

    t('SV-01', '新規保存で自動で付く値', 'saveNewTrade(必須項目だけ。createdAt・syncStatus:synced も渡してみる)',
      'id＝UUID、createdAt＝updatedAt＝今（日本時間の固定形式）、syncStatus＝pending、syncedAt・deletedAt＝null。'
        + '32項目すべて（未入力は null、配列は []）。渡した createdAt・syncStatus は使わない',
      () => withTestDb('SV-01', async (db) => {
        const trades = createTradeService({ db, now: makeClock() });
        const saved = await trades.saveNewTrade(entryFields({ createdAt: '2000-01-01T00:00:00+09:00', syncStatus: 'synced' }));
        const stored = await db.getTrade(saved.id);
        return verdict([
          ['id は UUID', UUID_V4.test(saved.id), saved.id],
          ['createdAt＝今', saved.createdAt === '2026-10-15T21:30:00+09:00', saved.createdAt],
          ['updatedAt＝createdAt', saved.updatedAt === saved.createdAt, saved.updatedAt],
          ['日時は25文字の固定形式', JST_FORMAT.test(saved.createdAt) && saved.createdAt.length === 25],
          ['syncStatus＝pending', saved.syncStatus === 'pending', saved.syncStatus],
          ['syncedAt・deletedAt＝null', saved.syncedAt === null && saved.deletedAt === null],
          ['32項目が 6.1 の順', sameList(Object.keys(saved), REQ_6_1), Object.keys(saved).length],
          ['未入力は null', saved.slPrice === null && saved.memo === null && saved.exitAt === null],
          ['配列は []', sameList(saved.entryReasons, []) && sameList(saved.tags, []) && sameList(saved.imageIds, [])],
          ['入力値はそのまま', saved.entryPrice === 150.123 && saved.lots === 0.5 && saved.pair === 'USD/JPY'],
          ['DB の中身＝戻り値', deepEqual(stored, saved), stored && JSON.stringify(stored)],
        ]);
      })),

    t('SV-02', '新規保存（画面で採番した ID・下書き削除・通知・二重保存）', "saveNewTrade({id:'entry-abc',…}, {draftKey:'new'}) を2回",
      'ID はそのまま。下書きは同時に消える。通知 add が1回。2回目は DUPLICATE で通知なし',
      () => withTestDb('SV-02', async (db) => {
        const trades = createTradeService({ db, now: makeClock() });
        await db.putDraft(sampleDraft({ tradeId: 'entry-abc' }));
        const ev = recordTradeEvents();
        try {
          const saved = await trades.saveNewTrade(entryFields({ id: 'entry-abc' }), { draftKey: 'new' });
          const err = await errorOf(() => trades.saveNewTrade(entryFields({ id: 'entry-abc' }), { draftKey: 'new' }));
          return verdict([
            ['ID はそのまま', saved.id === 'entry-abc', saved.id],
            ['下書きが消えた', (await db.getDraft('new')) === null],
            ['2回目は DUPLICATE', err instanceof AppError && err.code === 'DUPLICATE', errText(err)],
            ['通知は add が1回', ev.list.length === 1 && ev.list[0].type === 'add' && ev.list[0].id === 'entry-abc', JSON.stringify(ev.list.map((e) => e.type))],
            ['通知に保存した記録', ev.list[0] && deepEqual(ev.list[0].trade, saved)],
          ]);
        } finally {
          ev.stop();
        }
      })),

    t('SV-03', '6章にない項目は保存しない', "saveNewTrade に 'memos'（打ち間違い）／tags に文字列",
      'どちらも TypeError で止まり、何も保存されない',
      () => withTestDb('SV-03', async (db) => {
        const trades = createTradeService({ db, now: makeClock() });
        const e1 = await errorOf(() => trades.saveNewTrade(entryFields({ memos: 'x' })));
        const e2 = await errorOf(() => trades.saveNewTrade(entryFields({ tags: '指標前' })));
        const all = await db.getAllTrades();
        return verdict([
          ['項目名の誤りは TypeError', e1 instanceof TypeError, errText(e1)],
          ['配列でないのは TypeError', e2 instanceof TypeError, errText(e2)],
          ['何も保存されない', all.length === 0, all.length],
        ]);
      })),

    t('SV-04', '更新（決済・編集の保存）', 'saveTrade(メモを変更、createdAt・deletedAt・syncStatus も書き換えて渡す)／ない ID',
      'メモは変わり、updatedAt＝今・syncStatus＝pending。createdAt・deletedAt・syncedAt は保存済みの値のまま。ない ID は NOT_FOUND',
      () => withTestDb('SV-04', async (db) => {
        const trades = createTradeService({ db, now: makeClock() });
        const first = await trades.saveNewTrade(entryFields());
        // 同期済みの状態を作る（Phase 2 の sync.js の代わり）
        await db.putTrade({ ...first, syncStatus: 'synced', syncedAt: '2026-10-15T21:35:00+09:00' });
        const ev = recordTradeEvents();
        try {
          const saved = await trades.saveTrade({
            ...first, memo: '決済した', createdAt: '2000-01-01T00:00:00+09:00', deletedAt: '2026-10-15T23:00:00+09:00', syncStatus: 'synced',
          }, { draftKey: `close:${first.id}` });
          const stored = await db.getTrade(first.id);
          const err = await errorOf(() => trades.saveTrade(sampleTrade({ id: 'no-such-id' })));
          return verdict([
            ['メモが変わった', stored.memo === '決済した', stored.memo],
            ['updatedAt＝今', stored.updatedAt === '2026-10-15T21:30:01+09:00', stored.updatedAt],
            ['createdAt は元のまま', stored.createdAt === first.createdAt, stored.createdAt],
            ['deletedAt は元のまま（null）', stored.deletedAt === null, stored.deletedAt],
            ['syncedAt は元のまま', stored.syncedAt === '2026-10-15T21:35:00+09:00', stored.syncedAt],
            ['syncStatus＝pending', stored.syncStatus === 'pending', stored.syncStatus],
            ['戻り値＝DB の中身', deepEqual(saved, stored)],
            ['通知 update', ev.list.length === 1 && ev.list[0].type === 'update', JSON.stringify(ev.list.map((e) => e.type))],
            ['ない ID は NOT_FOUND', err instanceof AppError && err.code === 'NOT_FOUND', errText(err)],
            ['ない ID を作らない', (await db.getTrade('no-such-id')) === null],
          ]);
        } finally {
          ev.stop();
        }
      })),

    t('SV-05', '論理削除', '画像1枚付きの記録を deleteTrade → もう一度 deleteTrade → 削除済みを saveTrade',
      'deletedAt＝updatedAt＝今、syncStatus＝pending。記録・画像は消えない（10章）。2回目で削除日時は変わらない。削除済みの更新は NOT_FOUND',
      () => withTestDb('SV-05', async (db) => {
        const clock = makeClock();
        const trades = createTradeService({ db, now: clock });
        const images = createImageService({ db, now: clock });
        const first = await trades.saveNewTrade(entryFields({ id: 't-del' }));
        await images.saveImage({ id: 'img-del', tradeId: 't-del', kind: 'entry', blob: sampleBlob(), width: 100, height: 50 });
        await db.putTrade({ ...first, syncStatus: 'synced' });
        const ev = recordTradeEvents();
        try {
          const deleted = await trades.deleteTrade('t-del');
          const again = await trades.deleteTrade('t-del');
          const all = await trades.getAllTrades();
          const err = await errorOf(() => trades.saveTrade({ ...deleted, memo: '削除後の編集' }));
          return verdict([
            ['deletedAt＝今', deleted.deletedAt === '2026-10-15T21:30:02+09:00', deleted.deletedAt],
            ['updatedAt＝deletedAt', deleted.updatedAt === deleted.deletedAt, deleted.updatedAt],
            ['syncStatus＝pending', deleted.syncStatus === 'pending', deleted.syncStatus],
            ['記録は残る（全件取得に含まれる）', all.length === 1 && all[0].deletedAt === deleted.deletedAt],
            ['画像は消えない', (await db.getImage('img-del')) !== null],
            ['2回目で削除日時は変わらない', again.deletedAt === deleted.deletedAt, again.deletedAt],
            ['通知 delete は1回', ev.list.length === 1 && ev.list[0].type === 'delete', JSON.stringify(ev.list.map((e) => e.type))],
            ['削除済みの更新は NOT_FOUND', err instanceof AppError && err.code === 'NOT_FOUND', errText(err)],
            ['ない ID の削除は NOT_FOUND', (await errorOf(() => trades.deleteTrade('no-such-id')))?.code === 'NOT_FOUND'],
          ]);
        } finally {
          ev.stop();
        }
      })),

    t('SV-06', '削除の取り消し', '違う deletedAt で取り消し → 正しい deletedAt で取り消し → もう一度取り消し',
      '違う値では戻さない（null）。正しい値なら deletedAt＝null・updatedAt＝今・syncStatus＝pending。2回目は null（10章）',
      () => withTestDb('SV-06', async (db) => {
        const trades = createTradeService({ db, now: makeClock() });
        await trades.saveNewTrade(entryFields({ id: 't-undo' }));
        const deleted = await trades.deleteTrade('t-undo');
        await db.putTrade({ ...(await db.getTrade('t-undo')), syncStatus: 'synced' });
        const ev = recordTradeEvents();
        try {
          const wrong = await trades.undoDeleteTrade('t-undo', '2026-01-01T00:00:00+09:00');
          const stillDeleted = (await db.getTrade('t-undo')).deletedAt;
          const restored = await trades.undoDeleteTrade('t-undo', deleted.deletedAt);
          const second = await trades.undoDeleteTrade('t-undo', deleted.deletedAt);
          const stored = await db.getTrade('t-undo');
          return verdict([
            ['違う値では戻さない', wrong === null && stillDeleted === deleted.deletedAt, stillDeleted],
            ['deletedAt＝null', restored && stored.deletedAt === null, stored.deletedAt],
            // 時計：保存 :00 → 削除 :01 → 違う値の取り消し :02 → 正しい取り消し :03
            ['updatedAt＝今', stored.updatedAt === '2026-10-15T21:30:03+09:00', stored.updatedAt],
            ['syncStatus＝pending', stored.syncStatus === 'pending', stored.syncStatus],
            ['戻り値＝DB の中身', deepEqual(restored, stored)],
            ['2回目は null', second === null],
            ['通知 restore は1回', ev.list.length === 1 && ev.list[0].type === 'restore', JSON.stringify(ev.list.map((e) => e.type))],
          ]);
        } finally {
          ev.stop();
        }
      })),

    t('SV-07', '画像の保存（自動で付く値）・取得・物理削除', 'saveImage(tradeId・kind・blob・幅・高さ) を2枚 → getImagesByTrade → deleteImages／kind 誤り・Blob でない',
      'id＝UUID・createdAt＝今、6.2 の7項目。トレード単位で2枚。削除すると消える。形の誤りは TypeError',
      () => withTestDb('SV-07', async (db) => {
        const images = createImageService({ db, now: makeClock() });
        const a = await images.saveImage({ tradeId: 't-img', kind: 'entry', blob: sampleBlob('A'), width: 1280, height: 853 });
        const b = await images.saveImage({ tradeId: 't-img', kind: 'exit', blob: sampleBlob('B'), width: 853, height: 1280 });
        const got = await images.getImage(a.id);
        const list = await images.getImagesByTrade('t-img');
        await images.deleteImages([a.id]);
        const e1 = await errorOf(() => images.saveImage({ tradeId: 't-img', kind: 'close', blob: sampleBlob(), width: 1, height: 1 }));
        const e2 = await errorOf(() => images.saveImage({ tradeId: 't-img', kind: 'entry', blob: 'not-blob', width: 1, height: 1 }));
        return verdict([
          ['id は UUID', UUID_V4.test(a.id), a.id],
          ['createdAt＝今', a.createdAt === '2026-10-15T21:30:00+09:00' && b.createdAt === '2026-10-15T21:30:01+09:00', `${a.createdAt} / ${b.createdAt}`],
          ['7項目が 6.2 の順', sameList(Object.keys(a), REQ_6_2), Object.keys(a).join(',')],
          ['Blob の中身', got && (await got.blob.text()) === 'A'],
          ['トレード単位で2枚', list.length === 2, list.length],
          ['削除した画像は消えた', (await images.getImage(a.id)) === null],
          ['もう1枚は残る', (await images.getImage(b.id)) !== null],
          ['kind の誤りは TypeError', e1 instanceof TypeError, errText(e1)],
          ['Blob でないと TypeError', e2 instanceof TypeError, errText(e2)],
        ]);
      })),

    t('SV-08', '下書きの保存（自動で付く値）', "saveDraft(kind:'new') を2回／別の tradeId で保存／キーの食い違い／決済のキー",
      "key＝'new'。1回目 createdAt＝updatedAt＝今、2回目は createdAt そのまま・updatedAt＝今。別の入力なら createdAt も今。"
        + "食い違いは TypeError。決済は 'close:{tradeId}'",
      () => withTestDb('SV-08', async (db) => {
        const drafts = createDraftService({ db, now: makeClock() });
        const d1 = await drafts.saveDraft({ kind: 'new', tradeId: 'entry-1', fields: { entryPrice: '150.10' } });
        const d2 = await drafts.saveDraft({ kind: 'new', tradeId: 'entry-1', fields: { entryPrice: '150.100' }, uiState: { detailsOpen: true } });
        const d3 = await drafts.saveDraft({ kind: 'new', tradeId: 'entry-2', fields: {} });
        const bad = await errorOf(() => drafts.saveDraft({ key: 'edit:entry-1', kind: 'new', tradeId: 'entry-1', fields: {} }));
        const noId = await errorOf(() => draftKeyOf('close'));
        const stored = await drafts.getDraft('new');
        return verdict([
          ["key＝'new'", d1.key === 'new', d1.key],
          ['10項目が 6.4 の順', sameList(Object.keys(d1), REQ_6_4), Object.keys(d1).join(',')],
          ['未指定は null・[]', d1.uiState === null && d1.baseUpdatedAt === null && sameList(d1.addedImageIds, []) && sameList(d1.removedImageIds, [])],
          ['1回目 createdAt＝updatedAt＝今', d1.createdAt === '2026-10-15T21:30:00+09:00' && d1.updatedAt === d1.createdAt, d1.createdAt],
          ['2回目 createdAt はそのまま', d2.createdAt === d1.createdAt, d2.createdAt],
          ['2回目 updatedAt＝今', d2.updatedAt === '2026-10-15T21:30:01+09:00', d2.updatedAt],
          ['入力の文字のまま（末尾の0）', d2.fields.entryPrice === '150.100', d2.fields.entryPrice],
          ['別の入力なら createdAt も今', d3.createdAt === '2026-10-15T21:30:02+09:00', d3.createdAt],
          ['DB の中身＝最後の保存', deepEqual(stored, d3)],
          ['キーの食い違いは TypeError', bad instanceof TypeError, errText(bad)],
          ['決済のキー', draftKeyOf('close', 't1') === 'close:t1' && draftKeyOf('edit', 't1') === 'edit:t1'],
          ['決済で tradeId なしは TypeError', noId instanceof TypeError, errText(noId)],
        ]);
      })),

    t('SV-09', '下書きの破棄（追加した画像も消す）', '追加した画像2枚・外した画像1枚の編集の下書きを discardDraft → もう一度',
      '下書きと追加した画像2枚が消え、外した画像と他の画像は残る（9.4）。2回目は false',
      () => withTestDb('SV-09', async (db) => {
        const clock = makeClock();
        const drafts = createDraftService({ db, now: clock });
        const images = createImageService({ db, now: clock });
        for (const id of ['add-1', 'add-2', 'removed-1', 'other-1']) {
          await images.saveImage({ id, tradeId: 't-edit', kind: 'entry', blob: sampleBlob(id), width: 10, height: 10 });
        }
        const key = draftKeyOf('edit', 't-edit');
        await drafts.saveDraft({
          kind: 'edit', tradeId: 't-edit', fields: { memo: '編集中' }, addedImageIds: ['add-1', 'add-2'],
          removedImageIds: ['removed-1'], baseUpdatedAt: '2026-10-15T21:00:00+09:00',
        });
        const first = await drafts.discardDraft(key);
        const second = await drafts.discardDraft(key);
        const left = (await images.getImagesByTrade('t-edit')).map((x) => x.id).sort();
        return verdict([
          ['1回目は true', first === true],
          ['下書きが消えた', (await drafts.getDraft(key)) === null],
          ['残る画像', sameList(left, ['other-1', 'removed-1']), left.join(',')],
          ['2回目は false', second === false],
        ]);
      })),

    t('SV-10', '日時の形式（保存に使う値）', "toJstString(2026-10-15T15:30:12.789Z)・nowJst()",
      "'2026-10-16T00:30:12+09:00'（日本時間で日付が変わる・ミリ秒は切り捨て）。nowJst も25文字の固定形式（6.6）",
      async () => {
        const s = toJstString(new Date('2026-10-15T15:30:12.789Z'));
        const n = nowJst();
        return verdict([
          ['UTC→日本時間', s === '2026-10-16T00:30:12+09:00', s],
          ['nowJst の形式', JST_FORMAT.test(n) && n.length === 25, n],
        ]);
      }),

    t('SV-11', '新規保存で自動で決まる値（T-17）', "saveNewTrade(status:'closed'・lotUnitSize:1 を渡す、口座 demo・設定 50000)／決済情報ありの saveTrade",
      "status は渡した値ではなく決済情報の有無で open、lotUnitSize は設定値 50000、session は entryAt から判定（21:30 JST の木曜＝newyork）、"
        + "riskReward は SL・TP がないので null。決済価格・決済日時を足して saveTrade すると closed",
      () => withTestDb('SV-11', async (db) => {
        const trades = createTradeService({ db, now: makeClock(), getLotUnitSize: (a) => (a === 'demo' ? 50000 : 10000) });
        const saved = await trades.saveNewTrade(entryFields({ accountType: 'demo', status: 'closed', lotUnitSize: 1 }));
        const closed = await trades.saveTrade({ ...saved, exitPrice: 150.5, exitAt: '2026-10-15T23:00:00+09:00' });
        const err = await errorOf(() => trades.saveNewTrade(entryFields({ accountType: 'x' })));
        return verdict([
          ['status＝open', saved.status === 'open', saved.status],
          ['lotUnitSize＝設定値', saved.lotUnitSize === 50000, saved.lotUnitSize],
          ['session＝newyork', saved.session === 'newyork', saved.session],
          ['riskReward＝null', saved.riskReward === null, saved.riskReward],
          ['決済後は closed', closed.status === 'closed', closed.status],
          ['口座区分の誤りは TypeError', err instanceof TypeError, errText(err)],
        ]);
      })),
  ];
}

/**
 * 途中で止まるなどして残った、テスト用の DB（名前が TEST_DB_PREFIX で始まるもの）をまとめて削除する。
 * 本物の DB「fx-trade-note」は名前が違うので対象にならない。
 * indexedDB.databases() がないブラウザでは何もしない（各テストは終わるたびに自分の DB を消している）。
 * @returns {Promise<number|null>} 削除した数（調べられないときは null）
 */
export async function cleanupTestDatabases() {
  const idb = globalThis.indexedDB;
  if (!idb || typeof idb.databases !== 'function') return null;
  const list = await idb.databases();
  const targets = list.map((d) => d.name).filter((n) => typeof n === 'string' && n.startsWith(TEST_DB_PREFIX) && n !== DB_NAME);
  for (const name of targets) {
    await new Promise((resolve) => {
      const req = idb.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  }
  return targets.length;
}
