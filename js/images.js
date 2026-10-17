/* =========================================================
   js/images.js
   チャート画像の業務処理（architecture.md 4.2・11章）。

   【T-12：保存の土台】
   ・画像の保存（id・createdAt を付ける）・1枚取得・トレード単位の取得・物理削除。
   ・画像は大きく、シートにも同期しないため、削除は論理削除ではなく実際に消す（物理削除：architecture 11.4・20章 ⑤）。
   【T-24：読み込み・縮小・圧縮・表示・後片付け】
   ・縮小の計算・JPEG の品質の段階・4枚の判定・imageIds の組み立て・孤立画像の判定は、画面にも Canvas にも依存しない
     純粋な関数にしてある（Node.js のテストで確かめられる：tests/images.test.js）。データ消失・容量に直結する判断なので、
     画面を開かずに確かめられる形にしておくため。
   ・画像ファイルの読み込み・縮小・JPEG 圧縮（prepareImage）だけが <img>・<canvas> を使う（architecture 11.1・11.2）。
   ・表示用 URL（URL.createObjectURL）は createUrlPool() で発行し、画面を離れるときに必ず解放する（architecture 11.3）。
   ・保存した画像が読み出せない（Blob が壊れている・空）ときは、その画像だけ「読み込めません」にして、記録全体は壊さない
     （iPhone で Blob の保存が不安定な場合の保険：architecture 17章 #11。loadImage / inspectBlob）。
   ・孤立画像（記録にも下書きにも使われていない画像）の掃除（sweepOrphans：architecture 11.6）。

   【画像と記録のつながり（データを壊さない順序）】
   画像は「選んで縮小した時点」で先に images へ保存し、そのあと記録（imageIds）を保存する（architecture 11.5）。
   記録の保存が失敗しても、画像は下書き（addedImageIds）が覚えているので、孤立画像にならず、もう一度保存できる。
   逆順（記録を先に保存して画像を後から保存）にすると、画像の保存に失敗したときに「記録が存在しない画像を指す」状態が残るため使わない。

   依存（architecture 4.2）：db, datetime, util, config
   ========================================================= */
import { appDb, IMAGE_KEYS, STORE } from './db.js';
import { nowJst, diffMinutes } from './datetime.js';
import { newId, assertKnownKeys, AppError } from './util.js';
import {
  MAX_IMAGES_PER_TRADE, IMAGE_MAX_EDGE, IMAGE_FALLBACK_EDGE, IMAGE_QUALITY_STEPS, IMAGE_MAX_BYTES,
  IMAGE_ORPHAN_MIN_AGE_MINUTES, LOW_STORAGE_BYTES,
} from './config.js';

/** 添付タイミング（requirements 6.2 kind） */
const IMAGE_KINDS = Object.freeze(['entry', 'exit']);

/** 画面に出す文言（design 14.1.9・14.4.6。画面の正式な文言は design が正） */
export const IMAGE_TEXT = Object.freeze({
  decodeError: '画像を読み込めませんでした。別の画像を選んでください。',
  overLimit: `${MAX_IMAGES_PER_TRADE}枚を超えた分は追加しませんでした`,
  limitReached: `画像は${MAX_IMAGES_PER_TRADE}枚までです`,
  broken: '読み込めません',
  lowStorage: '端末の空き容量が少なくなっています。画像を追加すると保存できなくなる可能性があります。',
  removedNote: '外した画像は「変更を保存」で削除されます。',
  discardNote: '追加した画像も削除されます。',
});

/* ---------------------------------------------------------
   純粋な関数①：縮小・圧縮の計算（architecture 11.1）
   --------------------------------------------------------- */

/**
 * 長辺が maxEdge を超えるときだけ、縦横比を保って縮小した大きさを返す（小さい画像は拡大しない）。
 * 端数は四捨五入し、どちらの辺も 1px 未満にはしない（極端に細長い画像でも幅 0 にならないように）。
 * @param {number} width
 * @param {number} height
 * @param {number} [maxEdge]
 * @returns {{width: number, height: number}}
 */
