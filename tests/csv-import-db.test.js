/* =========================================================
   tests/csv-import-db.test.js
   CSV の読み込みの「保存」部分（trades.js の importTrades）と、確認シートの「閉じられない」仕組み（ui/sheet.js）のテスト（T-44）。
   IndexedDB・document を使うので、ブラウザのテストページでだけ実行する（Node.js ではスキップ：runner.js）。
   ・書き出し → 削除 → 読み込みで元に戻る（機種変更＝空の端末／同じ端末で削除したあと上書きで戻す）
   ・スキップ／上書き、上書きしても端末の画像は残る、削除済みは削除済みのまま
   ・1つのトランザクション：途中で失敗したら何も入らない（全部か何もなし）、確認中に記録が変わったら CONFLICT
   ・記録の変更通知は1回だけ（type: 'imported'）
   ・取り込み中のシートは「キャンセル」・背景のタップ・Esc で閉じない

   本物の記録を壊さないため、db.test.js と同じく「fx-trade-note-test-…」という別名の DB を作って使い、終わったら削除する。

   ID：CD-xx（CSV 読み込みの保存）
   ========================================================= */
import { createDb, MIGRATIONS, STORE } from '../js/db.js';
import { DB_VERSION } from '../js/config.js';
import { createTradeService } from '../js/trades.js';
import { prepareCsv } from '../js/csv.js';
import { parseImportBytes, summarizeImport } from '../js/csv-import.js';
import { toJstString } from '../js/datetime.js';
import { on } from '../js/events.js';
import { AppError } from '../js/util.js';
import { openSheet } from '../js/ui/sheet.js';
import { h } from '../js/ui/dom.js';
import { TEST_DB_PREFIX } from './db.test.js';
import { sampleTrade, sampleOpen, uuid } from './csv-import.test.js';
import { show } from './helpers.js';

const CATEGORY = 'CSV読み込み';
const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, requires: 'indexedDB', run });
const tDom = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, requires: 'dom', run });

/** 別名のテスト用 DB を作って fn を実行し、最後に DB ごと削除する（db.test.js の withTestDb と同じ約束） */
async function withTestDb(id, fn) {
  const name = `${TEST_DB_PREFIX}${id}-${Math.random().toString(36).slice(2, 8)}`;
  const db = createDb({ name, version: DB_VERSION, migrations: MIGRATIONS });
  try {
    return await fn(db);
  } finally {
    await db.deleteDatabase();
  }
}

/** 呼ぶたびに1秒進む時計（最初は 2026-10-18T09:00:00+09:00） */
function makeClock(startUtc = '2026-10-18T00:00:00Z') {
  const base = Date.parse(startUtc);
  let n = 0;
  return () => toJstString(new Date(base + (n++) * 1000));
}

/** テスト用の業務処理（決まった時計・1lot は 1万通貨） */
const serviceOf = (db) => createTradeService({ db, now: makeClock(), getLotUnitSize: () => 10000 });

/** 記録の一覧を ID の順に並べる */
const byId = (list) => [...list].sort((a, b) => (a.id < b.id ? -1 : 1));

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

function verdict(checks) {
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) return { actual: `確認${checks.length}項目すべて一致`, pass: true };
  return { actual: failed.map(([label, , detail]) => `×${label}（実際：${show(detail)}）`).join('／'), pass: false };
}

/** 記録の一覧を CSV にして（削除済みも含める）、読み込みの準備（読む → 端末と比べる）までを行う */
async function prepareImport(sourceTrades, deviceTrades) {
  const p = prepareCsv(sourceTrades, { includeDeleted: true });
  const parsed = parseImportBytes(new TextEncoder().encode(p.text));
  if (!parsed.ok) throw new Error(`CSV を読めません：${parsed.error}`);
  return { parsed, summary: summarizeImport(parsed, deviceTrades), rows: parsed.rows.map((r) => r.trade) };
}

/** 取り込みの前後で比べる形（画像・同期の項目は取り込みで変わるので除く） */
const comparable = ({ imageIds, syncStatus, syncedAt, ...rest }) => rest;

