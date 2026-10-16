/* =========================================================
   js/choice-list.js
   選択肢の編集（設定の「よく使う通貨ペア」「エントリー根拠」「感情」「タグ」）の、追加・削除・並び替え・名前のチェック。
   T-16 で作成（design.md 14.6.3・14.6.4、fx-rules.md 10.4）。

   ・ここは「基礎」の層（architecture.md 4.3）。画面（DOM）も localStorage も触らない純粋な関数だけを置く。
     そのため Node.js でも同じテストを実行できる（tests/choice-list.test.js）。
   ・どの関数も受け取った配列を書き換えず、新しい配列を返す（保存前の値が途中で変わる事故を防ぐため）。
   ・返すのはエラーの「コード」だけ（'empty'・'too-long'・'duplicate'・'last'、通貨ペアは E-12〜E-16・W-07）。
     画面に出す文言は design 14.6.3・14.6.4 が正なので、画面（screens/choices.js）がコードから文言を選ぶ。
   ・新しい計算式は作らない。通貨ペアの形・種類のチェックは validate.js の normalizePairInput（fx-rules 10.4）をそのまま使う。
   ========================================================= */
import { CHOICE_NAME_MAX_LENGTH } from './config.js';
import { PAIR_MASTER, getPairSpec } from './master.js';
import { normalizePairInput } from './validate.js';
import { countChars } from './util.js';

/* ---------------------------------------------------------
   根拠・感情・タグ（文字の名前の選択肢）
   --------------------------------------------------------- */

/**
 * 名前のチェックで返るエラーコードに対応する文言（design 14.6.3）。'empty' は文を出さない（行を閉じるだけ）ので載せない。
 * 設定の選択肢の編集画面（screens/choices.js）と、入力画面のタグ追加（ui/tag-picker.js・T-18）で同じ文を使うため、ここに1つだけ置く。
 */
export const CHOICE_NAME_ERROR_TEXTS = Object.freeze({
  duplicate: '同じ名前がすでにあります',
  'too-long': `${CHOICE_NAME_MAX_LENGTH}文字以内で入力してください`,
});

/**
 * 選択肢の名前を確かめる（design 14.6.3 の「追加時のチェック」）。
 * 順番：空白だけ → 21文字以上 → 同じ名前がある。
 * ・前後の空白（全角スペースも）は取り除いてから確かめる。途中の空白はそのまま。
 * ・「空白だけ」は追加しない（画面は文を出さずに行を閉じる）ので、エラーというより「何もしない」の合図 'empty'。
 * ・文字数は countChars（人が数えるとおり）。同じ名前は完全に同じ文字のとき（大文字小文字・全角半角は別の名前として扱う）。
 * @param {string} input 入力された文字
 * @param {readonly string[]} list 今ある選択肢
 * @returns {{ ok: true, name: string } | { ok: false, error: 'empty'|'too-long'|'duplicate' }}
 */
export function checkChoiceName(input, list) {
  const name = String(input ?? '').trim();
  if (name === '') return { ok: false, error: 'empty' };
  if (countChars(name) > CHOICE_NAME_MAX_LENGTH) return { ok: false, error: 'too-long' };
  if (list.includes(name)) return { ok: false, error: 'duplicate' };
  return { ok: true, name };
}

/**
 * 選択肢を末尾に追加する。
 * @returns {{ ok: true, name: string, list: string[] } | { ok: false, error: 'empty'|'too-long'|'duplicate' }}
 */
export function addChoice(list, input) {
  const r = checkChoiceName(input, list);
  if (!r.ok) return r;
  return { ok: true, name: r.name, list: [...list, r.name] };
}

/**
 * 選択肢を削除する。0件になってもよい（根拠・感情・タグ。design 14.6.3）。
 * 名前の変更は作らない：変えると過去の記録の文字と食い違い、分析で別の項目として数えられるため（design 14.6.3）。
 * 過去の記録は選択肢の名前を文字のまま持っているので、削除しても表示は変わらない。
 */