export function fitWithin(width, height, maxEdge = IMAGE_MAX_EDGE) {
  if (!(width > 0) || !(height > 0)) throw new TypeError('images：width・height は正の数で渡してください');
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const ratio = maxEdge / longEdge;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

/**
 * JPEG にするときの試行の並び（architecture 11.1 ⑤）：
 *   ①長辺 1280px（小さい画像はそのままの大きさ）で、品質 0.82 → 0.72 → 0.62 → 0.5
 *   ②それでも 250KB を超えたら、長辺 1024px で同じ品質の順にもう一度
 * 元の画像がすでに 1024px 以下のとき、②は①と同じ大きさになり意味がないので省く。
 * @returns {{width: number, height: number, quality: number, stage: 'main'|'fallback'}[]}
 */
export function planEncodeAttempts(width, height, {
  maxEdge = IMAGE_MAX_EDGE, fallbackEdge = IMAGE_FALLBACK_EDGE, qualities = IMAGE_QUALITY_STEPS,
} = {}) {
  const main = fitWithin(width, height, maxEdge);
  const fallback = fitWithin(width, height, fallbackEdge);
  const out = qualities.map((quality) => ({ ...main, quality, stage: 'main' }));
  if (fallback.width !== main.width || fallback.height !== main.height) {
    for (const quality of qualities) out.push({ ...fallback, quality, stage: 'fallback' });
  }
  return out;
}

/**
 * 試行の並びを順に実行し、上限（既定 250KB）以内になった最初の結果を返す。
 * すべて上限を超えたときも添付は失敗させず、いちばん小さかった結果を返す（「サイズだけを理由に添付を失敗させない」：architecture 11.1）。
 * encode(試行) は Blob を返す関数（実際は canvas.toBlob。テストでは偽物を渡す）。null が返ったら変換できなかったものとして IMAGE_DECODE。
 * @param {{width:number, height:number, quality:number}[]} attempts
 * @param {(attempt: object) => Promise<Blob|null>} encode
 * @param {{maxBytes?: number}} [opts]
 * @returns {Promise<{blob: Blob, width: number, height: number, quality: number, withinLimit: boolean, tries: number}>}
 */
export async function encodeWithinLimit(attempts, encode, { maxBytes = IMAGE_MAX_BYTES } = {}) {
  if (!Array.isArray(attempts) || attempts.length === 0) throw new TypeError('images：試行の並びが空です');
  let best = null;
  let tries = 0;
  for (const attempt of attempts) {
    const blob = await encode(attempt);
    tries += 1;
    if (!blob || !(blob.size > 0)) throw new AppError('IMAGE_DECODE', IMAGE_TEXT.decodeError);
    const result = { blob, width: attempt.width, height: attempt.height, quality: attempt.quality };
    if (blob.size <= maxBytes) return { ...result, withinLimit: true, tries };
    if (!best || blob.size < best.blob.size) best = result;
  }
  return { ...best, withinLimit: false, tries };
}

/**
 * 大きな画像を一気に縮めると、iPhone の Safari は間引きで文字がかすれやすいため、半分ずつ縮める中間の大きさを返す
 * （目標より小さくならない間だけ半分にする）。例：4032×3024 → 目標 1280×960 なら [2016×1512]。目標以下なら []。
 * @returns {{width: number, height: number}[]}
 */
export function halvingSteps(srcW, srcH, dstW, dstH) {
  const steps = [];
  let w = srcW;
  let h = srcH;
  while (w / 2 >= dstW && h / 2 >= dstH) {
    w = Math.round(w / 2);
    h = Math.round(h / 2);
    steps.push({ width: w, height: h });
  }
  return steps;
}

/* ---------------------------------------------------------
   純粋な関数②：枚数・imageIds・孤立画像（architecture 11.1・11.4・11.6）
   --------------------------------------------------------- */

/** あと何枚追加できるか（0 未満にはしない） */
export function remainingSlots(currentCount, max = MAX_IMAGES_PER_TRADE) {
  return Math.max(0, max - Math.max(0, currentCount));
}

/**
 * 画像をまとめて選んだときの扱い（architecture 11.1 ①）：先頭から残り枚数分だけ追加し、超えた分は追加しない。
 * @param {number} currentCount 今の枚数（処理中のものも数える）
 * @param {number} pickedCount 選んだ枚数
 * @returns {{accept: number, rejected: number, remaining: number}} accept＝追加する枚数／rejected＝追加しない枚数
 */
export function planAddition(currentCount, pickedCount, max = MAX_IMAGES_PER_TRADE) {
  const remaining = remainingSlots(currentCount, max);
  const accept = Math.min(remaining, Math.max(0, pickedCount));
  return { accept, rejected: Math.max(0, pickedCount) - accept, remaining };
}

/** 文字列の ID だけを、重複を除いて元の順に取り出す（壊れた配列で画面が止まらないように） */
function cleanIds(ids) {
  return Array.isArray(ids) ? [...new Set(ids.filter((x) => typeof x === 'string' && x !== ''))] : [];
}

/**
 * 編集の保存で、記録に残す imageIds を組み立てる：
 *   もとの imageIds から「外した画像」を除き、「追加した画像」を後ろに足す（表示の順番は imageIds が正：architecture 6.4）。
 * 重複は除く。もとにない ID を「外した」と渡されても無視する。
 * @param {string[]} baseIds 保存されている（最新の）記録の imageIds
 * @param {string[]} addedIds この編集で追加した画像の ID
 * @param {string[]} removedIds この編集で外した画像の ID
 * @returns {string[]}
 */
export function buildImageIds(baseIds, addedIds = [], removedIds = []) {
  const removed = new Set(cleanIds(removedIds));
  const kept = cleanIds(baseIds).filter((id) => !removed.has(id));
  return cleanIds([...kept, ...cleanIds(addedIds).filter((id) => !removed.has(id))]);
}

/**
 * 決済の保存で、保存されている imageIds の後ろに追加した画像を足す（決済では画像を外さない）。
 * 画面が持っている古い写しではなく、保存されている最新の imageIds に足すため、別の画面での画像の変更を失わない。
 */
export function mergeImageIds(storedIds, addedIds = []) {
  return buildImageIds(storedIds, addedIds, []);
}

/**
 * 孤立画像（どの記録の imageIds にも、どの下書きの addedImageIds にも含まれず、作成から minAgeMinutes 分以上たった画像）の ID を返す
 * （architecture 11.6）。
 * ・削除済み（論理削除）の記録の画像も「使われている」とみなす（削除の取り消しで画像も戻すため：architecture 10章）
 * ・作成日時が読めない・未来の日時の画像は、消さずに残す（データを失う方向の間違いを避ける）
 * ・外した画像（removedImageIds）は、記録の imageIds に残っているので、保存するまでは消えない
 * @param {{images: {id: string, createdAt: string}[], trades: {imageIds?: string[]}[], drafts: {addedImageIds?: string[]}[],
 *   now?: (Date|string), minAgeMinutes?: number}} input
 * @returns {string[]}
 */
export function findOrphanImages({ images, trades, drafts, now = new Date(), minAgeMinutes = IMAGE_ORPHAN_MIN_AGE_MINUTES }) {
  const used = new Set();
  for (const t of trades || []) for (const id of cleanIds(t && t.imageIds)) used.add(id);
  for (const d of drafts || []) for (const id of cleanIds(d && d.addedImageIds)) used.add(id);
  const orphans = [];
  for (const img of images || []) {
    if (!img || typeof img.id !== 'string' || used.has(img.id)) continue;
    const age = diffMinutes(img.createdAt, now);
    if (age !== null && age >= minAgeMinutes) orphans.push(img.id);
  }
  return orphans;
}

/**
 * 端末の空きが少ないか（architecture 15.1「画像追加前の確認」）。navigator.storage.estimate() の結果を渡す。
 * 調べられない（値がない）ときは false（注意を出さない）。
 */
export function isLowStorage(estimate, threshold = LOW_STORAGE_BYTES) {
  if (!estimate || !Number.isFinite(estimate.quota) || !Number.isFinite(estimate.usage)) return false;
  return estimate.quota - estimate.usage < threshold;
}

/* ---------------------------------------------------------
   純粋な関数③：表示用の文言（design 14.1.9・14.2.10・14.4.1・14.4.6）
   --------------------------------------------------------- */

/** 添付したタイミングの呼び名 */
export function imageKindLabel(kind) {
  return kind === 'exit' ? '決済時' : 'エントリー時';
}

/** 画像の代替テキスト（design 14.4.6：「エントリー時の画像 1/2」）。index は 0 始まり */
export function imageAlt(kind, index, total) {
  return `${imageKindLabel(kind)}の画像 ${index + 1}/${total}`;
}

/** 詳細画面のグループ見出し（design 14.4.1：「画像（2枚）」） */
export function imageGroupHeader(count) {
  return `画像（${count}枚）`;
}

/** 入力画面の「画像を追加」の行の文字（design 14.1.9）。上限なら「画像は4枚までです」 */
export function addRowText(remaining) {
  return remaining > 0 ? `画像を追加（残り${remaining}枚）` : IMAGE_TEXT.limitReached;
}

/** 拡大表示の上部の「1 / 2」（index は 0 始まり） */
export function viewerCounter(index, total) {
  return `${index + 1} / ${total}`;
}

/**
 * 先頭の数バイトを見て、画像ファイルの形（JPEG・PNG・WebP・GIF）をしているか。
 * 保存した Blob が壊れて 0 で埋まっていたり別物になっていたりするのを、表示する前に見つけるための簡単な確認。
 * @param {Uint8Array} bytes
 */
export function looksLikeImage(bytes) {
  if (!bytes || bytes.length < 4) return false;
  const [a, b, c, d] = bytes;
  if (a === 0xff && b === 0xd8 && c === 0xff) return true;                              // JPEG
  if (a === 0x89 && b === 0x50 && c === 0x4e && d === 0x47) return true;                // PNG
  if (a === 0x47 && b === 0x49 && c === 0x46 && d === 0x38) return true;                // GIF
  if (a === 0x52 && b === 0x49 && c === 0x46 && d === 0x46 && bytes.length >= 12) {     // WebP（RIFF....WEBP）
    return bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }
  return false;
}

/* ---------------------------------------------------------
   表示用 URL の発行と解放（architecture 11.3）
   --------------------------------------------------------- */

/**
 * 表示用 URL（Blob URL）の入れ物を作る。画面ごとに1つ作り、画面を離れるとき（unmount）に revokeAll() を呼ぶ。
 * 解放し忘れると、画像のデータがメモリに残り続ける（特に iPhone で、長く使うほど重くなる）ため、
 * 発行した URL はすべてここで覚えておき、まとめて解放できるようにする。
 * @param {{create?: (blob: Blob) => string, revoke?: (url: string) => void}} [fns] テストで差し替える
 */
export function createUrlPool({ create = (b) => URL.createObjectURL(b), revoke = (u) => URL.revokeObjectURL(u) } = {}) {
  const urls = new Set();
  return {
    /** Blob から表示用 URL を発行する（<img> の src に入れる） */
    urlOf(blob) {
      const url = create(blob);
      urls.add(url);
      return url;
    },
    /** 1つだけ解放する（画像を外したとき） */
    revoke(url) {
      if (!urls.delete(url)) return;
      revoke(url);
    },
    /** 発行したものをすべて解放する */
    revokeAll() {
      for (const url of urls) revoke(url);
      urls.clear();
    },
    /** 今、解放されていない URL の数（確認用） */
    size: () => urls.size,
  };
}

/* ---------------------------------------------------------
   画像ファイルの読み込み・縮小・JPEG 圧縮（architecture 11.1・11.2。ブラウザ専用）
   --------------------------------------------------------- */

function decodeError(cause) {
  return new AppError('IMAGE_DECODE', IMAGE_TEXT.decodeError, { cause });
}

/**
 * 画像ファイルを読み込む。<img> で読み、読めなければ createImageBitmap で読み直す。
 * どちらも写真の向き（EXIF）を自動で直した状態で返る（iPhone の縦向きの写真が横向きにならないように：architecture 11.2）。
 * @param {Blob} file
 * @returns {Promise<{source: CanvasImageSource, width: number, height: number, release: () => void}>}
 */
async function decodeFile(file) {
  if (!(file instanceof Blob) || file.size === 0) throw decodeError(new Error('空のファイル'));
  // 画像以外（PDF など）が選ばれたとき。種類が空（一部の端末の HEIC など）のときは読めるか試す
  if (file.type && !file.type.startsWith('image/')) throw decodeError(new Error(`画像ではない形式：${file.type}`));

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) throw new Error('画像の大きさが読み取れません');
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release() {
        img.removeAttribute('src');
        URL.revokeObjectURL(url);
      },
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    if (typeof createImageBitmap !== 'function') throw decodeError(e);
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => { if (bitmap.close) bitmap.close(); } };
    } catch (e2) {
      throw decodeError(e2);
    }
  }
}

