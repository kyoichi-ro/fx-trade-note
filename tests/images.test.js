/* =========================================================
   tests/images.test.js
   チャート画像（T-24）の「画面にも Canvas にも依存しない部分」のテスト（architecture.md 11章、design.md 14.1.9・14.4.6）。
     ・js/images.js … 縮小後の大きさ（長辺 1280px・拡大しない）・JPEG の品質の段階（0.82→0.5 で 250KB 以内、それでも超えたら 1024px）・
                      サイズが超えても添付を失敗させない・半分ずつ縮める中間の大きさ・4枚の判定・imageIds の組み立て・孤立画像の判定・
                      表示用 URL の発行と解放・壊れた Blob の見分け・端末の空きが少ないかの判定・表示の文言
     ・js/trades.js … 決済で追加した画像を最新の imageIds に足す（buildClosedTrade）・画像 ID の形の確認（normalizeTrade）
     ・js/detail-view.js … 詳細の画像グループ（0枚なら出さない）
   Canvas・IndexedDB を使う部分（実際の縮小・保存・掃除）は tests/db.test.js のブラウザ専用テスト（SV-18〜）で確かめる。
   Node.js でもブラウザでも実行する。

   ID：IM-xx（チャート画像）
   ========================================================= */
import {
  fitWithin, planEncodeAttempts, encodeWithinLimit, halvingSteps, remainingSlots, planAddition, buildImageIds, mergeImageIds,
  findOrphanImages, isLowStorage, imageKindLabel, imageAlt, imageGroupHeader, addRowText, viewerCounter, looksLikeImage,
  createUrlPool, inspectBlob, IMAGE_TEXT,
} from '../js/images.js';
import { buildClosedTrade, normalizeTrade } from '../js/trades.js';
import { buildDetailView } from '../js/detail-view.js';
import { AppError } from '../js/util.js';
import {
  MAX_IMAGES_PER_TRADE, IMAGE_MAX_EDGE, IMAGE_FALLBACK_EDGE, IMAGE_QUALITY_STEPS, IMAGE_MAX_BYTES, IMAGE_ORPHAN_MIN_AGE_MINUTES,
} from '../js/config.js';
import { sameArray, show } from './helpers.js';

const CATEGORY = 'チャート画像';

const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run });

/** 確認項目を1つずつ照らし、1つでも違えば不合格にして違った項目を示す（他のテストファイルと同じ形） */
function verdict(checks) {
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) return { actual: `確認${checks.length}項目すべて一致`, pass: true };
  return { actual: failed.map(([label, , detail]) => `×${label}（実際：${show(detail)}）`).join('／'), pass: false };
}

const size = (r) => `${r.width}x${r.height}`;
/** 例外になるか（なったらそのエラー、ならなければ null） */
async function errorOf(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

/** 指定バイト数の Blob */
const blobOf = (bytes) => new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });

/** 記録（決済用）。必要な項目だけ */
function storedTrade(over = {}) {
  return {
    id: 't1', accountType: 'real', pair: 'USD/JPY', side: 'buy', entryPrice: 150, entryAt: '2026-10-15T21:30:00+09:00', lots: 1, lotUnitSize: 10000,
    exitPrice: null, exitAt: null, tags: [], entryReasons: [], imageIds: ['a', 'b'], exitReason: null, exitEmotion: null, memo: null,
    quoteToJpyRate: null, ...over,
  };
}

const NOW = new Date('2026-10-16T12:00:00+09:00');

