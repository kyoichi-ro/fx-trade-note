/* =========================================================
   js/drafts.js
   入力途中の下書き（architecture.md 4.2・6.5・9章）。

   【T-12 の段階：保存の土台だけ】
   ・下書きの保存（createdAt・updatedAt を付ける）・取得・全件取得・破棄。
   ・破棄は「下書き＋この入力中に追加した画像（addedImageIds）」を1つのトランザクションで消す（architecture 9.4）。
     片方だけ消えて、どこからも使われない画像が残ったり、画像のない下書きが残ったりしないようにするため。
   【T-17 で追加】
   ・createDraftAutosaver()：入力画面の自動保存の係。0.5秒のデバウンス、アプリが裏に回った瞬間・ページを離れる瞬間の
     即時保存、「初期値から変わっていなければ作らない（元に戻したら消す）」をまとめて受け持つ（architecture 9.2）。
   ・pickLaunchDraft()：起動時に、最終更新から30分以内の下書きを選ぶ（architecture 9.3。開く画面を決めるのは app.js）。
   決済・編集の下書き（T-21・T-22）も同じ係を使う。
   保存に成功した記録の下書き削除は、記録の保存と同じトランザクションで trades.js が行う（draftKey を渡す）。

   依存（architecture 4.2）：db, util, datetime
   ========================================================= */
import { appDb, STORE, DRAFT_KEYS } from './db.js';
import { nowJst, isWithinMinutes } from './datetime.js';
import { assertKnownKeys, debounce } from './util.js';
import { DRAFT_RESTORE_MINUTES } from './config.js';

/** 下書きの種類（requirements 6.4 kind） */
export const DRAFT_KIND = Object.freeze({ NEW: 'new', CLOSE: 'close', EDIT: 'edit' });

/**
 * 下書きキーを作る（architecture 6.5）：'new' ／ 'close:{tradeId}' ／ 'edit:{tradeId}'。
 * 同じ画面の下書きは常に1つ、という約束をキーの形で守る。キーの組み立てはこの関数だけで行う。
 * @param {'new'|'close'|'edit'} kind
 * @param {string} [tradeId] close・edit では必須
 */
export function draftKeyOf(kind, tradeId) {
  if (kind === DRAFT_KIND.NEW) return 'new';
  if (kind === DRAFT_KIND.CLOSE || kind === DRAFT_KIND.EDIT) {
    if (typeof tradeId !== 'string' || tradeId === '') throw new TypeError(`drafts：${kind} の下書きには tradeId が必要です`);
    return `${kind}:${tradeId}`;
  }
  throw new TypeError("drafts：kind は 'new' / 'close' / 'edit' のどれかで渡してください");
}

/** 配列の項目を確かめてコピーする（未指定は []：architecture 6.7） */
function idList(v, key) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new TypeError(`drafts：${key} は配列で渡してください`);
  return [...v];
}

/**
 * 下書きの業務処理のまとまりを作る（テストでは別名の DB・決まった時刻で作る。trades.js と同じ考え方）。
 * @param {object} [options]
 * @param {object} [options.db]
 * @param {() => string} [options.now]
 */
