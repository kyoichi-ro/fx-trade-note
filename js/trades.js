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
   T-21 / T-22 で、pips・損益の再計算（決済）・決済の取り消し・編集時の lotUnitSize のコピーし直しを足す。

   変更を保存したら events.js の 'trades-changed' で知らせる（一覧の再描画・Phase 2 の送信が受け取る：3.3）。
   通知は IndexedDB への書き込みが確定（complete）してから出す。

   依存（architecture 4.2）：db, datetime, util, events, calc, settings-store
   ========================================================= */
import { appDb, STORE, TRADE_KEYS } from './db.js';
import { nowJst } from './datetime.js';
import { newId, AppError, assertKnownKeys } from './util.js';
import { emit } from './events.js';
import { calcRiskReward, judgeSession } from './calc.js';
import { settingsStore } from './settings-store.js';

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
 * ・riskReward：SL・TP の両方と、通貨ペア・売買方向・エントリー価格がそろっているときだけ calcRiskReward()。
 *   そろっていなければ null（requirements 6.1。T-18 で calcRiskReward 自体も空の値に null を返す形に直す予定だが、
 *   ここでも先に確かめておくと、入力途中の値で計算してしまう事故を二重に防げる）
 * ・session：空（null）のときだけ entryAt から判定（judgeSession）。画面で手で選んだ値は書き換えない（design 14.1.5 ⑩）
 * pips・損益（円）の再計算は決済画面の T-21 で足す。
 * @param {object} trade
 * @returns {object}
 */
export function recompute(trade) {
  const out = { ...trade };
  out.status = judgeStatus(trade);
  const canRr = [trade.pair, trade.side, trade.entryPrice, trade.slPrice, trade.tpPrice].every((v) => v != null);
  out.riskReward = canRr ? calcRiskReward(trade).rr : null;
  if (out.session == null) out.session = judgeSession(out.entryAt);
  return out;
}

/** 口座区分が正しいか（lotUnitSize を設定から読むキーに使うため、打ち間違いは保存前に止める） */
function assertAccountType(v) {
  if (v !== 'demo' && v !== 'real') throw new TypeError("trades：accountType は 'demo' か 'real' で渡してください");
}

/** 記録が見つからない（または削除済み）ときのエラー（architecture 15.1 NOT_FOUND） */
function notFound() {
  return new AppError('NOT_FOUND', 'この記録は見つかりません。');
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
      await db.runTx([STORE.TRADES, STORE.DRAFTS], async (ops) => {
        await ops.add(STORE.TRADES, trade);
        if (draftKey) await ops.delete(STORE.DRAFTS, draftKey);
      });
      emit(TRADES_CHANGED, { type: 'add', id, trade });
      return trade;
    },

    /**
     * 既存の記録を更新する（決済・編集・決済取消の保存に使う：architecture 8章）。
     * ・updatedAt ＝今、syncStatus ＝ 'pending'（保存のたびに未送信へ戻す：requirements 6.1）
     * ・status・riskReward・session は recompute() で決め直す（T-17。決済・決済取消で status が自動で切り替わる）
     * ・createdAt・deletedAt・syncedAt は保存されている値を使う（画面から渡された値で上書きしない）。
     *   削除状態を変えられるのは deleteTrade / undoDeleteTrade だけにして、うっかり削除が戻る事故を防ぐ
     * ・記録がない・削除済みなら AppError NOT_FOUND（消えた記録を put で作り直さない）
     * ・draftKey を渡すと下書きの削除も同じトランザクションで行う
     * @param {object} trade 32項目（id 必須）
     * @param {{draftKey?: string}} [opts]
     * @returns {Promise<object>} 保存した記録
     */
    async saveTrade(trade, { draftKey } = {}) {
      assertId(trade && trade.id);
      normalizeTrade(trade); // 6.1 にない項目が混ざっていないかを、DB を開く前に確かめる
      const t = now();
      let saved;
      await db.runTx([STORE.TRADES, STORE.DRAFTS], async (ops) => {
        const stored = await ops.get(STORE.TRADES, trade.id);
        if (!stored || stored.deletedAt != null) throw notFound();
        saved = normalizeTrade(recompute({
          ...trade,
          createdAt: stored.createdAt,
          deletedAt: stored.deletedAt,
          syncedAt: stored.syncedAt,
          syncStatus: 'pending',
          updatedAt: t,
        }));
        await ops.put(STORE.TRADES, saved);
        if (draftKey) await ops.delete(STORE.DRAFTS, draftKey);
      });
      emit(TRADES_CHANGED, { type: 'update', id: saved.id, trade: saved });
      return saved;
    },

    /** 1件取得。見つからなければ null（削除済みもそのまま返す。表示するかは呼び出し側が deletedAt で判断） */
    getTrade: (id) => db.getTrade(id),

    /** 全件取得（削除済みも含む。一覧・集計では deletedAt があるものを除く：architecture 6.3・10章） */
    getAllTrades: () => db.getAllTrades(),

    /**
     * 論理削除（architecture 10章）。deletedAt・updatedAt ＝今、syncStatus ＝ 'pending'。
     * 画像は消さない（取り消しで元に戻せるように）。
     * すでに削除済みなら何も変えずにその記録を返す（2回押しても削除日時が変わらない＝取り消しが効くまま）。
     * @param {string} id
     * @returns {Promise<object>} 削除後の記録。取り消しには戻り値の deletedAt を undoDeleteTrade に渡す
     */
    async deleteTrade(id) {
      assertId(id);
      const t = now();
      let result;
      let changed = false;
      await db.runTx([STORE.TRADES], async (ops) => {
        const stored = await ops.get(STORE.TRADES, id);
        if (!stored) throw notFound();
        if (stored.deletedAt != null) {
          result = stored;
          return;
        }
        result = { ...stored, deletedAt: t, updatedAt: t, syncStatus: 'pending' };
        changed = true;
        await ops.put(STORE.TRADES, result);
      });
      if (changed) emit(TRADES_CHANGED, { type: 'delete', id, trade: result });
      return result;
    },

    /**
     * 削除の取り消し（architecture 10章：トースト「削除しました［取り消す］」）。
     * deletedAt が「削除したときに付けた値のまま」のときだけ、deletedAt ＝ null・updatedAt ＝今・
     * syncStatus ＝ 'pending' にして戻す。違うとき（すでに取り消し済み・別の操作で変わった）は何もせず null を返す。
     * @param {string} id
     * @param {string} deletedAt deleteTrade の戻り値の deletedAt
     * @returns {Promise<object|null>} 戻した記録。戻さなかったときは null
     */
    async undoDeleteTrade(id, deletedAt) {
      assertId(id);
      const t = now();
      let result = null;
      await db.runTx([STORE.TRADES], async (ops) => {
        const stored = await ops.get(STORE.TRADES, id);
        if (!stored) throw notFound();
        if (stored.deletedAt == null || stored.deletedAt !== deletedAt) return;
        result = { ...stored, deletedAt: null, updatedAt: t, syncStatus: 'pending' };
        await ops.put(STORE.TRADES, result);
      });
      if (result) emit(TRADES_CHANGED, { type: 'restore', id, trade: result });
      return result;
    },
  };
}

/** アプリ本体が使う業務処理（本物の DB） */
export const tradeService = createTradeService();

export const {
  saveNewTrade, saveTrade, getTrade, getAllTrades, deleteTrade, undoDeleteTrade,
} = tradeService;