export function collectImageTests() {
  return [
    /* ---------- 縮小・圧縮の計算（architecture 11.1） ---------- */
    t('IM-01', '縮小後の大きさ：長辺が 1280px を超えるときだけ、縦横比を保って縮小する（拡大しない）', 'fitWithin(幅, 高さ)',
      '4000x3000→1280x960／3000x4000→960x1280（縦長）／1280x720・800x600 はそのまま／極端に細長くても 1px 以上',
      () => {
        const f = (w, h, e) => size(fitWithin(w, h, e));
        return verdict([
          ['横長 4000x3000', f(4000, 3000) === '1280x960', f(4000, 3000)],
          ['縦長 3000x4000', f(3000, 4000) === '960x1280', f(3000, 4000)],
          ['ちょうど 1280x720', f(1280, 720) === '1280x720', f(1280, 720)],
          ['小さい 800x600 は拡大しない', f(800, 600) === '800x600', f(800, 600)],
          ['1281x1 は 1280x1（0 にならない）', f(1281, 1) === '1280x1', f(1281, 1)],
          ['20000x10 は幅 1280・高さ 1（四捨五入で 0 にならない）', f(20000, 10) === '1280x1', f(20000, 10)],
          ['長辺 1024 指定', f(4000, 3000, IMAGE_FALLBACK_EDGE) === '1024x768', f(4000, 3000, IMAGE_FALLBACK_EDGE)],
          ['config の値', IMAGE_MAX_EDGE === 1280 && IMAGE_FALLBACK_EDGE === 1024 && IMAGE_MAX_BYTES === 250 * 1024 && sameArray(IMAGE_QUALITY_STEPS, [0.82, 0.72, 0.62, 0.5]), 'NG'],
          ['0 以下は TypeError', (() => { try { fitWithin(0, 10); return false; } catch (e) { return e instanceof TypeError; } })(), 'NG'],
        ]);
      }),

    t('IM-02', 'JPEG にする試行の並び：長辺 1280px で品質 0.82→0.5、それでも超えたら長辺 1024px で同じ順', 'planEncodeAttempts(幅, 高さ)',
      '大きい画像は 4+4 回。1024px 以下の画像は 1024px のやり直しを省いて 4 回',
      () => {
        const big = planEncodeAttempts(4000, 3000);
        const small = planEncodeAttempts(800, 600);
        const edge = planEncodeAttempts(1024, 700);
        const mid = planEncodeAttempts(1280, 720);
        return verdict([
          ['大きい画像は 8 回', big.length === 8, big.length],
          ['最初の4回は 1280x960 で品質 0.82→0.5', big.slice(0, 4).every((a) => size(a) === '1280x960' && a.stage === 'main') && sameArray(big.slice(0, 4).map((a) => a.quality), [0.82, 0.72, 0.62, 0.5]), show(big.slice(0, 4).map((a) => `${size(a)}@${a.quality}`))],
          ['あとの4回は 1024x768', big.slice(4).every((a) => size(a) === '1024x768' && a.stage === 'fallback') && sameArray(big.slice(4).map((a) => a.quality), [0.82, 0.72, 0.62, 0.5]), show(big.slice(4).map((a) => `${size(a)}@${a.quality}`))],
          ['小さい画像は 4 回（そのままの大きさ）', small.length === 4 && small.every((a) => size(a) === '800x600'), small.length],
          ['ちょうど 1024 の画像は 4 回', edge.length === 4, edge.length],
          ['1280x720 は 1024x576 でやり直す', mid.length === 8 && size(mid[4]) === '1024x576', mid.length],
        ]);
      }),

    t('IM-03', '上限（250KB）以内になった最初の結果を使う', 'encodeWithinLimit（品質が下がるほど小さくなる偽の変換）',
      '0.82 が 300KB・0.72 が 260KB・0.62 が 240KB なら 0.62 で止まる（3回）。最初から 100KB なら 1回で止まる',
      async () => {
        const sizes = { 0.82: 300, 0.72: 260, 0.62: 240, 0.5: 200 };
        const calls = [];
        const r = await encodeWithinLimit(planEncodeAttempts(4000, 3000), async (a) => { calls.push(a.quality); return blobOf(sizes[a.quality] * 1024); });
        const calls2 = [];
        const r2 = await encodeWithinLimit(planEncodeAttempts(800, 600), async (a) => { calls2.push(a.quality); return blobOf(100 * 1024); });
        const exact = await encodeWithinLimit(planEncodeAttempts(800, 600), async () => blobOf(IMAGE_MAX_BYTES));
        return verdict([
          ['品質 0.62 を使う', r.quality === 0.62 && r.withinLimit === true, r.quality],
          ['3回で止まる', r.tries === 3 && calls.length === 3, calls.length],
          ['大きさは 1280x960', size(r) === '1280x960', size(r)],
          ['100KB なら1回', r2.tries === 1 && calls2.length === 1 && r2.quality === 0.82, r2.tries],
          ['ちょうど 250KB は上限以内', exact.withinLimit === true && exact.tries === 1, exact.tries],
        ]);
      }),

    t('IM-04', '品質を下げても超えるときは 1024px でやり直し、それでも超えてもサイズだけを理由に失敗させない', 'encodeWithinLimit（1280px では常に 400KB、1024px では 0.5 だけ 240KB／どれも 400KB 以上）',
      '1024px の 0.5 で止まる（5〜8回目）。全部超えるなら例外にせず、いちばん小さかった結果を返す（withinLimit=false）',
      async () => {
        const attempts = planEncodeAttempts(4000, 3000);
        const calls = [];
        const r = await encodeWithinLimit(attempts, async (a) => { calls.push(`${size(a)}@${a.quality}`); return blobOf((a.width === 1024 && a.quality === 0.5 ? 240 : 400) * 1024); });
        const sizes = [500, 480, 470, 460, 450, 430, 420, 410].map((k) => k * 1024);
        let i = 0;
        const all = await encodeWithinLimit(attempts, async () => blobOf(sizes[i++]));
        return verdict([
          ['1024px の 0.5 を使う', size(r) === '1024x768' && r.quality === 0.5 && r.withinLimit === true, `${size(r)}@${r.quality}`],
          ['8回目で止まる', r.tries === 8 && calls.length === 8, calls.length],
          ['全部超えても例外にならない', all.withinLimit === false && all.tries === 8, all.tries],
          ['いちばん小さい結果（410KB）を返す', all.blob.size === 410 * 1024 && size(all) === '1024x768' && all.quality === 0.5, `${all.blob.size}`],
        ]);
      }),

    t('IM-05', '変換できなかったとき（Blob が作れない・空）は IMAGE_DECODE。試行の並びが空は TypeError', 'encodeWithinLimit（null を返す変換／空の Blob／空の並び）',
      'AppError IMAGE_DECODE（文言は design 14.1.9）。空の並びは TypeError',
      async () => {
        const e1 = await errorOf(() => encodeWithinLimit(planEncodeAttempts(100, 100), async () => null));
        const e2 = await errorOf(() => encodeWithinLimit(planEncodeAttempts(100, 100), async () => new Blob([])));
        const e3 = await errorOf(() => encodeWithinLimit([], async () => blobOf(10)));
        return verdict([
          ['null は IMAGE_DECODE', e1 instanceof AppError && e1.code === 'IMAGE_DECODE', e1 && e1.code],
          ['空の Blob も IMAGE_DECODE', e2 instanceof AppError && e2.code === 'IMAGE_DECODE', e2 && e2.code],
          ['文言は design 14.1.9', e1.message === '画像を読み込めませんでした。別の画像を選んでください。' && IMAGE_TEXT.decodeError === e1.message, e1.message],
          ['空の並びは TypeError', e3 instanceof TypeError, e3 && e3.name],
        ]);
      }),

    t('IM-06', '大きな画像は半分ずつ縮める（iPhone の Safari で文字がかすれにくい）。中間の大きさ', 'halvingSteps(元の幅, 元の高さ, 目標の幅, 目標の高さ)',
      '4032x3024→1280x960 は 2016x1512 の1段。12000x9000→1280x960 は 3 段。目標の2倍未満なら段なし',
      () => {
        const s = (a, b, c, d) => halvingSteps(a, b, c, d).map(size).join('>');
        return verdict([
          ['4032x3024 → 1280x960', s(4032, 3024, 1280, 960) === '2016x1512', s(4032, 3024, 1280, 960)],
          ['12000x9000 → 1280x960', s(12000, 9000, 1280, 960) === '6000x4500>3000x2250>1500x1125', s(12000, 9000, 1280, 960)],
          ['2500x1875 → 1280x960 は 2倍未満で段なし', s(2500, 1875, 1280, 960) === '', s(2500, 1875, 1280, 960)],
          ['小さい画像は段なし', s(800, 600, 800, 600) === '', s(800, 600, 800, 600)],
          ['どの段も目標より小さくならない', halvingSteps(10000, 7000, 1280, 896).every((x) => x.width >= 1280 && x.height >= 896), 'NG'],
        ]);
      }),

    /* ---------- 枚数・imageIds（requirements F-05・architecture 11.1・11.4） ---------- */
    t('IM-07', '1トレード最大4枚：残り枚数と、まとめて選んだときの扱い', 'remainingSlots・planAddition',
      '0枚で3枚選べば3枚追加／2枚ある所に3枚選ぶと先頭の2枚だけ追加し1枚は追加しない／4枚なら0枚追加',
      () => {
        const p = (c, n) => planAddition(c, n);
        return verdict([
          ['上限は4', MAX_IMAGES_PER_TRADE === 4, MAX_IMAGES_PER_TRADE],
          ['残り枚数', remainingSlots(0) === 4 && remainingSlots(3) === 1 && remainingSlots(4) === 0 && remainingSlots(7) === 0, 'NG'],
          ['0枚+3枚', p(0, 3).accept === 3 && p(0, 3).rejected === 0, show(p(0, 3))],
          ['2枚+3枚', p(2, 3).accept === 2 && p(2, 3).rejected === 1 && p(2, 3).remaining === 2, show(p(2, 3))],
          ['4枚+1枚', p(4, 1).accept === 0 && p(4, 1).rejected === 1, show(p(4, 1))],
          ['0枚選択', p(1, 0).accept === 0 && p(1, 0).rejected === 0, show(p(1, 0))],
          ['10枚選んでも4枚まで', p(0, 10).accept === 4 && p(0, 10).rejected === 6, show(p(0, 10))],
        ]);
      }),

    t('IM-08', 'imageIds の組み立て：外した画像を除き、追加した画像を後ろに足す。決済は最新の imageIds に足すだけ', 'buildImageIds・mergeImageIds',
      '(a,b,c) から b を外し d を追加 → a,c,d。重複・空・文字でない値は除く。外すだけ・足すだけ・何もしないも正しい',
      () => {
        const j = (x) => x.join(',');
        return verdict([
          ['外して追加', j(buildImageIds(['a', 'b', 'c'], ['d'], ['b'])) === 'a,c,d', j(buildImageIds(['a', 'b', 'c'], ['d'], ['b']))],
          ['何もしない', j(buildImageIds(['a', 'b'], [], [])) === 'a,b', 'NG'],
          ['外すだけ', j(buildImageIds(['a', 'b'], [], ['a'])) === 'b', 'NG'],
          ['足すだけ', j(buildImageIds(['a'], ['b', 'c'], [])) === 'a,b,c', 'NG'],
          ['重複を除く', j(buildImageIds(['a', 'b'], ['b', 'c', 'c'], [])) === 'a,b,c', j(buildImageIds(['a', 'b'], ['b', 'c', 'c'], []))],
          ['もとにない ID を外しても無視', j(buildImageIds(['a'], [], ['zzz'])) === 'a', 'NG'],
          ['追加して外した画像は入らない', j(buildImageIds(['a'], ['d'], ['d'])) === 'a', j(buildImageIds(['a'], ['d'], ['d']))],
          ['空・文字でない値は除く', j(buildImageIds(['a', '', null, 5, 'b'], undefined, undefined)) === 'a,b', j(buildImageIds(['a', '', null, 5, 'b']))],
          ['配列でないもとは空', j(buildImageIds(null, ['x'], [])) === 'x' && buildImageIds(undefined).length === 0, 'NG'],
          ['決済は最新の後ろに足す', j(mergeImageIds(['a', 'b'], ['c'])) === 'a,b,c' && j(mergeImageIds(['a'], [])) === 'a', 'NG'],
          ['入力の配列は書き換えない', (() => { const base = ['a']; buildImageIds(base, ['b'], ['a']); return j(base) === 'a'; })(), 'NG'],
        ]);
      }),

    /* ---------- 孤立画像（architecture 11.6） ---------- */
    t('IM-09', '孤立画像の判定：記録にも下書きにも使われず、作成から1日以上たった画像だけ', 'findOrphanImages（現在 2026-10-16 12:00）',
      '記録の imageIds・下書きの addedImageIds・削除済みの記録の imageIds に載る画像は残す。1日未満・日時が読めない・未来は残す',
      () => {
        const old = '2026-10-14T10:00:00+09:00';     // 2日前
        const fresh = '2026-10-16T11:00:00+09:00';   // 1時間前
        const justDay = '2026-10-15T12:00:00+09:00'; // ちょうど1日前
        const images = [
          { id: 'used', createdAt: old }, { id: 'inDraft', createdAt: old }, { id: 'inDeleted', createdAt: old },
          { id: 'orphanOld', createdAt: old }, { id: 'orphanFresh', createdAt: fresh }, { id: 'orphanJustDay', createdAt: justDay },
          { id: 'badDate', createdAt: 'xx' }, { id: 'future', createdAt: '2026-10-17T12:00:00+09:00' },
        ];
        const trades = [{ imageIds: ['used'] }, { imageIds: ['inDeleted', 'gone'], deletedAt: '2026-10-15T09:00:00+09:00' }, { imageIds: undefined }];
        const drafts = [{ addedImageIds: ['inDraft'] }, { addedImageIds: undefined }];
        const r = findOrphanImages({ images, trades, drafts, now: NOW });
        return verdict([
          ['1日 = 1440分', IMAGE_ORPHAN_MIN_AGE_MINUTES === 1440, IMAGE_ORPHAN_MIN_AGE_MINUTES],
          ['古い孤立画像と、ちょうど1日前のものだけ', sameArray([...r].sort(), ['orphanJustDay', 'orphanOld']), r.join(',')],
          ['記録・下書き・削除済みの記録の画像は残る', !r.includes('used') && !r.includes('inDraft') && !r.includes('inDeleted'), r.join(',')],
          ['新しい画像・日時が読めない・未来は残す', !r.includes('orphanFresh') && !r.includes('badDate') && !r.includes('future'), r.join(',')],
          ['空の入力は空', findOrphanImages({ images: [], trades: [], drafts: [], now: NOW }).length === 0 && findOrphanImages({ now: NOW }).length === 0, 'NG'],
          ['期間を変えられる', findOrphanImages({ images, trades, drafts, now: NOW, minAgeMinutes: 60 }).includes('orphanFresh'), 'NG'],
        ]);
      }),

    /* ---------- 表示用 URL・壊れた Blob・空き容量 ---------- */
    t('IM-10', '表示用 URL の入れ物：発行した URL をすべて解放できる（画面を離れるときに必ず呼ぶ）', 'createUrlPool（発行・解放を記録する偽の関数）',
      '発行した分だけ数が増え、revokeAll で全部解放して 0 に戻る。1つだけの解放も二重に解放しない',
      () => {
        const made = [];
        const freed = [];
        const pool = createUrlPool({ create: (b) => { const u = `blob:test/${made.length}`; made.push(u); return u; }, revoke: (u) => freed.push(u) });
        const u1 = pool.urlOf(new Blob(['a']));
        const u2 = pool.urlOf(new Blob(['b']));
        const u3 = pool.urlOf(new Blob(['c']));
        const sizeAfterIssue = pool.size();
        pool.revoke(u2);
        pool.revoke(u2);
        const sizeAfterOne = pool.size();
        pool.revokeAll();
        pool.revokeAll();
        return verdict([
          ['発行した分が数えられる', sizeAfterIssue === 3 && u1 === 'blob:test/0' && u3 === 'blob:test/2', sizeAfterIssue],
          ['1つ解放して残り2', sizeAfterOne === 2, sizeAfterOne],
          ['全部解放して 0', pool.size() === 0, pool.size()],
          ['各 URL をちょうど1回ずつ解放', freed.length === 3 && new Set(freed).size === 3, show(freed)],
        ]);
      }),

    t('IM-11', '保存された Blob が読み出せるか：Blob でない・空・画像の形でない値は「読み込めません」にする', 'inspectBlob',
      'JPEG・PNG・WebP の先頭を持つ Blob は true。空の Blob・文字・null・先頭が 0 で埋まった Blob は false',
      async () => {
        const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])], { type: 'image/jpeg' });
        const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]);
        const webp = new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])]);
        const zeros = new Blob([new Uint8Array(100)], { type: 'image/jpeg' });
        const riffOnly = new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x41, 0x56, 0x49, 0x20])]); // AVI は画像ではない
        return verdict([
          ['JPEG', (await inspectBlob(jpeg)) === true, 'NG'],
          ['PNG', (await inspectBlob(png)) === true, 'NG'],
          ['WebP', (await inspectBlob(webp)) === true, 'NG'],
          ['空の Blob', (await inspectBlob(new Blob([]))) === false, 'NG'],
          ['0 で埋まった Blob', (await inspectBlob(zeros)) === false, 'NG'],
          ['画像ではない RIFF', (await inspectBlob(riffOnly)) === false, 'NG'],
          ['文字・null・undefined', (await inspectBlob('x')) === false && (await inspectBlob(null)) === false && (await inspectBlob(undefined)) === false, 'NG'],
          ['短すぎるデータ', (await inspectBlob(new Blob([new Uint8Array([0xff, 0xd8])]))) === false && looksLikeImage(new Uint8Array([0xff])) === false, 'NG'],
        ]);
      }),

    t('IM-12', '端末の空きが少ないか：残り 10MB 未満のとき注意を出す。調べられないときは出さない', 'isLowStorage({ quota, usage })',
      '残り 9.9MB は true・10MB ちょうどは false。値がない・数でない・undefined は false',
      () => {
        const MB = 1024 * 1024;
        return verdict([
          ['残り 9.9MB', isLowStorage({ quota: 100 * MB, usage: 90.1 * MB }) === true, 'NG'],
          ['残りちょうど 10MB', isLowStorage({ quota: 100 * MB, usage: 90 * MB }) === false, 'NG'],
          ['十分ある', isLowStorage({ quota: 1000 * MB, usage: 1 * MB }) === false, 'NG'],
          ['使用量が上限を超えている', isLowStorage({ quota: 10 * MB, usage: 20 * MB }) === true, 'NG'],
          ['調べられない', isLowStorage(undefined) === false && isLowStorage({}) === false && isLowStorage({ quota: NaN, usage: 1 }) === false, 'NG'],
        ]);
      }),

    t('IM-13', '画像まわりの文言（design 14.1.9・14.2.10・14.4.1・14.4.6）', 'addRowText・imageAlt・imageGroupHeader・viewerCounter・IMAGE_TEXT',
      '「画像を追加（残り2枚）」「画像は4枚までです」「エントリー時の画像 1/2」「画像（2枚）」「1 / 2」「4枚を超えた分は追加しませんでした」',
      () => verdict([
        ['追加の行', addRowText(2) === '画像を追加（残り2枚）' && addRowText(4) === '画像を追加（残り4枚）', addRowText(2)],
        ['上限の行', addRowText(0) === '画像は4枚までです', addRowText(0)],
        ['alt（エントリー時）', imageAlt('entry', 0, 2) === 'エントリー時の画像 1/2', imageAlt('entry', 0, 2)],
        ['alt（決済時）', imageAlt('exit', 1, 2) === '決済時の画像 2/2', imageAlt('exit', 1, 2)],
        ['添付タイミングの呼び名', imageKindLabel('entry') === 'エントリー時' && imageKindLabel('exit') === '決済時', 'NG'],
        ['グループ見出し', imageGroupHeader(2) === '画像（2枚）', imageGroupHeader(2)],
        ['拡大表示の枚数', viewerCounter(0, 2) === '1 / 2' && viewerCounter(1, 2) === '2 / 2', viewerCounter(0, 2)],
        ['超えた分・上限・読み込めない', IMAGE_TEXT.overLimit === '4枚を超えた分は追加しませんでした' && IMAGE_TEXT.limitReached === '画像は4枚までです' && IMAGE_TEXT.decodeError === '画像を読み込めませんでした。別の画像を選んでください。', 'NG'],
        ['「外した画像」の注記', IMAGE_TEXT.removedNote === '外した画像は「変更を保存」で削除されます。', IMAGE_TEXT.removedNote],
      ])),

    /* ---------- 記録との組み立て（architecture 8章） ---------- */
    t('IM-14', '決済で追加した画像は、保存されている最新の imageIds の後ろに足す。追加しないときは imageIds を変えない', 'buildClosedTrade(stored, { …, addImageIds })',
      '(a,b)+(c) → a,b,c。addImageIds を渡さなければ a,b のまま。重複は足さない',
      () => {
        const input = { exitPrice: 150.25, exitAt: '2026-10-15T23:05:00+09:00' };
        const withAdd = buildClosedTrade(storedTrade(), { ...input, addImageIds: ['c'] });
        const none = buildClosedTrade(storedTrade(), input);
        const dup = buildClosedTrade(storedTrade(), { ...input, addImageIds: ['b', 'c'] });
        const empty = buildClosedTrade(storedTrade({ imageIds: [] }), { ...input, addImageIds: ['x'] });
        return verdict([
          ['後ろに足す', withAdd.imageIds.join() === 'a,b,c', withAdd.imageIds.join()],
          ['渡さなければそのまま', none.imageIds.join() === 'a,b', none.imageIds.join()],
          ['重複は足さない', dup.imageIds.join() === 'a,b,c', dup.imageIds.join()],
          ['空の記録に足す', empty.imageIds.join() === 'x', empty.imageIds.join()],
          ['元の記録の配列は書き換えない', (() => { const s = storedTrade(); buildClosedTrade(s, { ...input, addImageIds: ['c'] }); return s.imageIds.join() === 'a,b'; })(), 'NG'],
        ]);
      }),

    t('IM-15', '記録の imageIds は空でない文字列の配列だけ受け付ける（壊れた ID を保存して画像が探せなくなるのを防ぐ）', 'normalizeTrade({ imageIds: … })',
      '[] と ["a"] は通る。[""]・[1]・[null] は TypeError。配列でないものも TypeError',
      () => {
        const bad = (ids) => { try { normalizeTrade({ ...storedTrade(), imageIds: ids }); return false; } catch (e) { return e instanceof TypeError; } };
        const ok = (ids) => { try { return normalizeTrade({ ...storedTrade(), imageIds: ids }).imageIds.join() === ids.join(); } catch (e) { return false; } };
        return verdict([
          ['空の配列', ok([]), 'NG'], ['普通の ID', ok(['a', 'b']), 'NG'],
          ['空文字', bad(['']), 'NG'], ['数値', bad([1]), 'NG'], ['null', bad([null]), 'NG'], ['文字列そのもの', bad('abc'), 'NG'],
          ['未指定は空の配列', normalizeTrade({ ...storedTrade(), imageIds: undefined }).imageIds.length === 0, 'NG'],
        ]);
      }),

    t('IM-16', '詳細の画像グループ：画像が0枚なら出さない。あれば枚数つきの見出しと ID の並び（表示順は imageIds）', 'buildDetailView(記録).images',
      '0枚は null。2枚は 見出し「画像（2枚）」・ids が imageIds の順。壊れた値（空・重複）は除く',
      () => {
        const base = { ...storedTrade(), createdAt: '2026-10-15T21:30:40+09:00', updatedAt: '2026-10-15T21:30:40+09:00' };
        const none = buildDetailView({ ...base, imageIds: [] }, NOW);
        const two = buildDetailView({ ...base, imageIds: ['x1', 'x2'] }, NOW);
        const broken = buildDetailView({ ...base, imageIds: ['x1', '', null, 'x1', 'x2'] }, NOW);
        const missing = buildDetailView({ ...base, imageIds: undefined }, NOW);
        return verdict([
          ['0枚は出さない', none.images === null, show(none.images)],
          ['未指定でも止まらない', missing.images === null, show(missing.images)],
          ['2枚の見出し', two.images && two.images.header === '画像（2枚）', show(two.images)],
          ['ID の並び', two.images && two.images.ids.join() === 'x1,x2', show(two.images)],
          ['壊れた値は除く', broken.images && broken.images.ids.join() === 'x1,x2' && broken.images.header === '画像（2枚）', show(broken.images)],
        ]);
      }),
  ];
}