/** キャンバスを作り、白で塗ってから画像を描く（透明な PNG が JPEG で黒くならないように：architecture 11.1 ④） */
function drawOnto(canvas, source, width, height) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw decodeError(new Error('キャンバスを作れません'));
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
}

/** 元の画像を width×height に縮めて target に描く。縮小率が大きいときは半分ずつ縮める（halvingSteps） */
function drawScaled(target, decoded, width, height) {
  const temps = [];
  let source = decoded.source;
  for (const step of halvingSteps(decoded.width, decoded.height, width, height)) {
    const tmp = document.createElement('canvas');
    drawOnto(tmp, source, step.width, step.height);
    temps.push(tmp);
    source = tmp;
  }
  drawOnto(target, source, width, height);
  // 使い終わったキャンバスは大きさを 0 にして手放す（iPhone のメモリ制限対策：architecture 11.1 ⑦）
  for (const tmp of temps) { tmp.width = 0; tmp.height = 0; }
}

/** キャンバスを JPEG の Blob にする。作れなかったら null */
function canvasToJpeg(canvas, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
    } catch (e) {
      console.error('JPEG に変換できませんでした', e);
      resolve(null);
    }
  });
}

/**
 * 選んだ画像ファイルを、保存できる形（長辺 1280px 以内の JPEG・250KB 前後）にする（architecture 11.1）。
 * 1枚ずつ呼ぶこと（同時に何枚も処理すると、メモリ不足でページが落ちることがあるため）。
 * 失敗は AppError IMAGE_DECODE（画像として読めない）。
 * @param {Blob} file
 * @returns {Promise<{blob: Blob, width: number, height: number}>}
 */
