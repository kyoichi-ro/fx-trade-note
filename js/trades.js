/* =========================================================
   js/trades.js
   トレード記録の業務処理（architecture.md 4.2・8章・10章）。画面はトレード記録の保存をこのファイルに頼む。

   【T-12：保存の土台】
   ・保存のたびに必ず付ける値（id・createdAt・updatedAt・syncStatus など）を、ここ1か所で付ける。
     画面ごとに付け忘れたり形がばらついたりしないようにするため（architecture 4.3「画面は db.js を直接呼ばない」）。
   ・論理削除（deletedAt）と削除の取り消し（architecture 10章）。
     db.js は「業務のルールを持たない」約束なので、論理削除はここに置く（architecture 6.10）。
   ・記録の保存と下書きの削除を1回のトランザクションで行う（architecture 8章）。
   【T-17：記録の組み立てと再計算】
   ・recompute()：自動で決まる値（status・riskReward・session）を1か所で計算し直す（architecture 8章「再計算の場所は1か所」）。
     status は渡された値を使わず、決済情報の有無から決める（requirements 6.1。2026-10-16 オーナー決定：6.12 #4）。
   ・新規保存では lotUnitSize を「その口座区分の今の設定値」からコピーする（requirements 6.1。画面から渡された値は使わない）。
   【T-21：決済と決済の取り消し】
   ・computeClose()：決済価格から pips・損益（円）を求める（calc.js を呼ぶだけ。独自の式は書かない）。画面の即時表示と保存で同じ関数を使う。
   ・buildClosedTrade() / buildReopenedTrade()：決済した記録・決済を取り消した記録を組み立てる純粋な関数（DB に触れない。テストあり）。
   ・closeTrade() / reopenTrade()：保存されている記録を読み直してから上の関数で組み立て、saveTrade で保存する。
     画面が持っている古い写しではなく、保存されている最新の記録に決済を重ねるため（lotUnitSize も記録時の値のまま使う）。
   【T-22：編集】
   ・編集の組み立て（口座区分を変えたときの lotUnitSize の取り直し・再計算）は画面に依存しない js/edit-form.js が行い、
     ここの computeClose / buildClosedTrade を呼ぶ。保存は saveTrade（expectedUpdatedAt で別画面の変更を検出する）。
   ・削除・削除の取り消し（deleteTrade / undoDeleteTrade）は T-12 から変わらない。画面（詳細・一覧）から呼ぶだけ。

   【T-24：チャート画像】
   ・記録の保存は、画像が先に images に保存されている前提で、imageIds だけを記録に持たせる（architecture 11.5）。
     保存と同じトランザクションの中で「新しく指した画像が本当にあるか」を確かめ（IMAGE_MISSING）、
     「記録が画像を指しているのに画像が無い」状態を作らない。
   ・編集の保存では、外した画像の物理削除（deleteImageIds）を記録の保存と同じトランザクションで行う（architecture 8章・11.4）。
   ・決済では、保存されている最新の imageIds に追加した画像を足す（addImageIds）。
   ・removeTradeImage()：詳細の拡大表示からの個別削除。画像の物理削除と imageIds の更新を1つのトランザクションで行う。
   論理削除（deleteTrade）は画像を消さない（削除の取り消しで画像も戻すため：architecture 10章）。
   【T-33】
   ・saveTrade の deleteImageIds は、画像の tradeId がその記録のときだけ消す（T-30 の R-07。removeTradeImage と同じ考え方）。
   ・削除・削除の取り消しのとき、その記録の決済・編集の下書きの baseUpdatedAt を一緒に付け替える（R-10）。
     削除と取り消しは updatedAt を変えるので、そのままだと取り消したあとに下書きが「元の記録が変更された」と判定されて破棄され、
     入力途中の決済・編集が戻らないため。付け替えるのは「下書きの土台＝削除する直前の記録」のときだけ（それ以外は今までどおり古い下書き）。
   【T-44：CSV の読み込み】
   ・buildImportedTrade()：CSV から読んだ記録を保存する形にする（syncStatus は pending、上書きでも端末の画像は残す、updatedAt は CSV の値のまま）。
   ・importTrades()：1つのトランザクションでまとめて書く（全部入るか何も入らない）。確認中に記録が変わっていたら CONFLICT。

   【T-41：スプレッドシートへの送信の結果】
   ・markSyncResults()：送信の結果（syncStatus・syncedAt）だけを書き戻す。updatedAt は変えず、送ったときから記録が変わっていたら
     書き戻さない。'trades-changed' は出さない（送信のきっかけにしないため）。

   変更を保存したら events.js の 'trades-changed' で知らせる（一覧の再描画・Phase 2 の送信が受け取る：3.3）。
   通知は IndexedDB への書き込みが確定（complete）してから出す。

   依存（architecture 4.2）：db, datetime, util, events, calc, settings-store（T-24 で images、T-33 で drafts の draftKeyOf も使う）
   ========================================================= */
