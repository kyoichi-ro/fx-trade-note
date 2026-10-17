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
import { createImageService, prepareImage, createUrlPool, inspectBlob } from '../js/images.js';
import { createDraftService, draftKeyOf } from '../js/drafts.js';
import { toJstString, nowJst } from '../js/datetime.js';
import { on } from '../js/events.js';
import { AppError } from '../js/util.js';
import { editFieldsFromTrade, buildEditedTrade } from '../js/edit-form.js';

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


/* ---------------------------------------------------------
   T-24：本物の画像（Canvas で作る JPEG）。実際の縮小・向き・壊れたファイルの確認に使う（ブラウザのみ）
   --------------------------------------------------------- */

/** チャートのスクリーンショットに似た画像（線と四角と文字のような模様。ノイズより圧縮しやすい）を Canvas で描く */
function drawChartLike(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#101820';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#3aa675';
  ctx.lineWidth = Math.max(2, w / 400);
  ctx.beginPath();
  for (let x = 0; x <= w; x += w / 60) ctx.lineTo(x, h / 2 + Math.sin(x / (w / 12)) * h / 5);
  ctx.stroke();
  ctx.fillStyle = '#d6dde5';
  for (let i = 0; i < 12; i += 1) ctx.fillRect((w / 14) * (i + 1), h * 0.8, w / 40, -((i * 37) % 100) * h / 400);
  return c;
}

const canvasToBlob = (canvas, type = 'image/jpeg', q = 0.92) => new Promise((resolve) => canvas.toBlob(resolve, type, q));

/** 本物の JPEG の Blob（幅×高さ） */
async function jpegOf(w, h) {
  return canvasToBlob(drawChartLike(w, h));
}

/** ランダムなノイズの画像（圧縮してもほとんど小さくならない。250KB を超える場合の確認用） */
async function noiseJpegOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const data = ctx.createImageData(w, h);
  const bytes = new Uint8Array(data.data.buffer);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i % 4 === 3) ? 255 : Math.floor(Math.random() * 256);
  ctx.putImageData(data, 0, 0);
  return canvasToBlob(c, 'image/jpeg', 0.95);
}

/**
 * JPEG に EXIF の「向き」（Orientation）を付ける。6＝右に90度回して表示する写真（iPhone を縦に構えて撮った写真）。
 * ファイルの先頭（SOI の直後）に APP1 を差し込むだけの小さな実装。画像のピクセルは変えない。
 */
async function withExifOrientation(blob, orientation) {
  const src = new Uint8Array(await blob.arrayBuffer());
  const exif = new Uint8Array([
    0xff, 0xe1, 0x00, 0x22,                         // APP1・長さ34
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,             // "Exif\0\0"
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // TIFF ヘッダ（リトルエンディアン・IFD0 は8バイト目）
    0x01, 0x00,                                     // 項目は1つ
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, // Orientation（0x0112）・SHORT・1個・値
    0x00, 0x00, 0x00, 0x00,                         // 次の IFD なし
  ]);
  const out = new Uint8Array(src.length + exif.length);
  out.set(src.subarray(0, 2), 0);
  out.set(exif, 2);
  out.set(src.subarray(2), 2 + exif.length);
  return new Blob([out], { type: 'image/jpeg' });
}

