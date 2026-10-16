/* =========================================================
   js/images.js
   チャート画像の業務処理（architecture.md 4.2・11章）。

   【T-12 の段階：保存の土台だけ】
   ・画像の保存（id・createdAt を付ける）・1枚取得・トレード単位の取得・物理削除。
   ・画像は大きく、シートにも同期しないため、削除は論理削除ではなく実際に消す（物理削除：architecture 11.4・20章 ⑤）。
   T-24 で、画像の読み込み・縮小・JPEG 圧縮（11.1）、表示用 URL の発行と解放（11.3）、
   孤立画像の掃除（11.6）、1トレード4枚までの確認をこのファイルに足す。

   依存（architecture 4.2）：db, datetime, util（config は T-24 の縮小処理で使う）
   ========================================================= */
import { appDb, IMAGE_KEYS } from './db.js';
import { nowJst } from './datetime.js';
import { newId, assertKnownKeys } from './util.js';

/** 添付タイミング（requirements 6.2 kind） */
const IMAGE_KINDS = Object.freeze(['entry', 'exit']);

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
  };
}

/** アプリ本体が使う業務処理（本物の DB） */
export const imageService = createImageService();

export const { saveImage, getImage, getImagesByTrade, deleteImages } = imageService;
