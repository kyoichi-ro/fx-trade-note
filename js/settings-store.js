/* =========================================================
   js/settings-store.js
   localStorage（設定）の読み書きの窓口（architecture.md 4.2・7章、requirements.md 6.3）。T-15 で作成。
   ※ 設定画面 js/screens/settings.js とは役割が違う別ファイル（名前の衝突を避けるため保存側に -store を付けた）。

   【約束（architecture 7.1）】
   ・キーの名前は requirements 6.3 と完全に同じ。実際に保存するときだけ先頭に「fxnote:」（config.js の LS_PREFIX）を付ける
     （同じ github.io を使う他のアプリと名前がぶつからないように）。例：theme → fxnote:theme
   ・値はすべて JSON.stringify した文字列で保存し、読むときに JSON.parse する（数値・配列・オブジェクトを同じ方法で扱うため）。
   ・読めないとき（値が壊れている・型が違う・保存されていない・localStorage そのものが使えない）は初期値を返し、画面は止めない。
   ・書けないとき（容量不足・プライベートブラウズなど）は AppError（code: SETTINGS_WRITE）を投げる。
     画面はこれを受けてアラート「設定を保存できませんでした」を出す（architecture 15.1、design 14.7.3）。
   ・トレード記録・画像・下書きはここに入れない（IndexedDB に保存する）。

   【壊れた値の修復のしかた】
   ・読むたびに中身を確かめ、使えない部分だけを初期値に置き換えて返す（例：choices の emotions だけが壊れていたら、
     entryReasons・tags は保存値のまま、emotions だけ初期値）。
   ・保存されている文字そのものは、読むときには書き換えない。正しい値を次に保存した時点で上書きされて直る。
     なぜ消さないのか：Service Worker の都合で古い版のアプリが一時的に動いたとき、新しい版が保存した
     「古い版には読めない形」の値を、古い版が壊れた値とみなして消してしまう事故を防ぐため。

   【使い始めるタスク】全キーの窓口（初期値・確認・読み書き）はここで用意し、各キーは使うタスクで使い始める
   （T-15：lotUnitSize.*・theme、T-16：favoritePairs・choices（根拠・感情・タグの初期値は T-16 で master.js へ移した）、T-17：lastInput、T-23：listFilter、
     T-25：lastExportAt、T-40：gasUrl・syncToken、T-41：syncLastError）。
   ・T-40：gasUrl・syncToken は「秘密の設定」（secret）。読めないときの警告・保存できない値のエラー文にも中身を出さない。

   ・層は「保存の窓口」（architecture 4.3）。画面の部品は import しない。
   ========================================================= */
import { LS_PREFIX, CHOICE_NAME_MAX_LENGTH } from './config.js';
import { DEFAULT_FAVORITE_PAIRS, DEFAULT_CHOICES } from './master.js';
import { AppError, countChars } from './util.js';

/** テーマの選択肢（requirements 6.3：auto＝端末に合わせる / light / dark） */
export const THEMES = Object.freeze(['auto', 'light', 'dark']);

/* ---------------------------------------------------------
   値の確かめ方（壊れた値を見分ける）
   どれも「正しければ使える値を返し、だめなら undefined を返す」形にそろえる。
   undefined のときは初期値を使う。
   --------------------------------------------------------- */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
/** 日本時間の固定形式（architecture 6.6）：YYYY-MM-DDTHH:mm:ss+09:00 */
const JST_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/;
/** 通貨ペアの形（fx-rules 10.4 の正規化後の形：英大文字3文字/英大文字3文字） */
const PAIR_FORMAT = /^[A-Z]{3}\/[A-Z]{3}$/;

/** 1lotの通貨数：1以上の整数（fx-rules 8.1 の E-07 と同じ条件） */
function checkLotUnitSize(v) {
  return Number.isSafeInteger(v) && v >= 1 ? v : undefined;
}