/** アプリの保存処理で、いろいろな状態の記録を作る（保有中・決済済み・手入力・削除済み） */
async function seed(svc) {
  const a = await svc.saveNewTrade({ id: uuid(1), accountType: 'real', pair: 'USD/JPY', side: 'buy', entryPrice: 150.123, entryAt: '2026-10-15T21:30:00+09:00', lots: 0.5, slPrice: 149.9, tpPrice: 150.6, tags: ['指標前'], memo: 'メモ, "引用"\n2行目' });
  await svc.closeTrade(a.id, { exitPrice: 150.4, exitAt: '2026-10-15T23:00:00+09:00', exitReason: 'tp' });
  await svc.saveNewTrade({ id: uuid(2), accountType: 'demo', pair: 'EUR/USD', side: 'sell', entryPrice: 1.08512, entryAt: '2026-10-16T17:00:00+09:00', lots: 1, entryReasons: ['ブレイクアウト'], emotion: '=焦り' });
  const c = await svc.saveNewTrade({ id: uuid(3), accountType: 'real', pair: 'GBP/JPY', side: 'sell', entryPrice: 190.5, entryAt: '2026-10-17T10:00:00+09:00', lots: 0.1 });
  await svc.closeTrade(c.id, { exitPrice: 190.1, exitAt: '2026-10-17T12:00:00+09:00', manualProfitJpy: 3980 });
  const d = await svc.saveNewTrade({ id: uuid(4), accountType: 'real', pair: 'USD/JPY', side: 'buy', entryPrice: 149, entryAt: '2026-10-17T22:00:00+09:00', lots: 0.2 });
  await svc.deleteTrade(d.id);
  return svc.getAllTrades();
}