import { appDb, STORE, TRADE_KEYS } from './db.js';
import { nowJst } from './datetime.js';
import { newId, AppError, assertKnownKeys } from './util.js';
import { emit } from './events.js';
import { calcRiskReward, calcPips, calcProfitJpy, judgeSession } from './calc.js';
import { getPairSpec, SESSION_LABELS } from './master.js';
import { settingsStore } from './settings-store.js';
import { mergeImageIds, buildImageIds } from './images.js';
import { draftKeyOf, DRAFT_KIND } from './drafts.js';

/** 未入力のとき null ではなく空の配列にする項目（architecture 6.7） */
const ARRAY_KEYS = Object.freeze(['entryReasons', 'tags', 'imageIds']);

/** 'trades-changed' の通知名（打ち間違い防止） */
export const TRADES_CHANGED = 'trades-changed';

/**
 * 記録を「requirements 6.1 の32項目をすべて持つ形」にそろえる（architecture 6.7）。
 * ・6.1 にない項目があれば TypeError（打ち間違いを保存前に止める）
 * ・渡されなかった項目は null、配列の項目は [] にする（全記録が同じ項目を持つ。CSV・同期で列がずれない）
 * ・配列はコピーして保存する（呼び出し側があとで配列を書き換えても、保存した値に影響しないように）
 * @param {object} input
 * @returns {object} 6.1 の順番で32項目を持つ新しいオブジェクト
 */
export function normalizeTrade(input) {
  assertKnownKeys(input, TRADE_KEYS, 'trades');
  const out = {};
  for (const key of TRADE_KEYS) {
    const v = input[key];
    if (ARRAY_KEYS.includes(key)) {
      if (v == null) out[key] = [];
      else if (Array.isArray(v)) out[key] = [...v];
      else throw new TypeError(`trades：${key} は配列で渡してください`);
      // 画像 ID は空でない文字列だけ（壊れた ID を持つ記録を保存して、画像が探せなくなるのを防ぐ）
      if (key === 'imageIds' && out[key].some((id) => typeof id !== 'string' || id === '')) {
        throw new TypeError('trades：imageIds は空でない文字列の配列で渡してください');
      }
    } else {
      out[key] = v === undefined ? null : v;
    }
  }
  return out;
}

/**
 * status（保有中／決済済み）を決済情報の有無から決める（requirements 6.1「決済情報の有無で自動設定」）。
 * 決済価格と決済日時の両方があるときだけ closed。片方だけのときは open のまま
 * （決済画面は両方を必須にしているので、片方だけになるのはプログラムの誤り。pips を計算できない記録を「決済済み」にしないため）。
 * @param {object} trade
 * @returns {'open'|'closed'}
 */
export function judgeStatus(trade) {
  return trade.exitPrice != null && trade.exitAt != null ? 'closed' : 'open';
}

/**
 * 自動で決まる値を計算し直した新しい記録を返す（architecture 8章：新規・決済・編集・決済取消のどれもこの関数を通す）。
 * ・status：judgeStatus()（渡された値は使わない）
 * ・riskReward：calcRiskReward() の結果。SL・TP の両方と、通貨ペア・売買方向・エントリー価格がそろっていなければ null
 *   （calcRiskReward 自体が空の値に { rr: null, warn: [] } を返す：fx-rules 5.3。T-18 で calc.js 側へ移した）。
 *   SL/TP が売買方向と矛盾するとき（W-01）も null で、SL/TP の価格はそのまま保存する（fx-rules 5.2）
 * ・session：空（null）または知らない値のときだけ entryAt から判定（judgeSession）。画面で手で選んだ値は書き換えない
 *   （「判定ルールを変えても保存済みは再判定しない」＝保存値を正とする：fx-rules 11.7。手で選んだあと日時を変えたときの
 *   扱い〔手動を優先〕は入力画面が決めて、選んだ結果をここへ渡す：design 14.1.5 ⑩）
 * pips・損益（円）は決済の組み立て（buildClosedTrade）が求めて渡す。ここでは決済情報の有無で status を決めるだけ。
 * @param {object} trade
 * @returns {object}
 */
export function recompute(trade) {
  const out = { ...trade };
  out.status = judgeStatus(trade);
  out.riskReward = calcRiskReward(trade).rr;
  if (!Object.hasOwn(SESSION_LABELS, out.session)) out.session = judgeSession(out.entryAt);
  return out;
}

/* ---------------------------------------------------------
   決済・決済の取り消し（T-21。fx-rules 4.4・4.5、architecture 8章）
   --------------------------------------------------------- */

/**
 * 決済価格から pips と損益（円）を求める（fx-rules 3・4章。計算は calc.js に任せ、ここでは式を書かない）。
 * ・損益は手入力（manualProfitJpy）があればそれを使い（profitSource＝manual）、なければ自動計算（auto）。
 *   自動計算できないとき（非JPYペアで円換算レートなし）は損益 null・profitSource null。
 * ・lotUnitSize は記録に入っている「記録時の値」を使う（設定画面で変えても過去の記録は再計算しない：fx-rules 4.5）。
 * ・autoProfitJpy は手入力があっても自動計算値を返す（画面の「自動計算（参考）」と W-05 のため）。
 * @param {object} trade 保有中の記録（pair・side・entryPrice・lots・lotUnitSize を使う）
 * @param {{ exitPrice: (number|null), quoteToJpyRate?: (number|null), manualProfitJpy?: (number|null) }} input
 * @returns {{ pips: (number|null), autoProfitJpy: (number|null), profitJpy: (number|null), profitSource: ('auto'|'manual'|null) }}
 */