export async function prepareImage(file) {
  const decoded = await decodeFile(file);
  const canvas = document.createElement('canvas');
  try {
    let drawnSize = '';
    const encode = async (attempt) => {
      const size = `${attempt.width}x${attempt.height}`;
      if (size !== drawnSize) {
        drawScaled(canvas, decoded, attempt.width, attempt.height);
        drawnSize = size;
      }
      return canvasToJpeg(canvas, attempt.quality);
    };
    const result = await encodeWithinLimit(planEncodeAttempts(decoded.width, decoded.height), encode);
    return { blob: result.blob, width: result.width, height: result.height };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    decoded.release();
  }
}

/**
 * 端末の空きが少ないか調べる（調べられない環境では false）。画像の追加の前に呼び、少なければ注意を出す。
 * 注意を出すだけで、追加は止めない（見積りは目安で、実際には入ることもあるため）。
 */
export async function checkLowStorage() {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.estimate !== 'function') return false;
    return isLowStorage(await navigator.storage.estimate());
  } catch (e) {
    return false;
  }
}

/**
 * 保存されていた Blob がちゃんと読み出せる画像か確かめる。
 * Blob でない・空・先頭が画像の形でない・読み出しで失敗する、のどれかなら false。
 * iPhone で Blob の保存が不安定な場合に、1枚の不具合で記録全体の表示を壊さないための保険（architecture 17章 #11）。
 * @param {unknown} blob
 * @returns {Promise<boolean>}
 */