/** 画像の大きさを <img> で読んで返す（保存した JPEG の幅・高さの確認用） */
async function sizeOfBlob(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 実際の JPEG を images に保存して ID を返す */
async function saveRealImage(images, tradeId, id, over = {}) {
  const blob = over.blob || (await jpegOf(160, 90));
  await images.saveImage({ id, tradeId, kind: over.kind || 'entry', blob, width: 160, height: 90 });
  return id;
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

    t('SV-12', '決済（T-21）：closeTrade で保存されている記録に決済を重ねる', '保有中の記録＋決済の下書きを用意して closeTrade（JPY 150.000→150.250）／もう一度／ない ID／削除済み',
      'status＝closed・pips＝25・profitJpy＝2500（auto）・lotUnitSize は記録時の値・updatedAt＝今・createdAt 不変・下書きも同時に消える・通知 update。決済済みは ALREADY_CLOSED、ない ID・削除済みは NOT_FOUND',
      () => withTestDb('SV-12', async (db) => {
        const clock = makeClock();
        let unit = 10000; // あとで設定画面の値を変えても、記録時の値で計算されることを確かめる
        const trades = createTradeService({ db, now: clock, getLotUnitSize: () => unit });
        const drafts = createDraftService({ db, now: clock });
        const first = await trades.saveNewTrade(entryFields({ id: 't-close', entryPrice: 150, lots: 1 }));
        unit = 99999;
        await drafts.saveDraft({ kind: 'close', tradeId: 't-close', fields: { exitPrice: '150.250' } });
        const ev = recordTradeEvents();
        try {
          const saved = await trades.closeTrade('t-close', {
            exitPrice: 150.25, exitAt: '2026-10-15T23:05:00+09:00', exitReason: 'tp', exitEmotion: '冷静', tags: ['指標前'], memo: '決済メモ',
          }, { draftKey: 'close:t-close' });
          const stored = await db.getTrade('t-close');
          const again = await errorOf(() => trades.closeTrade('t-close', { exitPrice: 150.3, exitAt: '2026-10-15T23:10:00+09:00' }));
          const missing = await errorOf(() => trades.closeTrade('no-such-id', { exitPrice: 150.3, exitAt: '2026-10-15T23:10:00+09:00' }));
          await trades.saveNewTrade(entryFields({ id: 't-deleted' }));
          await trades.deleteTrade('t-deleted');
          const deleted = await errorOf(() => trades.closeTrade('t-deleted', { exitPrice: 150.3, exitAt: '2026-10-15T23:10:00+09:00' }));
          return verdict([
            ['closed', stored.status === 'closed', stored.status],
            ['pips', stored.pips === 25, stored.pips],
            ['損益は自動計算（記録時の1lot＝10,000）', stored.profitJpy === 2500 && stored.profitSource === 'auto', `${stored.profitJpy}/${stored.profitSource}`],
            ['lotUnitSize は記録時の値', stored.lotUnitSize === 10000, stored.lotUnitSize],
            ['決済理由・感情・タグ・メモ', stored.exitReason === 'tp' && stored.exitEmotion === '冷静' && sameList(stored.tags, ['指標前']) && stored.memo === '決済メモ'],
            ['updatedAt が進み createdAt は不変', stored.updatedAt > first.updatedAt && stored.createdAt === first.createdAt, stored.updatedAt],
            ['syncStatus＝pending', stored.syncStatus === 'pending', stored.syncStatus],
            ['戻り値＝DB の中身', deepEqual(saved, stored)],
            ['下書きも同時に消える', (await db.getDraft('close:t-close')) === null],
            ['通知 update は1回', ev.list.length >= 1 && ev.list[0].type === 'update' && ev.list[0].id === 't-close', JSON.stringify(ev.list.map((e) => e.type))],
            ['決済済みの再決済は ALREADY_CLOSED（上書きしない）', again instanceof AppError && again.code === 'ALREADY_CLOSED' && (await db.getTrade('t-close')).exitPrice === 150.25, errText(again)],
            ['ない ID は NOT_FOUND', missing instanceof AppError && missing.code === 'NOT_FOUND', errText(missing)],
            ['削除済みは NOT_FOUND', deleted instanceof AppError && deleted.code === 'NOT_FOUND', errText(deleted)],
          ]);
        } finally {
          ev.stop();
        }
      })),

    t('SV-13', '決済（手入力・非JPY）：確定損益を手入力すると manual。円換算レートは記録として残る', 'EUR/USD 買い 1.08500→1.08750・レート 149.850・手入力 −500／手入力なし',
      'profitJpy＝-500・manual・quoteToJpyRate＝149.85・pips＝25（手入力でも自動）／手入力なしは 3746・auto',
      () => withTestDb('SV-13', async (db) => {
        const trades = createTradeService({ db, now: makeClock() });
        await trades.saveNewTrade(entryFields({ id: 'e1', pair: 'EUR/USD', entryPrice: 1.085, lots: 1 }));
        await trades.saveNewTrade(entryFields({ id: 'e2', pair: 'EUR/USD', entryPrice: 1.085, lots: 1 }));
        const exit = { exitPrice: 1.0875, exitAt: '2026-10-15T23:05:00+09:00', quoteToJpyRate: 149.85 };
        const manual = await trades.closeTrade('e1', { ...exit, manualProfitJpy: -500 });
        const auto = await trades.closeTrade('e2', exit);
        return verdict([
          ['手入力の円', manual.profitJpy === -500 && manual.profitSource === 'manual', `${manual.profitJpy}/${manual.profitSource}`],
          ['レートは記録として残る', manual.quoteToJpyRate === 149.85, manual.quoteToJpyRate],
          ['pips は自動計算', manual.pips === 25, manual.pips],
          ['手入力なしは自動（3,746円）', auto.profitJpy === 3746 && auto.profitSource === 'auto', `${auto.profitJpy}/${auto.profitSource}`],
        ]);
      })),

    t('SV-14', '決済の取り消し（T-21）：reopenTrade で保有中に戻す。理由・感情・メモ・タグ・画像は残る', '決済済み（手入力）の記録＋画像 → reopenTrade → もう一度 → ない ID・削除済み',
      '6項目（exitPrice・exitAt・pips・profitJpy・profitSource・quoteToJpyRate）が null・status＝open・残す項目はそのまま・updatedAt＝今・syncStatus＝pending・通知 update。すでに保有中なら何も変えず通知なし。ない ID・削除済みは NOT_FOUND',
      () => withTestDb('SV-14', async (db) => {
        const clock = makeClock();
        const trades = createTradeService({ db, now: clock });
        const images = createImageService({ db, now: clock });
        // T-24：記録が指す画像は保存時に存在していなければならない（IMAGE_MISSING）ので、画像を先に保存する
        await images.saveImage({ id: 'img-r1', tradeId: 'r1', kind: 'entry', blob: sampleBlob(), width: 100, height: 50 });
        await trades.saveNewTrade(entryFields({ id: 'r1', pair: 'EUR/USD', entryPrice: 1.085, imageIds: ['img-r1'], tags: ['ルール違反'], memo: 'メモ' }));
        const closed = await trades.closeTrade('r1', {
          exitPrice: 1.0875, exitAt: '2026-10-15T23:05:00+09:00', quoteToJpyRate: 149.85, manualProfitJpy: -500, exitReason: 'sl', exitEmotion: '焦り',
        });
        const ev = recordTradeEvents();
        try {
          const r = await trades.reopenTrade('r1');
          const stored = await db.getTrade('r1');
          const eventsAfterFirst = ev.list.length;
          const again = await trades.reopenTrade('r1');
          const eventsAfterSecond = ev.list.length;
          const missing = await errorOf(() => trades.reopenTrade('no-such-id'));
          await trades.saveNewTrade(entryFields({ id: 'r2' }));
          await trades.deleteTrade('r2');
          const deleted = await errorOf(() => trades.reopenTrade('r2'));
          return verdict([
            ['決済済みだった', closed.status === 'closed', closed.status],
            ['消える6項目', [stored.exitPrice, stored.exitAt, stored.pips, stored.profitJpy, stored.profitSource, stored.quoteToJpyRate].every((v) => v === null)],
            ['status＝open', stored.status === 'open', stored.status],
            ['理由・感情・メモ・タグ・画像は残る', stored.exitReason === 'sl' && stored.exitEmotion === '焦り' && stored.memo === 'メモ' && sameList(stored.tags, ['ルール違反']) && sameList(stored.imageIds, ['img-r1']), `${stored.exitReason}/${stored.exitEmotion}`],
            ['画像は消えない', (await db.getImage('img-r1')) !== null],
            ['updatedAt が進み syncStatus＝pending', stored.updatedAt > closed.updatedAt && stored.syncStatus === 'pending', stored.updatedAt],
            ['戻り値＝DB の中身', deepEqual(r, stored)],
            ['通知 update は1回', eventsAfterFirst === 1 && ev.list[0].type === 'update', JSON.stringify(ev.list.map((e) => e.type))],
            ['すでに保有中なら何も変えない・通知なし', deepEqual(again, stored) && eventsAfterSecond === 1, `${eventsAfterSecond}`],
            ['ない ID は NOT_FOUND', missing instanceof AppError && missing.code === 'NOT_FOUND', errText(missing)],
            ['削除済みは NOT_FOUND', deleted instanceof AppError && deleted.code === 'NOT_FOUND', errText(deleted)],
          ]);
        } finally {
          ev.stop();
        }
      })),

    t('SV-15', '編集の保存（T-22）：saveTrade の expectedUpdatedAt で、別の画面が先に変更していたら CONFLICT', '保存 → 正しい expectedUpdatedAt で保存 → 古い値で保存 → 渡さずに保存／下書きつき',
      '一致すれば保存（updatedAt が進む）。違えば CONFLICT で何も保存せず、下書きも残る。渡さなければ従来どおり保存。成功すると下書きも同時に消える',
      () => withTestDb('SV-15', async (db) => {
        const clock = makeClock();
        const trades = createTradeService({ db, now: clock });
        const drafts = createDraftService({ db, now: clock });
        const first = await trades.saveNewTrade(entryFields({ id: 'e-conf' }));
        const second = await trades.saveTrade({ ...first, memo: '別の画面の変更' });
        await drafts.saveDraft({ kind: 'edit', tradeId: 'e-conf', fields: { memo: '編集中' }, baseUpdatedAt: first.updatedAt });
        const conflict = await errorOf(() => trades.saveTrade({ ...first, memo: '編集中' }, { draftKey: 'edit:e-conf', expectedUpdatedAt: first.updatedAt }));
        const afterConflict = await db.getTrade('e-conf');
        const draftAfterConflict = await db.getDraft('edit:e-conf');
        const ok = await trades.saveTrade({ ...second, memo: '最新を土台に編集' }, { draftKey: 'edit:e-conf', expectedUpdatedAt: second.updatedAt });
        const noExpect = await trades.saveTrade({ ...ok, memo: '渡さない' });
        return verdict([
          ['古い値は CONFLICT', conflict instanceof AppError && conflict.code === 'CONFLICT', errText(conflict)],
          ['CONFLICT のとき何も保存しない（別の画面の変更が残る）', afterConflict.memo === '別の画面の変更' && afterConflict.updatedAt === second.updatedAt, afterConflict.memo],
          ['CONFLICT のとき下書きは残る', draftAfterConflict !== null, draftAfterConflict],
          ['一致すれば保存', ok.memo === '最新を土台に編集' && ok.updatedAt > second.updatedAt, ok.memo],
          ['成功すると下書きも消える', (await db.getDraft('edit:e-conf')) === null],
          ['渡さなければ従来どおり', noExpect.memo === '渡さない'],
        ]);
      })),

    t('SV-16', '編集の保存（T-22）：口座区分の変更・手入力損益・画像などの項目が落ちない', '決済済み（手入力・画像つき）の記録を、口座 real→demo で組み立てて saveTrade／元に戻して saveTrade',
      'lotUnitSize は変更先の今の設定値（demo 100000）・profitJpy −500（manual のまま）・imageIds・createdAt 不変・syncStatus＝pending・updatedAt が進む。戻したら lotUnitSize 10000',
      () => withTestDb('SV-16', async (db) => {
        const clock = makeClock();
        const trades = createTradeService({ db, now: clock, getLotUnitSize: (a) => (a === 'demo' ? 100000 : 10000) });
        const images = createImageService({ db, now: clock });
        await images.saveImage({ id: 'img-acc', tradeId: 'e-acc', kind: 'entry', blob: sampleBlob(), width: 10, height: 10 });
        await trades.saveNewTrade(entryFields({ id: 'e-acc', entryPrice: 150, lots: 1, imageIds: ['img-acc'], tags: ['タグ'], memo: 'メモ' }));
        const closed = await trades.closeTrade('e-acc', { exitPrice: 150.25, exitAt: '2026-10-15T23:05:00+09:00', manualProfitJpy: -500 });
        const ctx = { getLotUnitSize: (a) => (a === 'demo' ? 100000 : 10000) };
        const toDemo = await trades.saveTrade(buildEditedTrade(closed, { ...editFieldsFromTrade(closed), accountType: 'demo' }, ctx), { expectedUpdatedAt: closed.updatedAt });
        const stored = await db.getTrade('e-acc');
        const back = await trades.saveTrade(buildEditedTrade(stored, { ...editFieldsFromTrade(stored), accountType: 'real' }, ctx), { expectedUpdatedAt: stored.updatedAt });
        return verdict([
          ['口座・lotUnitSize', stored.accountType === 'demo' && stored.lotUnitSize === 100000, `${stored.accountType}/${stored.lotUnitSize}`],
          ['手入力損益は変わらない', stored.profitJpy === -500 && stored.profitSource === 'manual', `${stored.profitJpy}/${stored.profitSource}`],
          ['pips は変わらない（価格が同じ）', stored.pips === 25, stored.pips],
          ['画像・タグ・メモが落ちない', sameList(stored.imageIds, ['img-acc']) && sameList(stored.tags, ['タグ']) && stored.memo === 'メモ'],
          ['画像本体も消えない', (await db.getImage('img-acc')) !== null],
          ['createdAt 不変・updatedAt が進む・pending', stored.createdAt === closed.createdAt && stored.updatedAt > closed.updatedAt && stored.syncStatus === 'pending', stored.updatedAt],
          ['status は closed のまま', stored.status === 'closed', stored.status],
          ['戻り値＝DB の中身', deepEqual(toDemo, stored)],
          ['元の口座に戻したら lotUnitSize も記録時の値（10000）', back.accountType === 'real' && back.lotUnitSize === 10000, `${back.accountType}/${back.lotUnitSize}`],
        ]);
      })),

    t('SV-17', '編集・削除（T-22）：削除された記録の編集は NOT_FOUND。削除の取り消しは削除日時が変わっていたら何もしない', '削除済みを saveTrade／削除→取り消し→もう一度削除→最初の deletedAt で取り消し',
      '削除済みの保存は NOT_FOUND（作り直さない）。古い deletedAt での取り消しは null で何も変えない。削除して取り消すと deletedAt＝null・updatedAt が進む',
      () => withTestDb('SV-17', async (db) => {
        const clock = makeClock();
        const trades = createTradeService({ db, now: clock });
        const saved = await trades.saveNewTrade(entryFields({ id: 'e-del' }));
        const deleted1 = await trades.deleteTrade('e-del');
        const editDeleted = await errorOf(() => trades.saveTrade({ ...saved, memo: '削除済みを編集' }, { expectedUpdatedAt: saved.updatedAt }));
        const restored = await trades.undoDeleteTrade('e-del', deleted1.deletedAt);
        const deleted2 = await trades.deleteTrade('e-del');
        const stale = await trades.undoDeleteTrade('e-del', deleted1.deletedAt);
        const stillDeleted = await db.getTrade('e-del');
        return verdict([
          ['削除済みの編集の保存は NOT_FOUND', editDeleted instanceof AppError && editDeleted.code === 'NOT_FOUND', errText(editDeleted)],
          ['削除済みの記録を作り直していない', (await db.getTrade('e-del')).memo !== '削除済みを編集', stillDeleted.memo],
          ['取り消すと deletedAt＝null', restored !== null && restored.deletedAt === null && restored.updatedAt > deleted1.updatedAt, restored && restored.deletedAt],
          ['2回目の削除は別の削除日時', deleted2.deletedAt !== deleted1.deletedAt, deleted2.deletedAt],
          ['古い deletedAt での取り消しは null', stale === null, stale],
          ['古い取り消しで記録は戻らない', stillDeleted.deletedAt === deleted2.deletedAt, stillDeleted.deletedAt],
        ]);
      })),

    /* ===== T-24：チャート画像 ===== */

    t('SV-18', '画像の整合（新規）：記録が指す画像が無ければ保存しない（IMAGE_MISSING）。あれば保存し、下書きも同じトランザクションで消える', 'saveNewTrade(imageIds に存在しない ID)／画像を先に保存して saveNewTrade(draftKey)',
      '存在しない画像を指す記録は保存されず、下書きも残る。画像がそろっていれば保存でき、下書きは消え、画像はそのまま',
      () => withTestDb('SV-18', async (db) => {
        const clock = makeClock();
        const trades = createTradeService({ db, now: clock });
        const images = createImageService({ db, now: clock });
        const drafts = createDraftService({ db, now: clock });
        await drafts.saveDraft({ kind: 'new', tradeId: 'n-img', fields: {}, addedImageIds: ['n-img-1'] });
        const e = await errorOf(() => trades.saveNewTrade(entryFields({ id: 'n-img', imageIds: ['n-img-1'] }), { draftKey: 'new' }));
        const afterFail = await db.getTrade('n-img');
        const draftAfterFail = await db.getDraft('new');
        await saveRealImage(images, 'n-img', 'n-img-1');
        const saved = await trades.saveNewTrade(entryFields({ id: 'n-img', imageIds: ['n-img-1'] }), { draftKey: 'new' });
        return verdict([
          ['画像が無いと IMAGE_MISSING', e instanceof AppError && e.code === 'IMAGE_MISSING', errText(e)],
          ['記録は保存されていない', afterFail === null],
          ['下書きは残っている（もう一度保存できる）', draftAfterFail !== null],
          ['画像がそろえば保存できる', saved.imageIds.length === 1 && saved.imageIds[0] === 'n-img-1', saved.imageIds.join()],
          ['下書きは同じトランザクションで消えた', (await db.getDraft('new')) === null],
          ['画像は消えていない', (await db.getImage('n-img-1')) !== null],
        ]);
      })),

    t('SV-19', '画像の整合（編集）：新しく指した画像が無ければ保存しない。外した画像は記録の保存と同じトランザクションで物理削除', 'saveTrade(imageIds に存在しない ID)／saveTrade(imageIds から b を外し deleteImageIds: [b, a])',
      '存在しない画像を足す保存は IMAGE_MISSING で何も変えない。外した b は消え、まだ指している a は deleteImageIds にあっても消えない。下書きも消える。すでに指している画像が壊れていても他の項目は保存できる',
      () => withTestDb('SV-19', async (db) => {
        const clock = makeClock();
        const trades = createTradeService({ db, now: clock });
        const images = createImageService({ db, now: clock });
        await saveRealImage(images, 'e-img', 'a');
        await saveRealImage(images, 'e-img', 'b');
        await saveRealImage(images, 'e-img', 'c');
        const first = await trades.saveNewTrade(entryFields({ id: 'e-img', imageIds: ['a', 'b'] }));
        const missing = await errorOf(() => trades.saveTrade({ ...first, imageIds: ['a', 'b', 'ghost'] }, { deleteImageIds: ['b'] }));
        const afterMissing = await db.getTrade('e-img');
        const bStillThere = (await db.getImage('b')) !== null; // 外す予定だった b は、IMAGE_MISSING のときは消えていない（保存と同じトランザクション）
        await db.putDraft(sampleDraft({ key: 'edit:e-img', kind: 'edit', tradeId: 'e-img', removedImageIds: ['b'], addedImageIds: ['c'] }));
        const ok = await trades.saveTrade({ ...first, imageIds: ['a', 'c'] }, { draftKey: 'edit:e-img', expectedUpdatedAt: first.updatedAt, deleteImageIds: ['b', 'a'] });
        // すでに指している画像が見つからない記録（壊れた状態）でも、他の項目の編集は保存できる（新しく足していないので確認しない）
        await db.deleteImages(['c']);
        const withGhost = await trades.saveTrade({ ...ok, memo: '画像が壊れていてもメモは保存できる' });
        return verdict([
          ['存在しない画像を足すと IMAGE_MISSING', missing instanceof AppError && missing.code === 'IMAGE_MISSING', errText(missing)],
          ['IMAGE_MISSING のとき何も変えない（imageIds・外す予定だった b の画像）', sameList(afterMissing.imageIds, ['a', 'b']) && bStillThere, afterMissing.imageIds.join()],
          ['外した b は物理削除', ok.imageIds.join() === 'a,c' && (await db.getImage('b')) === null],
          ['まだ指している a は deleteImageIds にあっても消えない', (await db.getImage('a')) !== null],
          ['追加した c は残る（この時点）', ok.imageIds.includes('c')],
          ['下書きも消えた', (await db.getDraft('edit:e-img')) === null],
          ['壊れた参照があっても他の項目は保存できる', withGhost.memo === '画像が壊れていてもメモは保存できる' && withGhost.imageIds.join() === 'a,c', withGhost.imageIds.join()],
        ]);
      })),

    t('SV-20', '決済で追加した画像は、保存されている最新の imageIds の後ろに足す。画像が無ければ保存しない', 'closeTrade(addImageIds: [x])（別の画面で imageIds が変わったあと）／存在しない ID',
      '最新の imageIds（a,b）の後ろに x を足して a,b,x。存在しない ID は IMAGE_MISSING で決済も保存されない。追加しない決済は imageIds を変えない',
      () => withTestDb('SV-20', async (db) => {
        const clock = makeClock();
        const trades = createTradeService({ db, now: clock });
        const images = createImageService({ db, now: clock });
        await saveRealImage(images, 'c-img', 'a');
        await saveRealImage(images, 'c-img', 'b');
        await saveRealImage(images, 'c-img', 'x', { kind: 'exit' });
        const first = await trades.saveNewTrade(entryFields({ id: 'c-img', imageIds: ['a'] }));
        await trades.saveTrade({ ...first, imageIds: ['a', 'b'] }); // 決済画面を開いたあとに、別の画面で画像が増えた
        const ghost = await errorOf(() => trades.closeTrade('c-img', { exitPrice: 150.2, exitAt: '2026-10-15T23:05:00+09:00', addImageIds: ['ghost'] }));
        const stillOpen = await db.getTrade('c-img');
        const closed = await trades.closeTrade('c-img', { exitPrice: 150.2, exitAt: '2026-10-15T23:05:00+09:00', addImageIds: ['x'] });
        await saveRealImage(images, 'c-img2', 'p');
        await trades.saveNewTrade(entryFields({ id: 'c-img2', imageIds: ['p'] }));
        const noAdd = await trades.closeTrade('c-img2', { exitPrice: 150.2, exitAt: '2026-10-15T23:05:00+09:00' });
        return verdict([
          ['存在しない ID は IMAGE_MISSING', ghost instanceof AppError && ghost.code === 'IMAGE_MISSING', errText(ghost)],
          ['決済も保存されていない', stillOpen.status === 'open' && stillOpen.exitPrice === null, stillOpen.status],
          ['最新の imageIds の後ろに足す', closed.imageIds.join() === 'a,b,x', closed.imageIds.join()],
          ['決済は済んでいる', closed.status === 'closed'],
          ['追加しない決済は imageIds を変えない', noAdd.imageIds.join() === 'p', noAdd.imageIds.join()],
        ]);
      })),

    t('SV-21', '詳細からの画像の個別削除（removeTradeImage）：画像の物理削除と imageIds の更新が1つのトランザクション', '2枚付きの記録から1枚削除／もう一度／取り残された画像／他の記録の画像／削除済みの記録',
      'imageIds から外れ画像も消える・updatedAt が進み syncStatus＝pending・通知 update。同じ記録の取り残された画像は消せるが、他の記録の画像は消えない。削除済み・ない記録は NOT_FOUND',
      () => withTestDb('SV-21', async (db) => {
        const clock = makeClock();
        const trades = createTradeService({ db, now: clock });
        const images = createImageService({ db, now: clock });
        await saveRealImage(images, 'r-img', 'i1');
        await saveRealImage(images, 'r-img', 'i2');
        await saveRealImage(images, 'r-img', 'stray');
        await saveRealImage(images, 'other', 'o1');
        const first = await trades.saveNewTrade(entryFields({ id: 'r-img', imageIds: ['i1', 'i2'] }));
        await db.putTrade({ ...first, syncStatus: 'synced' });
        const ev = recordTradeEvents();
        try {
          const after = await trades.removeTradeImage('r-img', 'i1');
          const stored = await db.getTrade('r-img');
          const again = await trades.removeTradeImage('r-img', 'i1');
          const strayRes = await trades.removeTradeImage('r-img', 'stray');
          const foreign = await trades.removeTradeImage('r-img', 'o1');
          await trades.deleteTrade('r-img');
          const deletedErr = await errorOf(() => trades.removeTradeImage('r-img', 'i2'));
          const missingErr = await errorOf(() => trades.removeTradeImage('no-such', 'i2'));
          return verdict([
            ['imageIds から外れる', sameList(after.imageIds, ['i2']) && deepEqual(after, stored), after.imageIds.join()],
            ['画像も物理削除', (await db.getImage('i1')) === null],
            ['updatedAt が進み pending', stored.updatedAt > first.updatedAt && stored.syncStatus === 'pending', `${stored.updatedAt}/${stored.syncStatus}`],
            ['もう1枚は残る', (await db.getImage('i2')) !== null],
            ['通知 update', ev.list.some((x) => x.type === 'update' && x.id === 'r-img'), JSON.stringify(ev.list.map((x) => x.type))],
            ['同じ ID をもう一度削除しても記録は変わらない', again.imageIds.join() === 'i2' && again.updatedAt === stored.updatedAt],
            ['取り残された画像（同じ記録）は消せる', strayRes.imageIds.join() === 'i2' && (await db.getImage('stray')) === null],
            ['他の記録の画像は消えない', foreign.imageIds.join() === 'i2' && (await db.getImage('o1')) !== null],
            ['削除済みの記録は NOT_FOUND（画像も消えない）', deletedErr instanceof AppError && deletedErr.code === 'NOT_FOUND' && (await db.getImage('i2')) !== null, errText(deletedErr)],
            ['ない記録は NOT_FOUND', missingErr instanceof AppError && missingErr.code === 'NOT_FOUND', errText(missingErr)],
          ]);
        } finally {
          ev.stop();
        }
      })),

    t('SV-22', '下書きの破棄：記録が使っている画像は、下書きの addedImageIds にあっても消さない。alsoImageIds は下書きが無くても消す', 'discardDraft（addedImageIds に保存済みの記録の画像が混ざる）／discardDraft(key, { alsoImageIds })',
      '保存済みの記録の画像は残り、使われていない追加画像だけ消える。下書きが無くても alsoImageIds の画像は消え、戻り値は false',
      () => withTestDb('SV-22', async (db) => {
        const clock = makeClock();
        const trades = createTradeService({ db, now: clock });
        const images = createImageService({ db, now: clock });
        const drafts = createDraftService({ db, now: clock });
        await saveRealImage(images, 'd-img', 'used');
        await saveRealImage(images, 'd-img', 'unused');
        await saveRealImage(images, 'd-img', 'late');
        await trades.saveNewTrade(entryFields({ id: 'd-img', imageIds: ['used'] }));
        // 二重保存のあとなど、記録は保存済みなのに下書きだけが残った状態（下書きは used も unused も覚えている）
        await drafts.saveDraft({ kind: 'new', tradeId: 'd-img', fields: {}, addedImageIds: ['used', 'unused'] });
        const first = await drafts.discardDraft('new');
        const second = await drafts.discardDraft('new', { alsoImageIds: ['late'] });
        return verdict([
          ['下書きは消えた', first === true && (await drafts.getDraft('new')) === null],
          ['記録が使う画像は残る', (await db.getImage('used')) !== null],
          ['使われていない追加画像は消える', (await db.getImage('unused')) === null],
          ['下書きが無くても alsoImageIds の画像は消える', second === false && (await db.getImage('late')) === null],
        ]);
      })),

    t('SV-23', '論理削除→取り消しで画像も戻る（画像は消えず、imageIds も変わらない）。読み出せない画像はその1枚だけ「読み込めません」', 'deleteTrade → loadImage → undoDeleteTrade／loadImage（正常・ない・空の Blob・文字の Blob）',
      '削除中も画像は残り、取り消すと imageIds が元のまま。loadImage は ok／missing／broken／broken を返し、例外にしない（記録全体は壊さない）',
      () => withTestDb('SV-23', async (db) => {
        const clock = makeClock();
        const trades = createTradeService({ db, now: clock });
        const images = createImageService({ db, now: clock });
        await saveRealImage(images, 'u-img', 'g1');
        await saveRealImage(images, 'u-img', 'g2');
        await db.addImage(sampleImage({ id: 'bad-empty', tradeId: 'u-img', blob: new Blob([], { type: 'image/jpeg' }) }));
        await db.addImage(sampleImage({ id: 'bad-text', tradeId: 'u-img', blob: new Blob(['これは画像ではありません'], { type: 'image/jpeg' }) }));
        const first = await trades.saveNewTrade(entryFields({ id: 'u-img', imageIds: ['g1', 'g2', 'bad-empty'] }));
        const deleted = await trades.deleteTrade('u-img');
        const whileDeleted = await images.loadImage('g1');
        const restored = await trades.undoDeleteTrade('u-img', deleted.deletedAt);
        const results = await Promise.all(['g1', 'g2', 'ghost', 'bad-empty', 'bad-text'].map((id) => images.loadImage(id)));
        return verdict([
          ['削除中も画像は読める', whileDeleted.status === 'ok', whileDeleted.status],
          ['取り消すと imageIds が元のまま', restored !== null && sameList(restored.imageIds, first.imageIds), restored && restored.imageIds.join()],
          ['取り消したあとも画像は読める', results[0].status === 'ok' && results[1].status === 'ok'],
          ['ない画像は missing', results[2].status === 'missing' && results[2].image === null, results[2].status],
          ['空の Blob は broken', results[3].status === 'broken', results[3].status],
          ['画像でない Blob は broken', results[4].status === 'broken', results[4].status],
          ['ok のときは画像（Blob つき）を返す', results[0].image && results[0].image.blob instanceof Blob && results[0].id === 'g1'],
        ]);
      })),

    t('SV-24', '孤立画像の掃除：記録にも下書きにも使われず、作成から1日以上たった画像だけ消える', 'sweepOrphans（現在 2026-10-16 12:00）。使用中・削除済みの記録・下書き・新しい画像・古い孤立画像',
      '古い孤立画像だけ消える。記録（削除済みを含む）が使う画像・下書きが覚えている画像・1日未満の画像は残る。戻り値は消した ID',
      () => withTestDb('SV-24', async (db) => {
        const clock = makeClock();
        const trades = createTradeService({ db, now: clock });
        const images = createImageService({ db, now: clock });
        const OLD = '2026-10-14T10:00:00+09:00';
        const FRESH = '2026-10-16T11:30:00+09:00';
        for (const [id, createdAt] of [['s-used', OLD], ['s-del', OLD], ['s-draft', OLD], ['s-old', OLD], ['s-fresh', FRESH]]) {
          await db.addImage(sampleImage({ id, tradeId: 's-trade', createdAt }));
        }
        const keep = await trades.saveNewTrade(entryFields({ id: 's-keep', imageIds: ['s-used'] }));
        await trades.saveNewTrade(entryFields({ id: 's-gone', imageIds: ['s-del'] }));
        await trades.deleteTrade('s-gone');
        await db.putDraft(sampleDraft({ key: 'new', tradeId: 's-new', addedImageIds: ['s-draft'] }));
        const removed = await images.sweepOrphans({ now: new Date('2026-10-16T12:00:00+09:00') });
        const left = (await images.getImagesByTrade('s-trade')).map((x) => x.id).sort();
        const again = await images.sweepOrphans({ now: new Date('2026-10-16T12:00:00+09:00') });
        return verdict([
          ['消えたのは古い孤立画像だけ', sameList(removed, ['s-old']), removed.join()],
          ['残る画像', sameList(left, ['s-del', 's-draft', 's-fresh', 's-used']), left.join()],
          ['記録は変わらない', deepEqual(await db.getTrade('s-keep'), keep)],
          ['2回目は何も消さない', again.length === 0],
          ['2日後なら新しい画像も孤立として消える', sameList(await images.sweepOrphans({ now: new Date('2026-10-18T12:00:00+09:00') }), ['s-fresh'])],
        ]);
      })),

    t('SV-25', '画像の縮小・JPEG 圧縮（実際の Canvas）：長辺 1280px・縦横比を保つ・拡大しない・250KB 以内', 'prepareImage（横3200x2000・縦2000x3200・小さい800x600）',
      '横長は 1280x800、縦長は 800x1280、小さい画像は 800x600 のまま。JPEG（image/jpeg）で 250KB 以内。保存した Blob の実際の大きさも一致',
      async () => {
        const wide = await prepareImage(await jpegOf(3200, 2000));
        const tall = await prepareImage(await jpegOf(2000, 3200));
        const small = await prepareImage(await jpegOf(800, 600));
        const sized = await sizeOfBlob(wide.blob);
        const png = await prepareImage(await canvasToBlob(drawChartLike(1600, 900), 'image/png'));
        return verdict([
          ['横長 3200x2000 → 1280x800', wide.width === 1280 && wide.height === 800, `${wide.width}x${wide.height}`],
          ['縦長 2000x3200 → 800x1280', tall.width === 800 && tall.height === 1280, `${tall.width}x${tall.height}`],
          ['小さい画像は拡大しない', small.width === 800 && small.height === 600, `${small.width}x${small.height}`],
          ['JPEG になる', wide.blob.type === 'image/jpeg' && (await inspectBlob(wide.blob)) === true, wide.blob.type],
          ['250KB 以内', wide.blob.size <= 250 * 1024 && tall.blob.size <= 250 * 1024 && small.blob.size <= 250 * 1024, `${wide.blob.size}/${tall.blob.size}/${small.blob.size}`],
          ['保存した Blob の実際の大きさ＝記録する大きさ', sized.width === wide.width && sized.height === wide.height, `${sized.width}x${sized.height}`],
          ['PNG も JPEG にして縮小する', png.blob.type === 'image/jpeg' && png.width === 1280 && png.height === 720, `${png.blob.type} ${png.width}x${png.height}`],
        ]);
      }),

    t('SV-26', '画像の縮小：ノイズのような大きな画像でもサイズだけを理由に失敗させない（1024px でやり直す）。向き（EXIF）を正しく扱う', 'prepareImage（ランダムノイズ 2400x1600）／向き6の JPEG 300x200',
      'ノイズは 250KB を超えても例外にならず、長辺 1024px で返る。向き6の 300x200 は縦長の 200x300 になる（横向きにならない）',
      async () => {
        const noise = await prepareImage(await noiseJpegOf(2400, 1600));
        const upright = await jpegOf(300, 200);
        const rotated = await prepareImage(await withExifOrientation(upright, 6));
        const plain = await prepareImage(upright);
        return verdict([
          ['ノイズでも失敗しない', noise.blob.size > 0 && noise.blob.type === 'image/jpeg'],
          ['ノイズは 1024px のやり直しまで進む', noise.width === 1024 && noise.height === 683, `${noise.width}x${noise.height}`],
          ['向きなしの 300x200 はそのまま', plain.width === 300 && plain.height === 200, `${plain.width}x${plain.height}`],
          ['向き6の 300x200 は縦長 200x300', rotated.width === 200 && rotated.height === 300, `${rotated.width}x${rotated.height}`],
          ['保存した Blob の実際の向きも縦長', (await sizeOfBlob(rotated.blob)).height === 300, JSON.stringify(await sizeOfBlob(rotated.blob))],
        ]);
      }),

    t('SV-27', '読み込めない画像は IMAGE_DECODE（アプリは止まらない）', 'prepareImage（文字のファイル・壊れた JPEG・空のファイル・Blob でない値）',
      'どれも AppError IMAGE_DECODE（文言は design 14.1.9）',
      async () => {
        const text = new File(['hello'], 'a.txt', { type: 'text/plain' });
        const garbage = new File([new Uint8Array([0xff, 0xd8, 0xff, 0x00, 1, 2, 3, 4, 5, 6])], 'broken.jpg', { type: 'image/jpeg' });
        const empty = new File([], 'empty.jpg', { type: 'image/jpeg' });
        const errs = await Promise.all([text, garbage, empty, 'not-a-file'].map((f) => errorOf(() => prepareImage(f))));
        return verdict([
          ['文字のファイル', errs[0] instanceof AppError && errs[0].code === 'IMAGE_DECODE', errText(errs[0])],
          ['壊れた JPEG', errs[1] instanceof AppError && errs[1].code === 'IMAGE_DECODE', errText(errs[1])],
          ['空のファイル', errs[2] instanceof AppError && errs[2].code === 'IMAGE_DECODE', errText(errs[2])],
          ['Blob でない値', errs[3] instanceof AppError && errs[3].code === 'IMAGE_DECODE', errText(errs[3])],
          ['文言は design 14.1.9', errs[0].message === '画像を読み込めませんでした。別の画像を選んでください。', errs[0].message],
        ]);
      }),

    t('SV-28', '表示用 URL（Blob URL）の発行と解放：解放した URL はもう読めない', 'createUrlPool().urlOf(blob) → <img> で読む → revokeAll → <img> で読む',
      '発行した URL は画像として読める。revokeAll のあとは読めない（メモリを手放している）',
      async () => {
        // テストページの CSP は fetch で blob: を読めないので、アプリと同じ <img> で確かめる
        const canLoad = async (url) => {
          const img = new Image();
          img.src = url;
          try { await img.decode(); return img.naturalWidth > 0; } catch (e) { return false; }
        };
        const pool = createUrlPool();
        const urls = [pool.urlOf(await jpegOf(40, 30)), pool.urlOf(await jpegOf(50, 30))];
        const before = await Promise.all(urls.map(canLoad));
        pool.revokeAll();
        const after = await Promise.all(urls.map(canLoad));
        return verdict([
          ['発行直後は読める', before.every(Boolean), before.join()],
          ['解放したあとは読めない', after.every((v) => v === false), after.join()],
          ['数も 0', pool.size() === 0],
        ]);
      }),
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