export function computeClose(trade, { exitPrice, quoteToJpyRate = null, manualProfitJpy = null }) {
  const calcInput = {
    pair: trade.pair, side: trade.side, entryPrice: trade.entryPrice, exitPrice,
    lots: trade.lots, lotUnitSize: trade.lotUnitSize, quoteToJpyRate,
  };
  const { pips } = calcPips(calcInput);
  const autoProfitJpy = calcProfitJpy(calcInput);
  if (manualProfitJpy != null) return { pips, autoProfitJpy, profitJpy: manualProfitJpy, profitSource: 'manual' };
  return { pips, autoProfitJpy, profitJpy: autoProfitJpy, profitSource: autoProfitJpy == null ? null : 'auto' };
}

/**
 * 保有中の記録に決済を重ねた記録を作る（DB に触れない）。status は渡さない（saveTrade の recompute() が決済情報の有無から決める）。
 * ・pips・損益・profitSource は computeClose() で求める。画面から渡された計算結果は受け取らない
 * ・円換算レートは非JPYペアのときだけ残す（手入力の損益があっても「記録として残す」：design 14.2.4）。JPYペアは null
 * ・決済理由・決済時の感情・メモ・タグは渡されたものに置き換える（未指定なら記録にあるものをそのまま）。空の文字は null
 * @param {object} stored 保存されている記録
 * @param {{ exitPrice: number, exitAt: string, quoteToJpyRate?: (number|null), manualProfitJpy?: (number|null),
 *   exitReason?: (string|null), exitEmotion?: (string|null), tags?: string[], memo?: (string|null), addImageIds?: string[] }} input
 * @returns {object} 32項目の記録
 */
export function buildClosedTrade(stored, input) {
  if (typeof input.exitPrice !== 'number' || !Number.isFinite(input.exitPrice) || typeof input.exitAt !== 'string' || input.exitAt === '') {
    // 決済価格と決済日時は決済画面が必ず検査してから渡す。ここに来るのはプログラムの誤り
    throw new TypeError('trades：決済には exitPrice（数値）と exitAt（日時の文字）が必要です');
  }
  const r = computeClose(stored, input);
  const orNull = (v) => (v === undefined || v === '' ? null : v);
  return {
    ...stored,
    exitPrice: input.exitPrice,
    exitAt: input.exitAt,
    quoteToJpyRate: getPairSpec(stored.pair).isJpyPair ? null : orNull(input.quoteToJpyRate),
    pips: r.pips,
    profitJpy: r.profitJpy,
    profitSource: r.profitSource,
    exitReason: input.exitReason === undefined ? stored.exitReason : orNull(input.exitReason),
    exitEmotion: input.exitEmotion === undefined ? stored.exitEmotion : orNull(input.exitEmotion),
    tags: input.tags === undefined ? stored.tags : [...input.tags],
    memo: input.memo === undefined ? stored.memo : orNull(input.memo),
    // 決済時に追加した画像は、保存されている最新の imageIds の後ろに足す（外すことはしない。別の画面での画像の変更を失わない）
    imageIds: input.addImageIds === undefined ? stored.imageIds : mergeImageIds(stored.imageIds, input.addImageIds),
  };
}

/**
 * 決済を取り消した（保有中に戻した）記録を作る（DB に触れない。fx-rules 4.5・architecture 8章）。
 * 空に戻すのは、計算に関わる exitPrice・exitAt・pips・profitJpy・profitSource・quoteToJpyRate だけ。
 * 決済理由・決済時の感情・メモ・タグ・画像（imageIds）は残す（roadmap 7.2 #19、requirements F-02）。
 * status は saveTrade の recompute() が決済情報の有無から open に戻す。
 * @param {object} stored
 * @returns {object}
 */
export function buildReopenedTrade(stored) {
  return {
    ...stored,
    exitPrice: null, exitAt: null, pips: null, profitJpy: null, profitSource: null, quoteToJpyRate: null,
  };
}

/* ---------------------------------------------------------
   CSV の読み込み（T-44。design 14.6.9・14.6.11、sheets-setup 7.2）
   --------------------------------------------------------- */

