/* =========================================================
   js/draft-notice.js
   入力途中の下書き（エントリー・決済・編集）の「いま使えるか」の判定と、一覧のお知らせ行の文言（T-22）。
   design.md 14.1.10・14.2.10・14.3.8、architecture.md 9.3。

   【なぜ画面ファイルと分けたのか】
   「この下書きは続きを開いてよいか／黙って消すか／元の記録が変わったので破棄して知らせるか」は、古い内容で記録を上書きする事故に
   直結する判断なので、画面を開かなくても Node.js のテストで確かめられる形にしておきたいため。
   ここは document も IndexedDB も触らない純粋な関数だけ（読み書きは各画面・app.js が行う）。
   ========================================================= */
import { isClosedTrade } from './filter.js';
import { formatDraftTime } from './format.js';

/** 下書きの種類の並び（お知らせ行の件数の言い方の順：エントリー・決済・編集） */
const KINDS = ['new', 'close', 'edit'];

/** 種類の呼び名（お知らせ行・選ぶシート） */
export const DRAFT_KIND_LABELS = Object.freeze({ new: 'エントリー', close: '決済', edit: '編集' });

/**
 * 元の記録が変わったために下書きを破棄したときの知らせ（design 14.3.8・architecture 9.3）。
 * 編集の文言は design で決まっている。決済は編集と同じ考え方で、同じ形の文にした（T-21 申し送り #9）。
 */
export const DRAFT_STALE_TEXT = Object.freeze({
  edit: '元の記録が変更されたため、入力途中の編集を破棄しました',
  close: '元の記録が変更されたため、入力途中の決済を破棄しました',
});

/**
 * 下書きの対象の記録の状態を見て、続きを開いてよいかを決める。
 *   'ok'    … そのまま使える（新規エントリーは対象がないので常に ok）
 *   'gone'  … 対象の記録がない・削除済み、決済の下書きなのにもう決済済み。黙って消してよい（design 14.2.10）
 *   'stale' … 下書きを作ったあとに、元の記録が別の操作で変更された（下書きに保存した baseUpdatedAt と、いまの updatedAt が違う）。
 *             古い内容で上書きしないよう、下書きは破棄して知らせる（architecture 9.3）。決済の下書きにも同じ照合をする
 *             （決済の下書きにはエントリー時のタグ・メモが入っていて、あとから編集で書き換えた内容を古い内容で戻してしまうため：T-21 申し送り #9）
 * 下書きに baseUpdatedAt がない（古い版の下書き）ときは、比べられないので 'ok'（入力を黙って捨てない）。
 * @param {object} draft 下書き（kind・baseUpdatedAt）
 * @param {object|null} trade 対象の記録（なければ null）。新規エントリーでは使わない
 * @returns {'ok'|'gone'|'stale'}
 */
export function judgeDraftTarget(draft, trade) {
  if (draft.kind === 'new') return 'ok';
  if (!trade || trade.deletedAt != null) return 'gone';
  if (draft.kind === 'close' && isClosedTrade(trade)) return 'gone';
  if (draft.baseUpdatedAt != null && draft.baseUpdatedAt !== trade.updatedAt) return 'stale';
  return 'ok';
}

/** 下書きの続きを開く URL（architecture 5.1） */
export function draftTargetHash(draft) {
  if (draft.kind === 'new') return '#/new';
  const base = `#/trades/${encodeURIComponent(draft.tradeId)}`;
  return draft.kind === 'close' ? `${base}/close` : `${base}/edit`;
}

/** 売買方向の表示（▲買い・▼売り）。知らない値は空 */
function sideWord(side) {
  return side === 'buy' ? '▲買い' : side === 'sell' ? '▼売り' : '';
}