export async function inspectBlob(blob) {
  try {
    if (typeof Blob === 'undefined' || !(blob instanceof Blob) || blob.size < 4) return false;
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    return looksLikeImage(head);
  } catch (e) {
    console.error('画像データを読み出せませんでした', e);
    return false;
  }
}

/* ---------------------------------------------------------
   保存の窓口
   --------------------------------------------------------- */

/** 幅・高さとして使える数か（縮小後のピクセル数なので正の整数） */
const isPixelSize = (n) => Number.isInteger(n) && n > 0;

/**
 * 保存前の形の確認。どれもプログラムの誤り（画面の入力ミスではない）なので TypeError で止める。
 * 特に blob は、Blob 以外（文字列や undefined）を保存すると「画像が表示できない記録」が残ってしまう。
 */
function assertImage(image) {
  assertKnownKeys(image, IMAGE_KEYS, 'images');
  if (typeof image.tradeId !== 'string' || image.tradeId === '') throw new TypeError('images：tradeId は空でない文字列で渡してください');
  if (!IMAGE_KINDS.includes(image.kind)) throw new TypeError("images：kind は 'entry' か 'exit' で渡してください");
  if (typeof Blob === 'undefined' || !(image.blob instanceof Blob)) throw new TypeError('images：blob は Blob で渡してください');
  if (!isPixelSize(image.width) || !isPixelSize(image.height)) throw new TypeError('images：width・height は正の整数で渡してください');
}