/**
 * CSV から読んだ記録（csv-import.js の rowToTrade でチェック済み）を、この端末に保存する形にする（DB に触れない）。
 * ・syncStatus は 'pending'（取り込んだ記録はシートへ送り直す対象：roadmap T-44）
 * ・新しい記録：imageIds は空（画像は CSV に無い）、syncedAt は null（この端末からはまだ送っていない）
 * ・上書き（stored あり）：この端末の imageIds を残す（CSV には画像が無く、消すと取り返せない：design 14.6.11 ②）。
 *   syncedAt も端末の値を残す（saveTrade と同じ。「この端末から最後に送れた日時」の意味を変えない）
 * ・それ以外の項目（deletedAt・createdAt・updatedAt を含む）は CSV の値のまま。削除済みの記録は削除済みのまま（14.6.11 ③）。
 *   updatedAt を CSV の値のまま残す理由（今の時刻にしない）：
 *     ① シートは「届いた updatedAt が古ければ書かない」（sheets-setup 6.1）。古いバックアップで上書きしても、シートにある
 *        新しい内容（別の端末の変更を含む）を消さない。新しい時刻にすると、古い内容でシートまで上書きしてしまう
 *     ② 上書き前と同じ版（updatedAt が同じ）なら、その記録の決済・編集の下書きはそのまま続けられ、違えば「元の記録が
 *        変更された」と判定される（下書きの照合 baseUpdatedAt：architecture 9.3）。今の時刻にすると、同じ版でも下書きを捨ててしまう
 * ・status・riskReward・session は recompute() で決める（保存のたびと同じ。session は CSV の値が正しければそのまま）
 * @param {object} row 32項目の記録（CSV から読んだもの）
 * @param {object|null} stored この端末に保存されている同じ ID の記録（なければ null）
 * @returns {object} 32項目の記録
 */
export function buildImportedTrade(row, stored) {
  return normalizeTrade(recompute({
    ...row,
    imageIds: stored ? [...(stored.imageIds || [])] : [],
    syncStatus: 'pending',
    syncedAt: stored ? stored.syncedAt ?? null : null,
  }));
}

/** 口座区分が正しいか（lotUnitSize を設定から読むキーに使うため、打ち間違いは保存前に止める） */
function assertAccountType(v) {
  if (v !== 'demo' && v !== 'real') throw new TypeError("trades：accountType は 'demo' か 'real' で渡してください");
}

/** 記録が見つからない（または削除済み）ときのエラー（architecture 15.1 NOT_FOUND） */
function notFound() {
  return new AppError('NOT_FOUND', 'この記録は見つかりません。');
}

/** 記録が指す画像が images にないときのエラー（architecture 15.1 IMAGE_MISSING。記録を保存しない） */
function imageMissing() {
  return new AppError('IMAGE_MISSING', '添付した画像が見つかりません。画像を追加し直してください。');
}

/**
 * ids の画像がすべて images にあるか確かめる（保存と同じトランザクションの中で呼ぶ）。
 * 画像が先に保存されている前提（architecture 11.5）が崩れていたら、記録を保存せずに止める。
 */
async function assertImagesExist(ops, ids) {
  for (const id of ids) {
    if (!(await ops.get(STORE.IMAGES, id))) throw imageMissing();
  }
}

/** id が使える文字列か（空文字・数値などを ID として保存しないため） */
function assertId(id) {
  if (typeof id !== 'string' || id === '') throw new TypeError('trades：id は空でない文字列で渡してください');
}

/**
 * トレード記録の業務処理のまとまりを作る。
 * アプリ本体は下の tradeService（本物の DB）を使う。テストは別名の DB と決まった時刻で作って試す
 * （本物の記録に触れず、日時の付き方を確かめるため）。
 * @param {object} [options]
 * @param {object} [options.db]     db.js の窓口（appDb か createDb() で作ったもの）
 * @param {() => string} [options.now]   今の日時（日本時間の固定形式）を返す関数
 * @param {() => string} [options.makeId] ID を作る関数
 * @param {(accountType: 'demo'|'real') => number} [options.getLotUnitSize] 口座区分ごとの1lotの通貨数（既定：設定 lotUnitSize.demo / .real）
 */
