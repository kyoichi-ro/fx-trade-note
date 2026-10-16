/* =========================================================
   js/master.js
   通貨ペアマスタと、通貨ペアごとの pip単位・価格の桁数を求める関数
   （docs/fx-rules.md 10章・10.7 の参照実装、docs/architecture.md 4.2・13.1）。

   ・ここは「基礎」の層（architecture.md 4.3）。window / document / IndexedDB を使わない純粋なコードだけを置く。
     そのため Node.js でもブラウザでも同じテスト（tests/）を実行できる。
   ・pip単位などはマスタに書かず、pair の文字列から毎回同じ規則で求める（fx-rules 10.2・10.4 手順3）。
     こうしておくと、ユーザーが追加したペア（例 USD/SEK）でもマスタのペアでも同じ計算ができ、
     設定に余計なキーを増やさずに済む。
   ・【注意】一度公開した判定ルール・pip単位は変えない（fx-rules 10.4）。
     変えると、編集時の再計算で過去の記録の pips が変わってしまうため。
   ・選択肢の表示名（時間足・決済理由など）と、根拠・感情・タグの初期値（T-16 で settings-store.js から移した）もここに置く。
   ========================================================= */

/**
 * 通貨ペアマスタ（fx-rules 10.3 の表・10.7 の参照実装と同じ内容。並び順もこのとおり）。
 * 1〜6 番目は「よく使う通貨ペア」の初期値（プリセット）。7〜19 番目は「その他」から選べる候補。
 * warnMin / warnMax は W-06（価格帯の目安による打ち間違い警告。fx-rules 10.5）に使う。null はチェックしない。
 * Object.freeze：どこかのコードがうっかり書き換えて計算結果が変わる事故を防ぐため。
 */
export const PAIR_MASTER = Object.freeze([
  { pair: 'USD/JPY', nameJa: '米ドル/円', warnMin: 50, warnMax: 300 },
  { pair: 'EUR/USD', nameJa: 'ユーロ/米ドル', warnMin: 0.5, warnMax: 2.5 },
  { pair: 'GBP/JPY', nameJa: 'ポンド/円', warnMin: 60, warnMax: 450 },
  { pair: 'EUR/JPY', nameJa: 'ユーロ/円', warnMin: 50, warnMax: 350 },
  { pair: 'AUD/JPY', nameJa: '豪ドル/円', warnMin: 30, warnMax: 200 },
  { pair: 'GBP/USD', nameJa: 'ポンド/米ドル', warnMin: 0.6, warnMax: 3 },
  { pair: 'AUD/USD', nameJa: '豪ドル/米ドル', warnMin: 0.3, warnMax: 2 },
  { pair: 'NZD/USD', nameJa: 'NZドル/米ドル', warnMin: 0.25, warnMax: 1.5 },
  { pair: 'USD/CHF', nameJa: '米ドル/スイスフラン', warnMin: 0.4, warnMax: 2 },
  { pair: 'USD/CAD', nameJa: '米ドル/カナダドル', warnMin: 0.6, warnMax: 2.2 },
  { pair: 'EUR/GBP', nameJa: 'ユーロ/ポンド', warnMin: 0.4, warnMax: 1.6 },
  { pair: 'EUR/AUD', nameJa: 'ユーロ/豪ドル', warnMin: 0.7, warnMax: 3.5 },
  { pair: 'GBP/AUD', nameJa: 'ポンド/豪ドル', warnMin: 0.9, warnMax: 4 },
  { pair: 'NZD/JPY', nameJa: 'NZドル/円', warnMin: 25, warnMax: 180 },
  { pair: 'CAD/JPY', nameJa: 'カナダドル/円', warnMin: 35, warnMax: 220 },
  { pair: 'CHF/JPY', nameJa: 'スイスフラン/円', warnMin: 40, warnMax: 400 },
  { pair: 'ZAR/JPY', nameJa: '南アフリカランド/円', warnMin: 2, warnMax: 30 },
  { pair: 'MXN/JPY', nameJa: 'メキシコペソ/円', warnMin: 2, warnMax: 25 },
  // TRY/JPY は長期的に大きく下落してきた通貨で固定の範囲を決めにくいため、価格帯チェックをしない（fx-rules 10.5）
  { pair: 'TRY/JPY', nameJa: 'トルコリラ/円', warnMin: null, warnMax: null },
].map((p) => Object.freeze(p)));

/**
 * 「よく使う通貨ペア」（設定 favoritePairs）の初期値＝マスタの先頭6ペア（fx-rules 10.3、requirements 6.3）。
 * 高金利通貨（ZAR/JPY・MXN/JPY・TRY/JPY）は、オーナーが取引しないため含めない（fx-rules 14章 #7）。
 */
export const DEFAULT_FAVORITE_PAIRS = Object.freeze(PAIR_MASTER.slice(0, 6).map((p) => p.pair));

/* ---------------------------------------------------------
   選択肢の編集（T-16。design 14.6.3・14.6.4）
   --------------------------------------------------------- */

/** 選択肢の編集画面の種類（URL #/settings/choices/{kind}：architecture 5.1。router.js もここを見る） */
export const CHOICE_KINDS = Object.freeze(['pairs', 'entryReasons', 'emotions', 'tags']);

/** 種類ごとの画面名（設定画面の行の名前と同じ：design 14.6.3） */
export const CHOICE_KIND_LABELS = Object.freeze({
  pairs: 'よく使う通貨ペア',
  entryReasons: 'エントリー根拠',
  emotions: '感情',
  tags: 'タグ',
});