/**
 * 文字の配列：文字でないもの・空白だけのもの・長すぎるもの（文字数は countChars＝人が数えるとおり）・重複を取り除く
 * （壊れた1つのために全部を捨てない）
 */
function cleanStringList(v, { maxLength = Infinity, pattern = null } = {}) {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set();
  const out = [];
  for (const x of v) {
    if (!isNonEmptyString(x) || countChars(x) > maxLength || (pattern && !pattern.test(x)) || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/** よく使う通貨ペア：1つ以上必要（最後の1つは削除できない：design 14.6.3）。0個になったら初期値 */
function checkFavoritePairs(v) {
  const list = cleanStringList(v, { pattern: PAIR_FORMAT });
  return list && list.length > 0 ? list : undefined;
}

/** 選択肢：3種類それぞれを確かめ、壊れた種類だけ初期値にする（0件は正しい状態：design 14.6.3） */
function checkChoices(v) {
  if (!isPlainObject(v)) return undefined;
  const out = {};
  for (const kind of Object.keys(DEFAULT_CHOICES)) {
    out[kind] = cleanStringList(v[kind], { maxLength: CHOICE_NAME_MAX_LENGTH }) ?? [...DEFAULT_CHOICES[kind]];
  }
  return out;
}

/** 前回入力値（architecture 7.2）：{ accountType, pair, lots: { demo, real } }。使えない項目だけ null にする */
function checkLastInput(v) {
  if (!isPlainObject(v)) return undefined;
  const lots = isPlainObject(v.lots) ? v.lots : {};
  const lot = (x) => (isNonEmptyString(x) ? x : null); // ロットは入力した文字のまま保存する約束
  return {
    accountType: v.accountType === 'demo' || v.accountType === 'real' ? v.accountType : null,
    pair: typeof v.pair === 'string' && PAIR_FORMAT.test(v.pair) ? v.pair : null,
    lots: { demo: lot(lots.demo), real: lot(lots.real) },
  };
}

/** 一覧の絞り込み条件（architecture 7.2）：形だけ確かめる。filter の中身の確認（壊れた項目だけ初期値）と30分の期限の判定は、画面側が js/filter.js の restoreFilter で行う（T-23） */
function checkListFilter(v) {
  if (!isPlainObject(v) || v.version !== 1 || typeof v.savedAt !== 'string' || !JST_FORMAT.test(v.savedAt)
    || !isPlainObject(v.filter)) return undefined;
  return v;
}

/** 同期の最後のエラーの種類（js/sync-sender.js の SYNC_ERROR_KINDS と同じ） */
const SYNC_ERROR_KINDS = ['offline', 'timeout', 'unreachable', 'notApp', 'badResponse', 'badToken', 'scriptError', 'rejected'];
/** Apps Script のエラーコード・受け付けない理由（英大文字・数字・_ だけ。応答の変な文字をそのまま残さない） */
const SAFE_CODE = /^[A-Z0-9_]{1,40}$/;

/**
 * 同期の最後のエラー（T-41。roadmap 7.20 #1・sheets-setup 9.1 の A）：
 * { at, kind, code, reason, count, ids }。URL・合言葉は入れない（画面の写真を人に見せても漏れないように）。
 * ids は受け付けられなかった記録の id（最大10件・64文字まで）、count はその件数（kind が rejected のとき）。形が違えば初期値（null）
 */
function checkSyncLastError(v) {
  if (!isPlainObject(v) || typeof v.at !== 'string' || !JST_FORMAT.test(v.at) || !SYNC_ERROR_KINDS.includes(v.kind)) return undefined;
  const code = (x) => (x === null || (typeof x === 'string' && SAFE_CODE.test(x)));
  if (!code(v.code) || !code(v.reason)) return undefined;
  if (!Number.isSafeInteger(v.count) || v.count < 0) return undefined;
  if (!Array.isArray(v.ids) || v.ids.length > 10 || v.ids.some((x) => typeof x !== 'string' || x === '' || x.length > 64)) return undefined;
  return { at: v.at, kind: v.kind, code: v.code, reason: v.reason, count: v.count, ids: [...v.ids] };
}

/** 「なし（null）」が初期値の項目用：null か、check を通った値 */
const orNull = (check) => (v) => (v === null ? null : check(v));

/**
 * requirements 6.3 の全キーの定義（並び順も 6.3 の表のとおり）。
 * default：初期値（毎回新しいコピーを返すので、受け取った側が書き換えても初期値は変わらない）
 * check  ：保存値の確かめ方（読むときと書くときの両方に使う）
 */
const DEFINITIONS = Object.freeze({
  'lotUnitSize.demo': { default: () => 10000, check: checkLotUnitSize },
  'lotUnitSize.real': { default: () => 10000, check: checkLotUnitSize },
  favoritePairs: { default: () => [...DEFAULT_FAVORITE_PAIRS], check: checkFavoritePairs },
  lastInput: { default: () => null, check: orNull(checkLastInput) },
  listFilter: { default: () => null, check: orNull(checkListFilter) },
  choices: {
    default: () => ({ entryReasons: [...DEFAULT_CHOICES.entryReasons], emotions: [...DEFAULT_CHOICES.emotions], tags: [...DEFAULT_CHOICES.tags] }),
    check: checkChoices,
  },
  theme: { default: () => 'auto', check: (v) => (THEMES.includes(v) ? v : undefined) },
  lastExportAt: { default: () => null, check: orNull((v) => (typeof v === 'string' && JST_FORMAT.test(v) ? v : undefined)) },
  // secret：Apps Script の URL・合言葉。壊れた値の警告や保存できない値のエラー文にも中身を出さない（design 14.6.8・T-40）
  gasUrl: { default: () => null, check: orNull((v) => (isNonEmptyString(v) ? v : undefined)), secret: true },
  syncToken: { default: () => null, check: orNull((v) => (isNonEmptyString(v) ? v : undefined)), secret: true },
  // T-41：同期の最後のエラー（roadmap 7.20 #1。requirements 6.3 への追記は pm に申し送り）。次に送信が成功したら null に戻す
  syncLastError: { default: () => null, check: orNull(checkSyncLastError) },
});

/** 警告・エラー文に出す値。秘密の設定（URL・合言葉）は中身の代わりに決まった文字を出す（T-40） */
function shown(def, v) {
  return def.secret ? '（秘密の値のため表示しません）' : v;
}

/** requirements 6.3 のキー名の一覧（接頭辞なし） */
export const SETTING_KEYS = Object.freeze(Object.keys(DEFINITIONS));

/** 定義にないキー（打ち間違い）はプログラムの誤りなので、利用者向けの AppError ではなく TypeError で止める */
function definitionOf(key) {
  const def = DEFINITIONS[key];
  if (!def) throw new TypeError(`settings-store：requirements.md 6.3 にないキーです（${key}）`);
  return def;
}

/** 受け取った側が書き換えても保存値・初期値に影響しないよう、配列・オブジェクトはコピーして渡す */
function copy(v) {
  return v !== null && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
}

/** localStorage を取り出す。Safari でサイトデータを禁止しているときなどは、触っただけで例外になるので null にする */
function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch (e) {
    return null;
  }
}

/**
 * 設定の窓口を作る。アプリ本体は下の settingsStore（本物の localStorage・接頭辞 fxnote:）を使う。
 * テストでは、別の接頭辞やにせものの保存場所を渡して、本物の設定に触れずに確かめる（tests/settings-store.test.js）。
 * @param {{ storage?: (Storage|null|(() => (Storage|null))), prefix?: string }} [opts]
 *   storage … 保存場所。関数を渡すと使うたびに取り出す（既定：localStorage。使えない環境では null）
 *   prefix  … 実際のキーの先頭に付ける文字（既定：config.js の LS_PREFIX＝'fxnote:'）
 */
export function createSettingsStore({ storage = defaultStorage, prefix = LS_PREFIX } = {}) {
  const getStorage = typeof storage === 'function' ? storage : () => storage;

  /** 実際の保存キー（例 'theme' → 'fxnote:theme'） */
  const storageKey = (key) => {
    definitionOf(key);
    return `${prefix}${key}`;
  };

  /** 初期値（新しいコピー） */
  const getDefault = (key) => definitionOf(key).default();

  /**
   * 設定を読む。読めない・壊れている・保存されていないときは初期値（使えない部分だけ初期値）を返す。例外は投げない。
   * @param {string} key requirements 6.3 のキー名（接頭辞なし）
   */
  const get = (key) => {
    const def = definitionOf(key);
    let raw = null;
    try {
      const s = getStorage();
      raw = s ? s.getItem(`${prefix}${key}`) : null;
    } catch (e) {
      // localStorage が使えない環境（プライベートブラウズ・サイトデータの禁止など）。画面は止めずに初期値で動く
      console.warn(`設定「${key}」を読めなかったため、初期値を使います`, e);
      return def.default();
    }
    if (raw === null) return def.default();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn(`設定「${key}」の保存値が壊れているため、初期値を使います`, shown(def, raw));
      return def.default();
    }
    const checked = def.check(parsed);
    if (checked === undefined) {
      console.warn(`設定「${key}」の保存値の形が違うため、初期値を使います`, shown(def, parsed));
      return def.default();
    }
    return copy(checked);
  };

  /**
   * 設定を保存する。
   * ・値の形が違う（例：1lotの通貨数に 0 や文字）ときは保存せずに TypeError（画面側で入力チェックを済ませてから呼ぶ約束。
   *   壊れた値を保存しないための最後の守り）。
   * ・保存できない（容量不足・localStorage が使えない）ときは AppError（code: SETTINGS_WRITE）。保存値は変わらない。
   * @param {string} key
   * @param {*} value
   * @returns {*} 保存した値（確かめた後の形のコピー）
   */
  const set = (key, value) => {
    const def = definitionOf(key);
    const checked = def.check(value);
    if (checked === undefined) {
      throw new TypeError(`settings-store：「${key}」に保存できない値です（${shown(def, JSON.stringify(value))}）`);
    }
    try {
      const s = getStorage();
      if (!s) throw new Error('localStorage を使えません');
      s.setItem(`${prefix}${key}`, JSON.stringify(checked));
    } catch (e) {
      // iOS Safari は容量不足を QuotaExceededError 以外の名前で返すことがあるため、名前で見分けず
      // 「容量不足の可能性があります」と案内する（architecture 15.1）
      throw new AppError('SETTINGS_WRITE', '設定を保存できませんでした。端末の空き容量が不足している可能性があります。', { cause: e });
    }
    return copy(checked);
  };

  /**
   * 保存値を消して初期値に戻す（テストの後片付けなどに使う）。
   * 消せなかったときも SETTINGS_WRITE（保存と同じく「変えられなかった」ことを呼び出し側に知らせる）。
   */
  const reset = (key) => {
    definitionOf(key);
    try {
      const s = getStorage();
      if (s) s.removeItem(`${prefix}${key}`);
    } catch (e) {
      throw new AppError('SETTINGS_WRITE', '設定を保存できませんでした。端末の空き容量が不足している可能性があります。', { cause: e });
    }
  };

  return { get, set, reset, getDefault, storageKey, keys: SETTING_KEYS };
}

/** アプリ本体が使う窓口（本物の localStorage・接頭辞 fxnote:） */
export const settingsStore = createSettingsStore();

/** よく使う呼び方の短縮形 */
export const getSetting = (key) => settingsStore.get(key);
export const setSetting = (key, value) => settingsStore.set(key, value);