export function collectCsvImportDbTests() {
  return [
    t('CD-01', '書き出し → 端末が空（機種変更・アプリを消した）→ 読み込みで元に戻る',
      '保存処理で4件（決済済み・保有中・手入力・削除済み）を作り、全件を CSV に → 別の空の DB に importTrades',
      '4件追加。画像・同期の項目以外は元の記録とまったく同じ（updatedAt・createdAt・deletedAt も）。syncStatus は pending、syncedAt は null',
      () => withTestDb('CD-01a', (srcDb) => withTestDb('CD-01b', async (dstDb) => {
        const original = await seed(serviceOf(srcDb));
        const { summary, rows } = await prepareImport(original, []);
        const dst = serviceOf(dstDb);
        const result = await dst.importTrades(rows, { overwrite: false, snapshot: summary.snapshot });
        const after = byId(await dst.getAllTrades());
        const before = byId(original);
        return verdict([
          ['追加4件', result.added === 4 && result.overwritten === 0 && result.skipped === 0, result],
          ['件数', after.length === 4, after.length],
          ['中身が同じ', after.every((x, i) => deepEqual(comparable(x), comparable(before[i]))),
            after.map((x, i) => Object.keys(x).filter((k) => !deepEqual(x[k], before[i][k])))],
          ['pending', after.every((x) => x.syncStatus === 'pending' && x.syncedAt === null && x.imageIds.length === 0)],
          ['削除済みは削除済み', after.find((x) => x.id === uuid(4)).deletedAt !== null],
        ]);
      }))),

    t('CD-02', '書き出し → 同じ端末で削除 → 読み込み（上書き）で元に戻る',
      '4件を CSV に → 3件を削除（論理削除）→ 確認すると「すでにある記録」4件・端末の方が新しい3件 → 上書きで取り込む',
      '上書き4件。削除が取り消され、書き出した時点の記録に戻る（updatedAt も CSV の値）',
      () => withTestDb('CD-02', async (db) => {
        const svc = serviceOf(db);
        const exported = await seed(svc);
        for (const id of [uuid(1), uuid(2), uuid(3)]) await svc.deleteTrade(id);
        const { summary, rows } = await prepareImport(exported, await svc.getAllTrades());
        const result = await svc.importTrades(rows, { overwrite: true, snapshot: summary.snapshot });
        const after = byId(await svc.getAllTrades());
        const before = byId(exported);
        return verdict([
          ['すでにある4件', summary.existingCount === 4 && summary.newCount === 0, summary.existingCount],
          ['端末の方が新しい3件', summary.newerOnDevice === 3, summary.newerOnDevice],
          ['上書き4件', result.overwritten === 4 && result.added === 0, result],
          ['元に戻る', after.every((x, i) => deepEqual(comparable(x), comparable(before[i]))),
            after.map((x, i) => Object.keys(x).filter((k) => !deepEqual(x[k], before[i][k])))],
          ['一覧に出る記録3件', after.filter((x) => x.deletedAt == null).length === 3],
        ]);
      })),

    t('CD-03', 'スキップ（初期値）：すでにある記録は変えず、新しい記録だけ追加する',
      '端末に2件。CSV は「端末と同じ ID で中身の違う2件」＋新しい1件 → スキップで取り込む',
      '追加1・スキップ2。端末の2件はメモも updatedAt も変わらない',
      () => withTestDb('CD-03', async (db) => {
        const svc = serviceOf(db);
        await svc.saveNewTrade({ id: uuid(1), accountType: 'real', pair: 'USD/JPY', side: 'buy', entryPrice: 150, entryAt: '2026-10-15T21:30:00+09:00', lots: 1, memo: '端末' });
        await svc.saveNewTrade({ id: uuid(2), accountType: 'real', pair: 'USD/JPY', side: 'sell', entryPrice: 151, entryAt: '2026-10-15T22:30:00+09:00', lots: 1, memo: '端末' });
        const device = await svc.getAllTrades();
        const csv = [sampleOpen({ id: uuid(1), memo: 'CSV' }), sampleOpen({ id: uuid(2), memo: 'CSV' }), sampleTrade({ id: uuid(3) })];
        const { summary, rows } = await prepareImport(csv, device);
        const result = await svc.importTrades(rows, { overwrite: false, snapshot: summary.snapshot });
        const after = await svc.getAllTrades();
        const kept = [uuid(1), uuid(2)].map((id) => [after.find((x) => x.id === id), device.find((x) => x.id === id)]);
        return verdict([
          ['件数', result.added === 1 && result.skipped === 2 && result.overwritten === 0, result],
          ['端末のまま', kept.every(([a, b]) => deepEqual(a, b)), kept.map(([a]) => a.memo)],
          ['新しい記録', after.some((x) => x.id === uuid(3)) && after.length === 3, after.length],
        ]);
      })),

    t('CD-04', '上書きしても端末の画像は残る（design 14.6.11 ②）。syncedAt も端末の値',
      '端末の記録に画像2枚（images にも保存）・syncedAt あり。CSV（画像の枚数2・imageIds なし）で上書き',
      '記録の imageIds は端末の2枚のまま、images にも2枚残る。メモは CSV の値、syncStatus は pending、syncedAt は端末の値',
      () => withTestDb('CD-04', async (db) => {
        const svc = serviceOf(db);
        // 画像の縮小（Canvas）はこのテストの目的ではないので、画像は db に直接入れる
        for (const id of ['img-1', 'img-2']) {
          await db.addImage({ id, tradeId: uuid(1), kind: 'entry', blob: new Blob([id], { type: 'image/jpeg' }), width: 10, height: 10, createdAt: '2026-10-15T21:30:00+09:00' });
        }
        const stored = { ...sampleTrade({ id: uuid(1), memo: '端末' }), imageIds: ['img-1', 'img-2'], syncStatus: 'synced', syncedAt: '2026-10-16T00:00:00+09:00' };
        await db.putTrade(stored);
        const { summary, rows } = await prepareImport([sampleTrade({ id: uuid(1), memo: 'CSV', imageIds: ['x', 'y'] })], await svc.getAllTrades());
        await svc.importTrades(rows, { overwrite: true, snapshot: summary.snapshot });
        const after = await svc.getTrade(uuid(1));
        const imgs = await db.getImagesByTrade(uuid(1));
        return verdict([
          ['imageIds', JSON.stringify(after.imageIds) === JSON.stringify(['img-1', 'img-2']), after.imageIds],
          ['images に2枚', imgs.length >= 2 && ['img-1', 'img-2'].every((id) => imgs.some((x) => x.id === id)), imgs.map((x) => x.id)],
          ['メモは CSV', after.memo === 'CSV', after.memo],
          ['pending', after.syncStatus === 'pending', after.syncStatus],
          ['syncedAt は端末', after.syncedAt === '2026-10-16T00:00:00+09:00', after.syncedAt],
        ]);
      })),

    t('CD-05', '1つのトランザクション：途中の1件で書き込みに失敗したら、それまでの分も入らない（全部か何もなし）',
      '新しい記録3件のうち3件目に保存できない値（関数）を混ぜて importTrades',
      'AppError DB_WRITE。DB の記録は0件のまま',
      () => withTestDb('CD-05', async (db) => {
        const svc = serviceOf(db);
        const csv = [sampleTrade({ id: uuid(1) }), sampleTrade({ id: uuid(2) }), sampleTrade({ id: uuid(3) })];
        const { summary, rows } = await prepareImport(csv, []);
        rows[2] = { ...rows[2], memo: () => 'IndexedDB に保存できない値' };
        let err = null;
        try {
          await svc.importTrades(rows, { overwrite: false, snapshot: summary.snapshot });
        } catch (e) {
          err = e;
        }
        const after = await svc.getAllTrades();
        return verdict([
          ['失敗する', err instanceof AppError && err.code === 'DB_WRITE', err && (err.code || err.name)],
          ['0件のまま', after.length === 0, after.length],
        ]);
      })),

    t('CD-06', '確認中に記録が変わったら CONFLICT で何も書かない（design 14.6.9）。スキップする記録の変更は問題にしない',
      '①上書き：確認したあとに端末の記録を編集 → importTrades ②新しいはずの ID が確認後に保存された ③スキップ：確認後にすでにある記録を編集',
      '①② AppError CONFLICT・新しい記録も入らない ③ 取り込める（新しい記録だけ追加）',
      () => withTestDb('CD-06', async (db) => {
        const svc = serviceOf(db);
        const a = await svc.saveNewTrade({ id: uuid(1), accountType: 'real', pair: 'USD/JPY', side: 'buy', entryPrice: 150, entryAt: '2026-10-15T21:30:00+09:00', lots: 1 });
        const csv = [sampleOpen({ id: uuid(1) }), sampleTrade({ id: uuid(2) }), sampleTrade({ id: uuid(3) })];
        const first = await prepareImport(csv, await svc.getAllTrades());
        await svc.saveTrade({ ...a, memo: '確認中に編集' });
        const err = (e) => (e instanceof AppError ? e.code : e && e.name);
        let e1 = null;
        try { await svc.importTrades(first.rows, { overwrite: true, snapshot: first.summary.snapshot }); } catch (e) { e1 = e; }
        const count1 = (await svc.getAllTrades()).length;

        const second = await prepareImport(csv, await svc.getAllTrades());
        await svc.saveNewTrade({ id: uuid(3), accountType: 'real', pair: 'USD/JPY', side: 'buy', entryPrice: 150, entryAt: '2026-10-15T21:30:00+09:00', lots: 1 });
        let e2 = null;
        try { await svc.importTrades(second.rows, { overwrite: false, snapshot: second.summary.snapshot }); } catch (e) { e2 = e; }
        const count2 = (await svc.getAllTrades()).length;

        const third = await prepareImport(csv, await svc.getAllTrades());
        await svc.saveTrade({ ...(await svc.getTrade(uuid(1))), memo: 'もう一度編集' });
        const r3 = await svc.importTrades(third.rows, { overwrite: false, snapshot: third.summary.snapshot });
        return verdict([
          ['① CONFLICT', err(e1) === 'CONFLICT', err(e1)], ['① 何も入らない', count1 === 1, count1],
          ['② CONFLICT', err(e2) === 'CONFLICT', err(e2)], ['② 何も入らない', count2 === 2, count2],
          ['③ スキップは取り込める', r3.added === 1 && r3.skipped === 2, r3],
        ]);
      })),

    t('CD-07', '記録の変更通知は1回だけ（type: imported・書いた ID の並び）。何も書かなければ出さない',
      '新しい記録2件を取り込む／すべてスキップになる CSV を取り込む',
      '1回目：通知1回・ids 2件。2回目：通知なし',
      () => withTestDb('CD-07', async (db) => {
        const svc = serviceOf(db);
        const got = [];
        const off = on('trades-changed', (d) => got.push(d));
        try {
          const csv = [sampleTrade({ id: uuid(1) }), sampleTrade({ id: uuid(2) })];
          const p1 = await prepareImport(csv, []);
          await svc.importTrades(p1.rows, { overwrite: false, snapshot: p1.summary.snapshot });
          const n1 = got.length;
          const p2 = await prepareImport(csv, await svc.getAllTrades());
          await svc.importTrades(p2.rows, { overwrite: false, snapshot: p2.summary.snapshot });
          return verdict([
            ['1回', n1 === 1, n1],
            ['type・ids', got[0] && got[0].type === 'imported' && got[0].ids.length === 2, got[0]],
            ['スキップだけなら出さない', got.length === 1, got.length],
          ]);
        } finally {
          off();
        }
      })),

    t('CD-08', '取り込みで保存された記録の形（requirements 6.1 の32項目・既存の保存処理で開ける）',
      'CSV から取り込んだ決済済みの記録を、そのあと saveTrade（編集の保存）・reopenTrade（決済の取り消し）にかける',
      '32項目。編集・決済の取り消しが普通にできる',
      () => withTestDb('CD-08', async (db) => {
        const svc = serviceOf(db);
        const p = await prepareImport([sampleTrade({ id: uuid(1) })], []);
        await svc.importTrades(p.rows, { overwrite: false, snapshot: p.summary.snapshot });
        const stored = await db.getTrade(uuid(1));
        const edited = await svc.saveTrade({ ...stored, memo: '編集した' }, { expectedUpdatedAt: stored.updatedAt });
        const reopened = await svc.reopenTrade(uuid(1));
        return verdict([
          ['32項目', Object.keys(stored).length === 32, Object.keys(stored).length],
          ['編集できる', edited.memo === '編集した'],
          ['取り消せる', reopened.status === 'open' && reopened.pips === null, reopened.status],
          ['ストアは trades', STORE.TRADES === 'trades'],
        ]);
      })),

    tDom('CD-09', '取り込み中のシートは閉じない：「キャンセル」無効・背景のタップ・Esc でも閉じない。終わったら閉じられる',
      'openSheet の control.setDismissible(false) → キャンセル・背景・Esc（cancel イベント）→ setDismissible(true)・setCancelHidden(true) → 背景',
      '閉じられない間はシートが開いたまま。キャンセルは無効表示。許したあとは背景のタップで閉じ、値は null',
      async () => {
        let control = null;
        const p = openSheet({
          title: 'テスト',
          content: (finish, c) => {
            control = c;
            return { body: h('p', {}, '中身'), footer: h('button', { type: 'button' }, 'ボタン') };
          },
        });
        const dlg = document.querySelector('dialog.dialog--bottom');
        const cancel = dlg.querySelector('.sheet__header .btn--text');
        control.setDismissible(false);
        cancel.click();
        dlg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        dlg.dispatchEvent(new Event('cancel', { cancelable: true }));
        const stillOpen = dlg.isConnected && dlg.open;
        const cancelDisabled = cancel.disabled;
        control.setDismissible(true);
        control.setCancelHidden(true);
        const hidden = cancel.hidden;
        dlg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const value = await p;
        return verdict([
          ['開いたまま', stillOpen], ['キャンセルは無効', cancelDisabled], ['キャンセルを隠せる', hidden],
          ['許したら閉じる', !dlg.isConnected && value === null, value],
        ]);
      }),
  ];
}