/**
 * 根拠・感情・タグの選択肢の初期値（requirements 6.3・10章 Q-10・Q-11、6.1 の例。architecture 7.1：初期値は master.js に置く）。
 * T-15 では settings-store.js に仮置きしていたものを、T-16 でここへ移した（settings-store.js はここから読む）。
 * タグの初期値は requirements 6.1 の例（ルール違反・指標前・様子見すべきだった）の3つ（design 14.6.1 の図の「タグ 3」と同じ数）。
 * Object.freeze：初期値を、どこかのコードがうっかり書き換えてしまう事故を防ぐため（使うときは必ずコピーを作る）。
 */
export const DEFAULT_CHOICES = Object.freeze({
  entryReasons: Object.freeze(['トレンドフォロー', '押し目買い・戻り売り', 'ブレイクアウト', 'レンジ逆張り', '経済指標・ニュース', 'その他']),
  emotions: Object.freeze(['冷静', '自信', '不安', '焦り', '興奮', '取り返したい', '退屈']),
  tags: Object.freeze(['ルール違反', '指標前', '様子見すべきだった']),
});

/* ---------------------------------------------------------
   選択肢の保存値 → 画面に出す日本語名（T-20 で詳細画面のために追加。design 14.1.5・14.2.6・14.4.4）
   保存値（M15・newyork など）は変えず、表示だけここで日本語にする。T-16・T-18 の入力画面も同じ表を使う予定。
   詳細画面ではセッションを略さない（入力画面のセグメントでは幅の都合で「NY」と略す：design 14.1.5）。
   --------------------------------------------------------- */

export const SESSION_LABELS = Object.freeze({ tokyo: '東京', london: 'ロンドン', newyork: 'ニューヨーク', other: 'その他' });

export const TIMEFRAME_LABELS = Object.freeze({
  M1: '1分', M5: '5分', M15: '15分', M30: '30分', H1: '1時間', H4: '4時間', D1: '日足', W1: '週足',
});

export const EXIT_REASON_LABELS = Object.freeze({
  tp: 'TP到達', sl: 'SL到達', manual: '裁量決済', breakeven: '建値決済', other: 'その他',
});

/** 損益の算出方法（profitSource）。手入力は「業者の確定値で上書きした」ことが分かる言い方にする（design 14.4.4） */
export const PROFIT_SOURCE_LABELS = Object.freeze({ auto: '自動計算', manual: '手入力（業者の確定値）' });

/**
 * 判定ルールと異なる pip単位を使うペアの例外表（現時点では空。fx-rules 10.4・10.7）。
 * 例：{ 'USD/XXX': { pipSize: 0.01, priceDecimals: 3, maxInputDecimals: 3, pointScale: 1000 } }
 */
export const PIP_EXCEPTIONS = Object.freeze({});

/** pip単位の慣習を確認済みの通貨（通貨ペア追加時の警告 W-07 の判定に使う。fx-rules 10.4） */
export const KNOWN_CURRENCIES = Object.freeze(['JPY', 'USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF', 'ZAR',
  'MXN', 'TRY', 'CNH', 'HKD', 'SGD', 'SEK', 'NOK', 'DKK', 'PLN']);

/** FX以外（貴金属・暗号資産）のコード（エラー E-13。Q-05：FX通貨ペアのみ記録する） */
export const NON_FX_CODES = Object.freeze(['XAU', 'XAG', 'XPT', 'XPD', 'BTC', 'ETH']);

/**
 * 判定ルール（fx-rules 10.4 手順3）で pip単位・桁数を求める。
 * 決済通貨（右側）が JPY なら 1pip = 0.01（価格は小数第3位まで）、それ以外は 1pip = 0.0001（第5位まで）。
 * pointScale（価格→ポイント（0.1pip）の倍率）は 10 ^ priceDecimals。1pip = 10ポイントになるので、
 * どのペアでも pips = 値幅ポイント ÷ 10 で求まる（fx-rules 10.2）。
 * @param {string} pair 'USD/JPY' の形（正規化済み）
 */
export function derivePairSpec(pair) {
  const [base, quote] = pair.split('/');
  const isJpyPair = quote === 'JPY';
  const priceDecimals = isJpyPair ? 3 : 5;
  return {
    pair, base, quote, isJpyPair,
    pipSize: isJpyPair ? 0.01 : 0.0001,
    priceDecimals,
    maxInputDecimals: priceDecimals,
    pointScale: 10 ** priceDecimals,
    // 非JPYペアの損益を円にするときに入力する「決済通貨/JPY」のレート（fx-rules 4.3）
    quoteToJpyPair: isJpyPair ? null : `${quote}/JPY`,
  };
}

/**
 * 通貨ペアの仕様を返す（fx-rules 10.7 の参照実装と同じ結果）。
 * 優先順：例外表 PIP_EXCEPTIONS → 判定ルール。マスタからは日本語名と価格帯（W-06 用）だけを取る。
 * マスタにないペア（ユーザーが追加したペア）は、日本語名＝pair、価格帯チェックなし（null）。
 * @param {string} pair 'USD/JPY' の形（正規化済み）
 * @returns {{pair:string, base:string, quote:string, isJpyPair:boolean, pipSize:number, priceDecimals:number,
 *   maxInputDecimals:number, pointScale:number, quoteToJpyPair:(string|null), nameJa:string,
 *   warnMin:(number|null), warnMax:(number|null), inMaster:boolean}}
 */
export function getPairSpec(pair) {
  const m = PAIR_MASTER.find((p) => p.pair === pair);
  return {
    ...derivePairSpec(pair),
    ...(PIP_EXCEPTIONS[pair] || {}),
    nameJa: m ? m.nameJa : pair,
    warnMin: m ? m.warnMin : null,
    warnMax: m ? m.warnMax : null,
    inMaster: Boolean(m),
  };
}