/**
 * 画像の業務処理のまとまりを作る（テストでは別名の DB・決まった時刻で作る。trades.js と同じ考え方）。
 * @param {object} [options]
 * @param {object} [options.db]
 * @param {() => string} [options.now]
 * @param {() => string} [options.makeId]
 */
export function createImageService({ db = appDb, now = nowJst, makeId = newId } = {}) {
  return {
    /**
     * 画像を保存する。id（なければ採番）・createdAt ＝今 を付けて images に追加する。
     * 同じ id があれば AppError DUPLICATE。容量不足は QUOTA / DB_WRITE（呼び出し側でアラート：15.1）。
     * @param {{id?: string, tradeId: string, kind: 'entry'|'exit', blob: Blob, width: number, height: number}} image
     * @returns {Promise<object>} 保存した画像（requirements 6.2 の7項目）
     */
    async saveImage(image) {
      assertImage(image);
      const record = {
        id: image.id != null ? image.id : makeId(),
        tradeId: image.tradeId,
        kind: image.kind,
        blob: image.blob,
        width: image.width,
        height: image.height,
        createdAt: now(),
      };
      await db.addImage(record);
      return record;
    },

    /** 1枚取得。見つからなければ null */
    getImage: (id) => db.getImage(id),

    /** あるトレードの画像をまとめて取得（表示の順番はトレードの imageIds が正：architecture 6.4） */
    getImagesByTrade: (tradeId) => db.getImagesByTrade(tradeId),

    /** 画像をまとめて物理削除（1つのトランザクション。ない id は無視） */
    deleteImages: (ids) => db.deleteImages(ids),

    /** 画像ファイルを縮小・JPEG 圧縮する（ブラウザ専用）。画面が差し替えられるよう、窓口にも置く */
    prepareImage,

    /** 端末の空きが少ないか（ブラウザ専用） */
    checkLowStorage,

    /**
     * 表示のために1枚読む。記録全体の表示を壊さないよう、読み出せないときも例外にせず状態で返す：
     *   'ok'      … 読み出せる（image に画像）
     *   'missing' … images にその ID がない（記録は画像を指しているが、画像が見つからない）
     *   'broken'  … 画像はあるが Blob を読み出せない（壊れている・空）／DB の読み込みに失敗した
     * 画面は 'missing'・'broken' のとき、その1枚だけ「読み込めません」と表示する（architecture 17章 #11）。
     * @param {string} id
     * @returns {Promise<{status: 'ok'|'missing'|'broken', id: string, image: (object|null)}>}
     */
    async loadImage(id) {
      let image = null;
      try {
        image = await db.getImage(id);
      } catch (e) {
        console.error('画像を読み込めませんでした', e);
        return { status: 'broken', id, image: null };
      }
      if (!image) return { status: 'missing', id, image: null };
      return { status: (await inspectBlob(image.blob)) ? 'ok' : 'broken', id, image };
    },

    /**
     * 孤立画像を削除する（architecture 11.6）。起動のたびに、画面の表示が終わったあとで呼ぶ。
     * 判定（findOrphanImages）も削除も、1つのトランザクションの中で行う（判定したあとに別の画面が画像を使い始めても、
     * 取り違えて消さないため）。画像の中身（Blob）は持ち続けず、IDと作成日時だけを見る。
     * @param {{now?: (Date|string), minAgeMinutes?: number}} [opts]
     * @returns {Promise<string[]>} 削除した画像の ID
     */
    async sweepOrphans({ now: nowDate = new Date(), minAgeMinutes = IMAGE_ORPHAN_MIN_AGE_MINUTES } = {}) {
      let removed = [];
      await db.runTx([STORE.IMAGES, STORE.TRADES, STORE.DRAFTS], async (ops) => {
        const metas = [];
        await ops.eachRecord(STORE.IMAGES, (img) => metas.push({ id: img.id, createdAt: img.createdAt }));
        const trades = await ops.getAll(STORE.TRADES);
        const drafts = await ops.getAll(STORE.DRAFTS);
        removed = findOrphanImages({ images: metas, trades, drafts, now: nowDate, minAgeMinutes });
        for (const id of removed) await ops.delete(STORE.IMAGES, id);
      });
      return removed;
    },
  };
}

/** アプリ本体が使う業務処理（本物の DB） */
export const imageService = createImageService();

export const {
  saveImage, getImage, getImagesByTrade, deleteImages, loadImage, sweepOrphans,
} = imageService;