/**
 * 下書きの要約の言葉（時刻を除く）。選んでいない項目は省く。
 * ・新規エントリー：下書きに入っている通貨ペア・売買方向（例「USD/JPY ▲買い」。何もなければ空）
 * ・決済・編集：対象の記録の口座・通貨ペア・売買方向（例「本番 USD/JPY ▲買い」）。決済の下書きには記録の情報がなく、
 *   編集の下書きは「編集前の記録」のほうが分かりやすいため、どちらも保存されている記録から作る
 * @param {object} draft
 * @param {object|null} trade 決済・編集の対象の記録
 * @returns {string}
 */
export function draftWords(draft, trade) {
  const words = [];
  if (draft.kind === 'new') {
    const f = draft.fields || {};
    if (typeof f.pair === 'string' && f.pair) words.push(f.pair);
    words.push(sideWord(f.side));
  } else if (trade) {
    words.push(trade.accountType === 'real' ? '本番' : trade.accountType === 'demo' ? 'デモ' : '', trade.pair || '', sideWord(trade.side));
  }
  return words.filter(Boolean).join(' ');
}

/**
 * 2行目の文（design 14.3.8）：「USD/JPY ▲買い・21:32」。言葉がなければ時刻だけ。
 * 時刻は下書きの最終更新。今日なら時刻だけ、それ以外は「10/14 21:32」（format.js の formatDraftTime）。
 */
export function draftSummary(draft, trade, now = new Date()) {
  const words = draftWords(draft, trade);
  const time = formatDraftTime(draft.updatedAt, now);
  return words ? `${words}・${time}` : time;
}

/** 選ぶシートの1行（design 14.3.8：「決済　本番 USD/JPY ▲買い　23:05」） */
function choiceLabel(draft, trade, now) {
  const parts = [DRAFT_KIND_LABELS[draft.kind], draftWords(draft, trade), formatDraftTime(draft.updatedAt, now)];
  return parts.filter(Boolean).join('　');
}

/** 件数の言い方（「エントリー1件・決済2件」。0件の種類は出さない） */
function countText(items) {
  return KINDS
    .map((k) => [k, items.filter((x) => x.draft.kind === k).length])
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${DRAFT_KIND_LABELS[k]}${n}件`)
    .join('・');
}

/**
 * 一覧のお知らせ行に出す、入力途中の下書きの案内を作る（design 14.3.8）。
 * ・0件 → null
 * ・1件 → 「入力途中のエントリー（決済・編集）があります」＋2行目の要約＋［続ける］（その入力画面を開く）
 * ・2件以上 → 「入力途中の記録が3件あります」＋「エントリー1件・決済2件」＋［選ぶ］（下書きを新しい順に並べたシートで選ぶ）
 * @param {{ draft: object, trade: (object|null) }[]} items 続きを開いてよい下書き（judgeDraftTarget が 'ok'）と、その対象の記録
 * @param {Date} [now]
 * @returns {null | { text: string, subtext: string, mode: 'continue'|'choose', hash?: string,
 *   choices?: { label: string, hash: string }[] }}
 */
export function buildDraftNotice(items, now = new Date()) {
  if (items.length === 0) return null;
  // 新しい順（保存形式は固定25文字なので文字のまま比べても時刻の順になる：architecture 6.6）
  const sorted = [...items].sort((a, b) => (a.draft.updatedAt < b.draft.updatedAt ? 1 : a.draft.updatedAt > b.draft.updatedAt ? -1 : 0));
  if (sorted.length === 1) {
    const { draft, trade } = sorted[0];
    return {
      text: `入力途中の${DRAFT_KIND_LABELS[draft.kind]}があります`,
      subtext: draftSummary(draft, trade, now),
      mode: 'continue',
      hash: draftTargetHash(draft),
    };
  }
  return {
    text: `入力途中の記録が${sorted.length}件あります`,
    subtext: countText(sorted),
    mode: 'choose',
    choices: sorted.map(({ draft, trade }) => ({ label: choiceLabel(draft, trade, now), hash: draftTargetHash(draft) })),
  };
}