export function createDraftService({ db = appDb, now = nowJst } = {}) {
  return {
    /**
     * 下書きを保存する（同じキーは上書き）。
     * ・key は kind と tradeId から作る（渡された key が違えば TypeError：別の画面の下書きを上書きしないため）
     * ・updatedAt ＝今。createdAt は同じ入力の続き（同じキー・同じ tradeId）なら最初の値を残し、そうでなければ今
     * ・fields は入力欄の文字のまま（architecture 6.5）。uiState・baseUpdatedAt は未指定なら null
     * @param {object} draft requirements 6.4 の項目（kind・tradeId 必須）
     * @returns {Promise<object>} 保存した下書き（10項目）
     */
    async saveDraft(draft) {
      assertKnownKeys(draft, DRAFT_KEYS, 'drafts');
      if (typeof draft.tradeId !== 'string' || draft.tradeId === '') {
        throw new TypeError('drafts：tradeId は空でない文字列で渡してください');
      }
      const key = draftKeyOf(draft.kind, draft.tradeId);
      if (draft.key !== undefined && draft.key !== key) {
        throw new TypeError(`drafts：key「${draft.key}」が kind・tradeId から作ったキー「${key}」と一致しません`);
      }
      if (draft.fields != null && (typeof draft.fields !== 'object' || Array.isArray(draft.fields))) {
        throw new TypeError('drafts：fields はオブジェクトで渡してください');
      }
      const t = now();
      let saved;
      await db.runTx([STORE.DRAFTS], async (ops) => {
        const stored = await ops.get(STORE.DRAFTS, key);
        const continued = stored && stored.tradeId === draft.tradeId;
        saved = {
          key,
          kind: draft.kind,
          tradeId: draft.tradeId,
          fields: { ...(draft.fields || {}) },
          uiState: draft.uiState == null ? null : draft.uiState,
          addedImageIds: idList(draft.addedImageIds, 'addedImageIds'),
          removedImageIds: idList(draft.removedImageIds, 'removedImageIds'),
          baseUpdatedAt: draft.baseUpdatedAt == null ? null : draft.baseUpdatedAt,
          createdAt: continued ? stored.createdAt : t,
          updatedAt: t,
        };
        await ops.put(STORE.DRAFTS, saved);
      });
      return saved;
    },

    /** 1件取得。なければ null */
    getDraft: (key) => db.getDraft(key),

    /** 全件取得（起動時に「入力途中のものがあるか」を調べる：architecture 9.3） */
    getAllDrafts: () => db.getAllDrafts(),

    /**
     * 下書きを破棄する（「入力内容を破棄」・変更なしのキャンセル：architecture 9.4）。
     * 下書きと、その addedImageIds の画像を1つのトランザクションで削除する。
     * removedImageIds の画像は消さない（編集のキャンセルでは元に戻るため：6.5）。
     * alsoImageIds（T-24）：画面がまだ下書きに書き込めていない（0.5秒の待ちの途中など）追加済みの画像の ID。
     *   下書きがなくても、これらの画像は消す（画像だけが孤立して残るのを防ぐ）。下書きにも書かれていれば二重に消すだけで害はない
     * 【安全策】どれかの記録の imageIds に載っている画像は、下書きの addedImageIds にあっても消さない。
     *   記録の保存は済んでいたのに下書きだけが残っていた場合（二重保存の DUPLICATE のあとなど）に、保存済みの記録の画像を
     *   下書きの後片付けで道連れに消してしまう事故を防ぐため。
     * @param {string} key
     * @param {{alsoImageIds?: string[]}} [opts]
     * @returns {Promise<boolean>} 下書きがあって消したら true、もともとなければ false
     */
    async discardDraft(key, { alsoImageIds = [] } = {}) {
      return db.runTx([STORE.DRAFTS, STORE.IMAGES, STORE.TRADES], async (ops) => {
        const stored = await ops.get(STORE.DRAFTS, key);
        const ids = new Set([...(stored ? stored.addedImageIds || [] : []), ...alsoImageIds]);
        if (ids.size > 0) {
          const used = new Set();
          for (const trade of await ops.getAll(STORE.TRADES)) for (const id of trade.imageIds || []) used.add(id);
          for (const id of ids) if (!used.has(id)) await ops.delete(STORE.IMAGES, id);
        }
        if (!stored) return false;
        await ops.delete(STORE.DRAFTS, key);
        return true;
      });
    },
  };
}

/** アプリ本体が使う業務処理（本物の DB） */
export const draftService = createDraftService();

export const { saveDraft, getDraft, getAllDrafts, discardDraft } = draftService;

/* ---------------------------------------------------------
   T-17：自動保存の係・起動時の復元
   --------------------------------------------------------- */

/** 自動保存のデバウンスの待ち時間（architecture 9.2：入力が止まって0.5秒後） */
export const DRAFT_SAVE_WAIT_MS = 500;

/**
 * 起動時に自動で開く下書きを選ぶ（architecture 9.3・design 14.1.10）。
 * 最終更新（updatedAt）から minutes 分以内のもののうち、いちばん新しいものを返す。なければ null。
 * 30分は「自動で入力画面を開くか」の境目で、下書きの有効期限ではない（古い下書きは消さない：design 14.1.10）。
 * @param {object[]} drafts getAllDrafts() の結果
 * @param {{ now?: Date, minutes?: number, kinds?: string[] }} [opts]
 *   kinds：対象にする種類（入力画面ができている種類だけ渡す。T-17 の時点では 'new' だけ）
 * @returns {object|null}
 */
export function pickLaunchDraft(drafts, { now = new Date(), minutes = DRAFT_RESTORE_MINUTES, kinds = Object.values(DRAFT_KIND) } = {}) {
  let best = null;
  for (const d of drafts || []) {
    if (!d || !kinds.includes(d.kind) || !isWithinMinutes(d.updatedAt, minutes, now)) continue;
    // 保存形式（固定25文字）なので文字のまま比べても時刻の順になる（architecture 6.6）
    if (!best || d.updatedAt > best.updatedAt) best = d;
  }
  return best;
}