export function removeChoice(list, name) {
  return list.filter((x) => x !== name);
}

/**
 * 入力画面（エントリー・決済）の「＋追加」でタグを足すときの判断（design 14.1.5・14.2.6 ⑥、T-18）。
 * 名前のチェックは設定の画面と同じ checkChoiceName（空白だけ・20文字以内・同じ名前は不可）を使う。
 * 「同じ名前」は設定のタグ（settingsTags）と比べる。ただし記録が持っているタグは、あとで設定から消されていることがあり、
 * その名前は画面のチップには残っている（visibleOptions）。そのときは設定に加え直すだけで、チップは増やさない
 * （同じ名前のチップが2つ並ぶのを防ぐため。isNewChip が false）。
 * @param {readonly string[]} settingsTags 設定のタグ（choices.tags）
 * @param {readonly string[]} visibleOptions いま画面に並んでいるタグのチップ（設定のタグ＋選択済みで設定にない値）
 * @param {string} input 入力された文字
 * @returns {{ ok: true, name: string, list: string[], isNewChip: boolean } | { ok: false, error: 'empty'|'too-long'|'duplicate' }}
 *   list は設定に保存するタグの一覧（末尾に追加したもの）
 */
export function planTagAdd(settingsTags, visibleOptions, input) {
  const r = addChoice(settingsTags, input);
  if (!r.ok) return r;
  return { ok: true, name: r.name, list: r.list, isNewChip: !visibleOptions.includes(r.name) };
}

/**
 * 選択肢に、いま選んでいる値（設定から消された値など）が無ければ末尾に足す。
 * なぜ必要か：記録が持っている根拠・感情・タグは、あとから設定で削除されることがある。決済・編集の画面でその値が
 * チップから消えると、選択済みのまま見えなくなり、保存したときに知らないうちに外れてしまう。
 * 足すだけで、設定の選択肢そのものは変えない（T-21 で close.js に作ったものを T-16 でここへ移した）。
 * @param {readonly string[]} options 設定の選択肢
 * @param {readonly string[]} selected いま選んでいる値
 * @returns {string[]}
 */
export function withSelected(options, selected) {
  const extra = [...new Set(selected.filter((v) => !options.includes(v)))];
  return [...options, ...extra];
}

/**
 * from 番目の項目を to 番目へ動かす（0 始まり。範囲外は端にそろえる）。並び替えの共通処理（通貨ペアにも使う）。
 * 例：moveItem(['a','b','c'], 0, 2) → ['b','c','a']
 */
export function moveItem(list, from, to) {
  const out = [...list];
  if (!Number.isInteger(from) || from < 0 || from >= out.length) return out;
  const target = Math.min(Math.max(Number.isInteger(to) ? to : from, 0), out.length - 1);
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item);
  return out;
}

/**
 * ドラッグで離した位置から、動かした項目の行き先の番号を求める。
 * 動かしている行の「真ん中」が、他の行の真ん中をどこまで越えたかで決める（iOS の並べ替えと同じ感覚）。
 * @param {readonly number[]} centers 動かし始める前の、全行の真ん中の位置（上から順）
 * @param {number} from 動かしている行の番号
 * @param {number} y 動かしている行の今の真ん中の位置（centers と同じ座標）
 * @returns {number} 行き先の番号（動かさないなら from のまま）
 */
export function dropIndex(centers, from, y) {
  let to = from;
  for (let i = from - 1; i >= 0 && y < centers[i]; i -= 1) to = i;
  for (let i = from + 1; i < centers.length && y > centers[i]; i += 1) to = i;
  return to;
}

/* ---------------------------------------------------------
   よく使う通貨ペア（favoritePairs）
   --------------------------------------------------------- */

/**
 * 通貨ペアを削除する。**最後の1つは削除できない**（design 14.6.3：エントリー画面に並べるペアが0個になるため）。
 * 登録にないペアを渡されたときは何も変えない。
 * @returns {{ ok: true, list: string[] } | { ok: false, error: 'last' }}
 */
