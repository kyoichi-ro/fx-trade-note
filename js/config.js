/* =========================================================
   js/config.js
   変わり得る数値・名前を1か所に集めたファイル（architecture.md 4.2）。
   ここは「基礎」の層なので、他のファイルを import しない（architecture.md 4.3）。
   ========================================================= */

/**
 * アプリのバージョン。
 * 公開のたびに上げる（sw.js の APP_VERSION と必ず同じ値にする：architecture.md 12.3。sw.js は T-28 で作る）。
 * 開発中（公開前）は 0.x.x とし、最初の公開で 1.0.0 にする想定。
 */
export const APP_VERSION = '1.1.0';

/**
 * IndexedDB の名前とバージョン（architecture.md 6.1）。
 * 同じ github.io を共有する他のアプリとぶつからない名前にしている。
 * DB_VERSION はデータ構造（ストア・インデックス）を変えるたびに 1 ずつ上げる。APP_VERSION とは別物。
 * 実際に DB を開く処理は db.js（T-12）で作る。
 */
export const DB_NAME = 'fx-trade-note';
export const DB_VERSION = 1;

/**
 * localStorage の保存キーに付ける接頭辞（architecture.md 7.1）。
 * 例：設定「theme」は実際には "fxnote:theme" というキーで保存する。
 * ※ boot-theme.js はモジュールではないため同じ値を直接書いている。変えるときは両方を直す。
 */
export const LS_PREFIX = 'fxnote:';

/** 1トレードに添付できる画像の上限（requirements F-05） */
export const MAX_IMAGES_PER_TRADE = 4;

/**
 * 画像の縮小・圧縮の目安（architecture.md 11.1）。実際の処理は images.js（T-24）。
 * ・長辺が 1280px を超えるときだけ縮小する
 * ・JPEG の品質を 0.82 から始め、250KB を超えたら段階的に下げる。それでも超えたら長辺 1024px でやり直す
 */
export const IMAGE_MAX_EDGE = 1280;
export const IMAGE_FALLBACK_EDGE = 1024;
export const IMAGE_QUALITY_STEPS = [0.82, 0.72, 0.62, 0.5];
export const IMAGE_MAX_BYTES = 250 * 1024;

/**
 * 孤立画像の掃除（architecture.md 11.6）：どの記録にも下書きにも使われていない画像のうち、作成から
 * この分数以上たったものだけ削除する（1日）。入力中の画像を誤って消さないための安全策。
 */
export const IMAGE_ORPHAN_MIN_AGE_MINUTES = 24 * 60;

/** 端末の空きがこれ未満のとき、画像の追加時に注意を出す（バイト。architecture.md 15.1「残り10MB未満」） */
export const LOW_STORAGE_BYTES = 10 * 1024 * 1024;

/** 下書き・一覧の絞り込み条件を、開き直したときに復元する期限（分）（architecture.md 5.5・9.3、2026-10-15 決定） */
export const DRAFT_RESTORE_MINUTES = 30;
export const LIST_FILTER_RESTORE_MINUTES = 30;

/**
 * 記録を削除してからこの分数のあいだは、その記録の決済・編集の下書きを「対象が削除済み」でも消さずに残す（T-33：T-30 の R-10）。
 * 削除のトースト「取り消す」（6秒。フォーカス中は止まる）で戻したとき、入力途中の内容と画像も戻せるようにするため。
 * 過ぎたら一覧などが今までどおり黙って消す。
 */
export const DELETED_DRAFT_KEEP_MINUTES = 1;

/** 一覧で最初に描く行数と、下までスクロールするたびに足す行数（analytics 4.9 #5。重ければ T-31 の計測で調整する） */
export const LIST_PAGE_SIZE = 50;

/** 「よく使う通貨ペア」のうち、エントリー画面の格子に並べる数（3列×2段。design 14.1.2・14.6.4：設定の上から6つ） */
export const FAVORITE_GRID_COUNT = 6;

/** 選択肢（根拠・感情・タグ）の名前の上限文字数（design 14.6.3：20文字以内）。追加時のチェックと、保存値を読むときの確認の両方で使う */
export const CHOICE_NAME_MAX_LENGTH = 20;

// Chart.js の URL（バージョン完全固定）は Phase 3 の T-55 着手時に決めてここに書く（architecture.md 16.1）。