/**
 * 入力画面の下書きの自動保存の係を作る（architecture 9.2）。
 * ・schedule()：入力のたびに呼ぶ。止まって0.5秒後に1回だけ保存する（連続入力中はまとめて1回）
 * ・flush()：待たずに今すぐ保存する（画面を離れるとき。アプリが裏に回ったときは自動で呼ぶ）
 * ・初期値から変わっていない（isChanged() が false）なら保存しない。保存済みの下書きがあれば消す
 *   （「今」を入れただけで下書きができる・変更を元に戻したのに下書きが残る、を防ぐ：architecture 9.2）
 * ・stop()：記録の保存・破棄の直前に呼ぶ。予約を取り消し、保存中のものが終わるのを待つ。
 *   これを待たずに記録を保存すると、後から届いた自動保存が下書きを作り直してしまうため
 * ・resume()：記録の保存に失敗したときに自動保存を再開する（下書きを残す：design 14.1.6）
 * ・保存の成功・失敗は onStatus(ok) で知らせる（失敗しても入力は続けられる。画面は「下書きを保存できません」を出す：design 14.7.6）
 * @param {{ key: string, build: () => object, isChanged: () => boolean, onStatus?: (ok: boolean) => void,
 *   service?: object, wait?: number, hasStored?: boolean, lifecycle?: boolean }} opts
 *   build     … 保存する下書き（kind・tradeId・fields・uiState など。saveDraft の引数）を作る関数
 *   hasStored … 下書きがすでに保存されている状態で始めるか（下書きから復元したとき true）
 *   lifecycle … アプリが裏に回ったとき（visibilitychange）・ページを離れるとき（pagehide）に即時保存するか
 */
export function createDraftAutosaver({
  key, build, isChanged, onStatus = () => {}, service = draftService, wait = DRAFT_SAVE_WAIT_MS, hasStored = false, lifecycle = true,
}) {
  let stopped = false;
  let stored = hasStored;
  let lastSaved = null; // 最後に保存した中身（同じ中身を何度も書かないため）
  let inflight = Promise.resolve();

  const run = async () => {
    if (stopped) return;
    if (!isChanged()) {
      if (!stored) return;
      stored = false;
      lastSaved = null;
      await service.discardDraft(key);
      return;
    }
    const draft = build();
    // 外した画像（removedImageIds）と土台の記録の updatedAt も含める。含めないと、下書きを一度保存したあとに
    // 「保存済みの画像を外す」だけの操作が「同じ内容」とみなされて書かれず、開き直すと外した操作が戻っていた（T-30 の R-08）
    const snapshot = JSON.stringify([
      draft.fields, draft.uiState, draft.addedImageIds || [], draft.removedImageIds || [], draft.baseUpdatedAt ?? null,
    ]);
    if (snapshot === lastSaved && stored) return;
    try {
      await service.saveDraft(draft);
      stored = true;
      lastSaved = snapshot;
      onStatus(true);
    } catch (e) {
      console.error('下書きを保存できませんでした', e);
      onStatus(false);
    }
  };

  // 前の保存が終わってから次を始める（順番が入れ替わって古い内容で上書きしないように）
  const enqueue = () => {
    inflight = inflight.then(run).catch((e) => console.error('下書きの処理に失敗しました', e));
    return inflight;
  };
  const debounced = debounce(enqueue, wait);

  const onVisibility = () => { if (document.visibilityState === 'hidden') api.flush(); };
  const onPageHide = () => api.flush();
  const canListen = lifecycle && typeof document !== 'undefined' && typeof window !== 'undefined';
  if (canListen) {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
  }

  const api = {
    schedule() { if (!stopped) debounced(); },
    flush() {
      debounced.cancel();
      return stopped ? inflight : enqueue();
    },
    async stop() {
      stopped = true;
      debounced.cancel();
      await inflight;
    },
    resume() { stopped = false; },
    /** 画面を閉じたときに呼ぶ（監視をやめる）。保存はしないので、必要なら先に flush() を呼ぶ */
    dispose() {
      debounced.cancel();
      if (canListen) {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onPageHide);
      }
    },
    /** 下書きが保存されている（はずの）状態か */
    hasStored: () => stored,
  };
  return api;
}