export function removeFavoritePair(list, pair) {
  if (!list.includes(pair)) return { ok: true, list: [...list] };
  if (list.length <= 1) return { ok: false, error: 'last' };
  return { ok: true, list: list.filter((x) => x !== pair) };
}

/**
 * 通貨ペアを末尾に追加する（fx-rules 10.4）。入力の正規化（全角→半角・小文字→大文字・区切りをそろえる）と
 * E-12〜E-16・W-07 の判定は validate.js の normalizePairInput に任せる。
 * W-07（確認していない通貨）は警告で、追加はできる（画面は「確認して追加」の行にして、押されたら追加する）。
 * 追加したペアはマスタにもその他の設定キーにも増やさない（pip単位などは pair の文字列から毎回求まるため：fx-rules 10.4）。
 * @param {readonly string[]} list 今の「よく使う通貨ペア」
 * @param {string} input 入力された文字、またはマスタから選んだペア
 * @returns {{ ok: true, pair: string, warn: string[], list: string[] } | { ok: false, error: string, pair?: string }}
 */
export function addFavoritePair(list, input) {
  const r = normalizePairInput(input, list);
  if (!r.ok) return r;
  return { ok: true, pair: r.pair, warn: r.warn, list: [...list, r.pair] };
}

/** 検索のための正規化：全角→半角・大文字・空白と区切り（/ - _）を無視（「eurAUD」「ＥＵＲ／ＡＵＤ」「ユーロ/円」でも見つかるように） */
const normalizeQuery = (s) => String(s ?? '').normalize('NFKC').toUpperCase().replace(/[\s/\-_]/g, '');

/** この文字数（区切りを除く）に届いたら「通貨ペアとして入力し終えた」とみなす（入力途中のエラー表示を避けるため） */
const COMPLETE_PAIR_LENGTH = 6;

/**
 * 「通貨ペアを追加」シートの表示内容（design 14.6.4）。
 * ・hits   … 通貨ペアマスタのうち、登録済みでないもの（検索欄の文字があれば、ペア名・日本語名で絞る）。マスタの並び順
 * ・custom … 検索欄の文字がマスタにないペアの形のとき、「SGD/JPY を追加」の行の元（warn に W-07 があれば「確認して追加」の行）
 * ・error  … E-12〜E-16。この行の代わりに検索欄の下へ赤字で出す。
 *            入力の途中で赤字が出続けないよう、E-12（形が違う）は「6文字以上入力した・該当する候補がない」ときだけ。
 *            E-13〜E-16 は形が正しいペアのときにしか起きないので、すぐに出す。
 * @param {readonly string[]} favorites 今の「よく使う通貨ペア」
 * @param {string} query 検索欄の文字
 * @returns {{ hits: {pair: string, nameJa: string}[], custom: ({pair: string, warn: string[]}|null), error: (string|null) }}
 */
export function searchPairCandidates(favorites, query) {
  const q = normalizeQuery(query);
  const free = PAIR_MASTER.filter((p) => !favorites.includes(p.pair));
  const hits = free
    .filter((p) => !q || normalizeQuery(p.pair).includes(q) || normalizeQuery(p.nameJa).includes(q))
    .map((p) => ({ pair: p.pair, nameJa: getPairSpec(p.pair).nameJa }));
  if (q === '') return { hits, custom: null, error: null };

  const r = normalizePairInput(query, favorites);
  if (r.ok) {
    // マスタにあるペアは hits の行から選べるので、マスタにないペアのときだけ「追加」の行を出す
    const inMaster = PAIR_MASTER.some((p) => p.pair === r.pair);
    return { hits, custom: inMaster ? null : { pair: r.pair, warn: r.warn }, error: null };
  }
  const showError = r.error !== 'E-12' || (q.length >= COMPLETE_PAIR_LENGTH && hits.length === 0);
  return { hits, custom: null, error: showError ? r.error : null };
}