export function createTradeService({
  db = appDb, now = nowJst, makeId = newId,
  getLotUnitSize = (accountType) => settingsStore.get(`lotUnitSize.${accountType}`),
} = {}) {
  /**
   * 既存の記録を更新する（決済・編集・決済取消の保存に使う：architecture 8章）。
   * ・updatedAt ＝今、syncStatus ＝ 'pending'（保存のたびに未送信へ戻す：requirements 6.1）
   * ・status・riskReward・session は recompute() で決め直す（T-17。決済・決済取消で status が自動で切り替わる）
   * ・createdAt・deletedAt・syncedAt は保存されている値を使う（画面から渡された値で上書きしない）。
   *   削除状態を変えられるのは deleteTrade / undoDeleteTrade だけにして、うっかり削除が戻る事故を防ぐ
   * ・記録がない・削除済みなら AppError NOT_FOUND（消えた記録を put で作り直さない）
   * ・draftKey を渡すと下書きの削除も同じトランザクションで行う
   * ・expectedUpdatedAt を渡すと（編集画面：T-22）、保存されている記録の updatedAt がその値のままのときだけ保存する。
   *   違うとき（編集を始めたあとに別の画面で変更・決済・削除の取り消しなどがあった）は AppError CONFLICT で、何も保存しない。
   *   画面が古い写しを元に組み立てた記録で、新しい変更（決済した値など）を黙って上書きして失わないため。
   *   渡さなければ従来どおり（決済・決済の取り消しは保存されている最新の記録を読み直してから組み立てるので不要）
   * ・imageIds に、保存されている記録にはなかった ID が増えていたら、その画像が images にあるかを同じトランザクションで確かめ、
   *   なければ AppError IMAGE_MISSING（何も保存しない。「記録が画像を指しているのに画像が無い」状態を作らない：T-24）
   * ・deleteImageIds を渡すと（編集で外した画像：T-24）、記録の保存と同じトランザクションで画像を物理削除する
   *   （記録だけ・画像だけが片方残る状態を作らない：architecture 8章・11.4）。保存する imageIds に残っている ID は消さない。
   *   画像の tradeId がこの記録でないものも消さない（T-33：R-07）
   * 下の closeTrade / reopenTrade からも呼ぶため、メソッドではなくこの関数の中の部品として定義している
   * （tradeService の分割代入 { saveTrade, ... } で取り出しても this に頼らず動くようにするため）。
   * @param {object} trade 32項目（id 必須）
   * @param {{draftKey?: string, expectedUpdatedAt?: string, deleteImageIds?: string[]}} [opts]
   * @returns {Promise<object>} 保存した記録
   */
  async function saveTrade(trade, { draftKey, expectedUpdatedAt, deleteImageIds } = {}) {
    assertId(trade && trade.id);
    normalizeTrade(trade); // 6.1 にない項目が混ざっていないかを、DB を開く前に確かめる
    const t = now();
    let saved;
    await db.runTx([STORE.TRADES, STORE.DRAFTS, STORE.IMAGES], async (ops) => {
      const stored = await ops.get(STORE.TRADES, trade.id);
      if (!stored || stored.deletedAt != null) throw notFound();
      if (expectedUpdatedAt !== undefined && stored.updatedAt !== expectedUpdatedAt) {
        throw new AppError('CONFLICT', 'この記録は、別の画面で変更されています。');
      }
      saved = normalizeTrade(recompute({
        ...trade,
        createdAt: stored.createdAt,
        deletedAt: stored.deletedAt,
        syncedAt: stored.syncedAt,
        syncStatus: 'pending',
        updatedAt: t,
      }));
      const had = new Set(stored.imageIds || []);
      await assertImagesExist(ops, saved.imageIds.filter((id) => !had.has(id)));
      await ops.put(STORE.TRADES, saved);
      const keep = new Set(saved.imageIds);
      for (const id of deleteImageIds || []) {
        if (keep.has(id)) continue;
        // 画像の持ち主がこの記録のときだけ消す（呼び出し側の誤りや壊れた下書きで、別の記録の画像 ID が混ざっても消さない：R-07）
        const image = await ops.get(STORE.IMAGES, id);
        if (image && image.tradeId === trade.id) await ops.delete(STORE.IMAGES, id);
      }
      if (draftKey) await ops.delete(STORE.DRAFTS, draftKey);
    });
    emit(TRADES_CHANGED, { type: 'update', id: saved.id, trade: saved });
    return saved;
  }

  /**
   * その記録の決済・編集の下書きの baseUpdatedAt を、from から to に付け替える（削除・削除の取り消しと同じトランザクションの中で呼ぶ：R-10）。
   * baseUpdatedAt が from でない下書き（削除より前に記録が変わっていた古い下書き）には触らない（今までどおり 'stale' になる）。
   * @param {object} ops runTx の道具
   * @param {string} id 記録の ID
   * @param {string} from 付け替える前の updatedAt
   * @param {string} to 付け替えた後の updatedAt
   */
  async function rebaseTradeDrafts(ops, id, from, to) {
    for (const kind of [DRAFT_KIND.CLOSE, DRAFT_KIND.EDIT]) {
      const key = draftKeyOf(kind, id);
      const draft = await ops.get(STORE.DRAFTS, key);
      if (draft && draft.baseUpdatedAt != null && draft.baseUpdatedAt === from) {
        await ops.put(STORE.DRAFTS, { ...draft, baseUpdatedAt: to });
      }
    }
  }

  /** 保存されている記録を読む。ない・削除済みなら NOT_FOUND（決済・決済の取り消しの前に最新の記録を確かめる） */
  async function readLiveTrade(id) {
    assertId(id);
    const stored = await db.getTrade(id);
    if (!stored || stored.deletedAt != null) throw notFound();
    return stored;
  }

  return {
    /**
     * 新規の記録を保存する（エントリー：architecture 8章）。
     * ・id：入力画面を開いた時点で採番した ID を fields.id で渡す（画像を先に保存するため：11.5）。なければここで採番
     * ・createdAt / updatedAt ＝今、syncStatus ＝ 'pending'、syncedAt・deletedAt ＝ null を必ず付ける
     *   （呼び出し側が渡した値は使わない）
     * ・lotUnitSize は口座区分の今の設定値をコピーする（渡された値は使わない：requirements 6.1）
     * ・status・riskReward・session は recompute() で決める（status は決済情報の有無から自動）
     * ・同じ id がすでにあれば AppError DUPLICATE（二重保存の防止。画面は「保存済み」として扱う：15.1）
     * ・draftKey を渡すと、記録の保存と下書きの削除を1つのトランザクションで行う（片方だけ成功しない）
     * ・fields.imageIds の画像が images にないときは AppError IMAGE_MISSING（T-24）
     * @param {object} fields requirements 6.1 の項目（一部でよい）
     * @param {{draftKey?: string}} [opts]
     * @returns {Promise<object>} 保存した記録
     */
    async saveNewTrade(fields, { draftKey } = {}) {
      assertKnownKeys(fields, TRADE_KEYS, 'trades');
      const id = fields.id != null ? fields.id : makeId();
      assertId(id);
      assertAccountType(fields.accountType);
      const t = now();
      const trade = normalizeTrade(recompute({
        ...fields,
        id,
        lotUnitSize: getLotUnitSize(fields.accountType),
        syncStatus: 'pending', syncedAt: null, deletedAt: null, createdAt: t, updatedAt: t,
      }));
      await db.runTx([STORE.TRADES, STORE.DRAFTS, STORE.IMAGES], async (ops) => {
        // 画像は先に保存されている前提（architecture 11.5）。なければ記録を保存しない（T-24）
        await assertImagesExist(ops, trade.imageIds);
        await ops.add(STORE.TRADES, trade);
        if (draftKey) await ops.delete(STORE.DRAFTS, draftKey);
      });
      emit(TRADES_CHANGED, { type: 'add', id, trade });
      return trade;
    },

    saveTrade,

    /**
     * 保有中の記録を決済する（S-03 の保存：architecture 8章）。
     * 保存されている最新の記録を読み直し、buildClosedTrade で決済を重ねて saveTrade で保存する
     * （pips・損益・status は渡された値ではなく、ここで求める）。
     * ・記録がない・削除済みなら NOT_FOUND（saveTrade と同じ）
     * ・すでに決済済みなら AppError ALREADY_CLOSED（別の画面で先に決済された記録を、開いたままの決済画面から上書きしないため）
     * ・draftKey を渡すと下書きの削除も同じトランザクションで行う
     * @param {string} id
     * @param {object} input buildClosedTrade の input（exitPrice・exitAt など）
     * @param {{draftKey?: string}} [opts]
     * @returns {Promise<object>} 保存した記録
     */
    async closeTrade(id, input, { draftKey } = {}) {
      const stored = await readLiveTrade(id);
      if (judgeStatus(stored) === 'closed') throw new AppError('ALREADY_CLOSED', 'この記録はすでに決済されています。');
      return saveTrade(buildClosedTrade(stored, input), { draftKey });
    },

    /**
     * 決済を取り消して保有中に戻す（S-04：architecture 8章）。buildReopenedTrade で組み立てて saveTrade で保存する。
     * すでに保有中なら何も変えずにその記録を返す（2回押しても updatedAt が動かない・通知も出さない）。
     * @param {string} id
     * @returns {Promise<object>} 取り消し後の記録
     */
    async reopenTrade(id) {
      const stored = await readLiveTrade(id);
      if (judgeStatus(stored) !== 'closed') return stored;
      return saveTrade(buildReopenedTrade(stored));
    },

    /**
     * 画像を1枚、物理削除する（詳細の拡大表示の「削除」：design 14.4.6、architecture 11.4）。
     * 記録の imageIds から外す更新（updatedAt ＝今、syncStatus ＝ 'pending'）と、images からの削除を、1つのトランザクションで行う
     * （片方だけ成功して、画像のない ID や、どの記録にも属さない画像が残らないように）。
     * ・記録が imageIds に持っていない画像は、画像の tradeId がこの記録のときだけ（取り残された画像）削除する。他の記録の画像は消さない
     * ・記録がない・削除済みなら NOT_FOUND
     * @param {string} tradeId
     * @param {string} imageId
     * @returns {Promise<object>} 更新後の記録
     */
    async removeTradeImage(tradeId, imageId) {
      assertId(tradeId);
      assertId(imageId);
      const t = now();
      let result;
      let changed = false;
      await db.runTx([STORE.TRADES, STORE.IMAGES], async (ops) => {
        const stored = await ops.get(STORE.TRADES, tradeId);
        if (!stored || stored.deletedAt != null) throw notFound();
        result = stored;
        if ((stored.imageIds || []).includes(imageId)) {
          result = { ...stored, imageIds: buildImageIds(stored.imageIds, [], [imageId]), updatedAt: t, syncStatus: 'pending' };
          changed = true;
          await ops.put(STORE.TRADES, result);
          await ops.delete(STORE.IMAGES, imageId);
          return;
        }
        const image = await ops.get(STORE.IMAGES, imageId);
        if (image && image.tradeId === tradeId) await ops.delete(STORE.IMAGES, imageId);
      });
      if (changed) emit(TRADES_CHANGED, { type: 'update', id: tradeId, trade: result });
      return result;
    },

    /**
     * CSV から読んだ記録をまとめて取り込む（T-44：design 14.6.9・14.6.12）。
     * ・**1つのトランザクションで全部書く**（途中でアプリが閉じられても、半端に入らない＝全部入るか何も入らない）
     * ・すでにある記録（同じ ID）は overwrite が false ならスキップ、true なら buildImportedTrade で置き換える
     * ・snapshot（確認シートを出した時点の、ID ごとの端末の updatedAt。なければ null：csv-import.js の summarizeImport）と、
     *   書き込む直前の記録を比べ、違っていたら AppError CONFLICT で何も書かない（確認中に別の画面で記録が変わった：
     *   design 14.6.9「確認中に記録が変更されました」）。スキップする記録は書かないので比べない
     * ・失敗（容量不足など）は QUOTA / DB_WRITE。何も書かれていない
     * ・書いたら 'trades-changed'（type: 'imported'）を1回だけ出す（1件ずつ出すと一覧が件数分描き直されるため）
     * @param {object[]} rows CSV から読んだ記録（csv-import.js の rowToTrade でチェック済み。ID が重ならないこと）
     * @param {{ overwrite?: boolean, snapshot: Map<string, (string|null)> }} opts
     * @returns {Promise<{ added: number, overwritten: number, skipped: number, trades: object[] }>} trades は書いた記録
     */
    async importTrades(rows, { overwrite = false, snapshot }) {
      if (!(snapshot instanceof Map)) throw new TypeError('trades：importTrades には確認した時点の snapshot（Map）を渡してください');
      for (const row of rows) {
        assertId(row && row.id);
        normalizeTrade(row); // 6.1 にない項目が混ざっていないかを、DB を開く前に確かめる
      }
      let result;
      await db.runTx([STORE.TRADES], async (ops) => {
        result = { added: 0, overwritten: 0, skipped: 0, trades: [] };
        // 同じトランザクションの中で端末の記録を一度に読む（1件ずつ get を待つと、1万件で数秒かかったため）。
        // 読んでから書き終わるまで、ほかの画面の書き込みはこのトランザクションの後に回される（IndexedDB の決まり）
        const device = new Map((await ops.getAll(STORE.TRADES)).map((x) => [x.id, x]));
        const writes = [];
        // 先に全部を確かめてから書く（確認中に変わった記録が1件でもあれば、何も書かずに CONFLICT）
        for (const row of rows) {
          const expected = snapshot.has(row.id) ? snapshot.get(row.id) : null;
          if (expected !== null && !overwrite) {
            result.skipped += 1;
            continue;
          }
          const stored = device.get(row.id) || null;
          if ((stored ? stored.updatedAt : null) !== expected) {
            throw new AppError('CONFLICT', '確認中に記録が変更されました。もう一度CSVを読み込んでください。');
          }
          writes.push([buildImportedTrade(row, stored), stored !== null]);
        }
        // 書き込みの要求はまとめて出し、全部の完了を待つ（1つでも失敗すればトランザクションごと取り消される）
        const pending = [];
        try {
          for (const [saved, exists] of writes) pending.push(exists ? ops.put(STORE.TRADES, saved) : ops.add(STORE.TRADES, saved));
        } catch (e) {
          // 要求を出す時点で失敗した（保存できない値など）。出し終えた分は取り消しで失敗になるので、その失敗は黙って受け取る
          for (const p of pending) p.catch(() => {});
          throw e;
        }
        await Promise.all(pending);
        for (const [saved, exists] of writes) {
          if (exists) result.overwritten += 1;
          else result.added += 1;
          result.trades.push(saved);
        }
      });
      if (result.trades.length > 0) emit(TRADES_CHANGED, { type: 'imported', ids: result.trades.map((t) => t.id) });
      return result;
    },

    /**
     * スプレッドシートへの送信の結果を記録に書き戻す（T-41：js/sync-sender.js が呼ぶ。sheets-setup 6.3・10.3）。
     * ・変えるのは syncStatus と syncedAt だけ。**updatedAt は変えない**（architecture 3.3：編集画面の競合の検出〔expectedUpdatedAt〕と
     *   下書きの照合〔baseUpdatedAt〕を誤って働かせないため）
     * ・**送ったときと同じ updatedAt のときだけ**書き戻す（architecture 20.2）。加えて sameAsSent を渡すと、それが true のときだけ
     *   （updatedAt は秒単位なので、同じ秒の中の変更〔削除の直後の「取り消す」など〕は updatedAt では見分けられない：R-05）。
     *   送っている間に変わった記録は pending のまま残り、その変更の通知で改めて送られる
     * ・syncStatus：'synced' なら syncedAt も渡された「送る時刻」にする。'error'（受け付けられなかった）なら syncedAt は前回のまま
     * ・記録が無いときは何もしない。削除済みでも書き戻す（削除済みの記録も送る：sheets-setup 6.2）
     * ・1つのトランザクションでまとめて書く。**'trades-changed' は出さない**（出すと送信のきっかけになり、送信 → 書き戻し → 送信 … と
     *   繰り返すため。一覧・詳細はまだ同期の状態を表示していないので、描き直す必要もない〔表示は T-43〕）
     * @param {Array<{ id: string, updatedAt: string, syncStatus: ('synced'|'error'), syncedAt?: string,
     *   sameAsSent?: (stored: object) => boolean }>} entries
     * @returns {Promise<string[]>} 書き戻した記録の id（送っている間に変わったものは含まない）
     */
    async markSyncResults(entries) {
      for (const e of entries) {
        assertId(e && e.id);
        if (e.syncStatus !== 'synced' && e.syncStatus !== 'error') throw new TypeError("trades：syncStatus は 'synced' か 'error' で渡してください");
      }
      if (entries.length === 0) return [];
      const marked = [];
      await db.runTx([STORE.TRADES], async (ops) => {
        marked.length = 0;
        for (const e of entries) {
          const stored = await ops.get(STORE.TRADES, e.id);
          if (!stored || stored.updatedAt !== e.updatedAt) continue;
          if (e.sameAsSent && !e.sameAsSent(stored)) continue;
          const next = normalizeTrade({
            ...stored,
            syncStatus: e.syncStatus,
            syncedAt: e.syncStatus === 'synced' ? e.syncedAt : stored.syncedAt,
          });
          await ops.put(STORE.TRADES, next);
          marked.push(e.id);
        }
      });
      return [...marked];
    },

    /** 1件取得。見つからなければ null（削除済みもそのまま返す。表示するかは呼び出し側が deletedAt で判断） */
    getTrade: (id) => db.getTrade(id),

    /** 全件取得（削除済みも含む。一覧・集計では deletedAt があるものを除く：architecture 6.3・10章） */
    getAllTrades: () => db.getAllTrades(),

    /**
     * 論理削除（architecture 10章）。deletedAt・updatedAt ＝今、syncStatus ＝ 'pending'。
     * 画像は消さない（取り消しで元に戻せるように）。
     * すでに削除済みなら何も変えずにその記録を返す（2回押しても削除日時が変わらない＝取り消しが効くまま）。
     * その記録の決済・編集の下書きは消さず、baseUpdatedAt を新しい updatedAt に付け替える（取り消しで入力途中の内容も戻せるように：R-10）。
     * 下書きは一覧などが、削除から1分を過ぎてから掃除する（draft-notice.js の keepsGoneDraft）。
     * @param {string} id
     * @returns {Promise<object>} 削除後の記録。取り消しには戻り値の deletedAt を undoDeleteTrade に渡す
     */
    async deleteTrade(id) {
      assertId(id);
      const t = now();
      let result;
      let changed = false;
      await db.runTx([STORE.TRADES, STORE.DRAFTS], async (ops) => {
        const stored = await ops.get(STORE.TRADES, id);
        if (!stored) throw notFound();
        if (stored.deletedAt != null) {
          result = stored;
          return;
        }
        result = { ...stored, deletedAt: t, updatedAt: t, syncStatus: 'pending' };
        changed = true;
        await ops.put(STORE.TRADES, result);
        await rebaseTradeDrafts(ops, id, stored.updatedAt, t);
      });
      if (changed) emit(TRADES_CHANGED, { type: 'delete', id, trade: result });
      return result;
    },

    /**
     * 削除の取り消し（architecture 10章：トースト「削除しました［取り消す］」）。
     * deletedAt が「削除したときに付けた値のまま」のときだけ、deletedAt ＝ null・updatedAt ＝今・
     * syncStatus ＝ 'pending' にして戻す。違うとき（すでに取り消し済み・別の操作で変わった）は何もせず null を返す。
     * 決済・編集の下書きが残っていれば、baseUpdatedAt を新しい updatedAt に付け替える（取り消したあとも続きを開けるように：R-10）。
     * @param {string} id
     * @param {string} deletedAt deleteTrade の戻り値の deletedAt
     * @returns {Promise<object|null>} 戻した記録。戻さなかったときは null
     */
    async undoDeleteTrade(id, deletedAt) {
      assertId(id);
      const t = now();
      let result = null;
      await db.runTx([STORE.TRADES, STORE.DRAFTS], async (ops) => {
        const stored = await ops.get(STORE.TRADES, id);
        if (!stored) throw notFound();
        if (stored.deletedAt == null || stored.deletedAt !== deletedAt) return;
        result = { ...stored, deletedAt: null, updatedAt: t, syncStatus: 'pending' };
        await ops.put(STORE.TRADES, result);
        await rebaseTradeDrafts(ops, id, stored.updatedAt, t);
      });
      if (result) emit(TRADES_CHANGED, { type: 'restore', id, trade: result });
      return result;
    },
  };
}

/** アプリ本体が使う業務処理（本物の DB） */
export const tradeService = createTradeService();

export const {
  saveNewTrade, saveTrade, closeTrade, reopenTrade, getTrade, getAllTrades, deleteTrade, undoDeleteTrade, removeTradeImage,
  importTrades, markSyncResults,
} = tradeService;
