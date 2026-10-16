/* =========================================================
   tests/choice-list.test.js
   選択肢の編集（js/choice-list.js）と、根拠・感情・タグの初期値の移動（js/master.js ← settings-store.js）のテスト
   （T-16。design.md 14.6.3・14.6.4、fx-rules.md 10.4、architecture 7.1）。
   ・名前のチェック（空白だけ・20文字以内・同じ名前は不可）・追加・削除・並び替え・ドラッグの行き先の計算
   ・通貨ペアの追加（E-12〜E-16・W-07）・最後の1つは削除できない・「通貨ペアを追加」シートの絞り込み
   ・初期値が master.js にあること、settings-store.js がそこから読むこと、壊れた値の補い方、保存と読み直し
   画面（document）も本物の localStorage も使わない（保存はにせものの保存場所で確かめる）ので、Node.js でもブラウザでも実行する。

   ID：CH-xx（選択肢の編集）
   ========================================================= */
import {
  checkChoiceName, addChoice, removeChoice, moveItem, dropIndex, withSelected,
  addFavoritePair, removeFavoritePair, searchPairCandidates,
} from '../js/choice-list.js';
import {
  DEFAULT_CHOICES, DEFAULT_FAVORITE_PAIRS, CHOICE_KINDS, CHOICE_KIND_LABELS, PAIR_MASTER, getPairSpec,
} from '../js/master.js';
import { createSettingsStore } from '../js/settings-store.js';
import { buildDetailView } from '../js/detail-view.js';
import { CHOICE_NAME_MAX_LENGTH, FAVORITE_GRID_COUNT } from '../js/config.js';
import { isAppError } from '../js/util.js';
import { sameArray, show } from './helpers.js';

const CATEGORY = '選択肢の編集';

const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run });

/** 確認項目を1つずつ照らし、1つでも違えば不合格にして違った項目を示す（他のテストファイルと同じ形） */
function verdict(checks) {
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) return { actual: `確認${checks.length}項目すべて一致`, pass: true };
  return { actual: failed.map(([label, , detail]) => `×${label}（実際：${show(detail)}）`).join('／'), pass: false };
}

/** にせものの保存場所（中身は Map）。failWrite を渡すと setItem が失敗する */
function fakeStorage({ failWrite = null } = {}) {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { if (failWrite) throw failWrite; map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}
const storeWith = (entries = {}) => {
  const storage = fakeStorage();
  for (const [k, v] of Object.entries(entries)) storage.map.set(`fxnote:${k}`, v);
  return { store: createSettingsStore({ storage, prefix: 'fxnote:' }), storage };
};

const FAVS = [...DEFAULT_FAVORITE_PAIRS];
const emoji20 = '🙂'.repeat(20);

export function collectChoiceListTests() {
  return [
    /* ---------- 初期値と種類（master.js） ---------- */
    t('CH-01', '根拠・感情・タグの初期値は master.js にある（requirements 6.3：6件・7件・3件、タグは6.1の例）', 'DEFAULT_CHOICES',
      'タグ＝ルール違反・指標前・様子見すべきだった。根拠6件・感情7件。書き換えできない（freeze）',
      () => verdict([
        ['タグ', sameArray([...DEFAULT_CHOICES.tags], ['ルール違反', '指標前', '様子見すべきだった']), DEFAULT_CHOICES.tags],
        ['根拠', sameArray([...DEFAULT_CHOICES.entryReasons],
          ['トレンドフォロー', '押し目買い・戻り売り', 'ブレイクアウト', 'レンジ逆張り', '経済指標・ニュース', 'その他']), DEFAULT_CHOICES.entryReasons],
        ['感情', sameArray([...DEFAULT_CHOICES.emotions], ['冷静', '自信', '不安', '焦り', '興奮', '取り返したい', '退屈']), DEFAULT_CHOICES.emotions],
        ['freeze', Object.isFrozen(DEFAULT_CHOICES) && Object.isFrozen(DEFAULT_CHOICES.tags), 'not frozen'],
      ])),

    t('CH-02', '設定の初期値は master.js から読む。読んだ配列を書き換えても master.js の初期値は変わらない',
      '何も保存されていない状態で get(\'choices\') のタグに追加', 'ST の初期値＝DEFAULT_CHOICES。追加しても master は3件のまま',
      () => {
        const { store } = storeWith();
        const c = store.get('choices');
        const same = ['entryReasons', 'emotions', 'tags'].every((k) => sameArray(c[k], [...DEFAULT_CHOICES[k]]));
        c.tags.push('追加');
        store.getDefault('choices').emotions.length = 0;
        return verdict([
          ['初期値が master と同じ', same, c],
          ['書き換えても master は不変', DEFAULT_CHOICES.tags.length === 3 && DEFAULT_CHOICES.emotions.length === 7, DEFAULT_CHOICES.tags],
          ['書き換えても次の get は初期値', store.get('choices').tags.length === 3 && store.get('choices').emotions.length === 7, store.get('choices')],
        ]);
      }),

    t('CH-03', '壊れた選択肢は master.js の初期値で補う（壊れた種類だけ。0件は正しい状態として残す）',
      '{"entryReasons":"x","emotions":["冷静",5,"冷静"],"tags":[]}', '根拠＝初期値6件・感情＝[冷静]（壊れた要素と重複を除く）・タグ＝[]（0件のまま）',
      () => {
        const c = storeWith({ choices: '{"entryReasons":"x","emotions":["冷静",5,"冷静"],"tags":[]}' }).store.get('choices');
        return verdict([
          ['根拠は初期値', sameArray(c.entryReasons, [...DEFAULT_CHOICES.entryReasons]), c.entryReasons],
          ['感情は壊れた要素だけ除く', sameArray(c.emotions, ['冷静']), c.emotions],
          ['タグ0件は残る', Array.isArray(c.tags) && c.tags.length === 0, c.tags],
        ]);
      }),

    t('CH-04', '選択肢の種類は4つ（URL の kind）で、画面名は設定画面の行と同じ（design 14.6.3）', 'CHOICE_KINDS・CHOICE_KIND_LABELS',
      'pairs / entryReasons / emotions / tags ＝ よく使う通貨ペア / エントリー根拠 / 感情 / タグ',
      () => verdict([
        ['種類', sameArray([...CHOICE_KINDS], ['pairs', 'entryReasons', 'emotions', 'tags']), CHOICE_KINDS],
        ['画面名', sameArray(CHOICE_KINDS.map((k) => CHOICE_KIND_LABELS[k]), ['よく使う通貨ペア', 'エントリー根拠', '感情', 'タグ']), CHOICE_KIND_LABELS],
        ['エントリー画面に並べる数は6', FAVORITE_GRID_COUNT === 6, FAVORITE_GRID_COUNT],
      ])),

    /* ---------- 名前のチェックと追加・削除 ---------- */
    t('CH-05', '追加：末尾に入り、元の配列は書き換えない', "addChoice(['指標前','ルール違反'], '焦り買い')", "['指標前','ルール違反','焦り買い']・元は2件のまま",
      () => {
        const base = ['指標前', 'ルール違反'];
        const r = addChoice(base, '焦り買い');
        return verdict([
          ['追加できた', r.ok === true && sameArray(r.list, ['指標前', 'ルール違反', '焦り買い']), r],
          ['名前', r.name === '焦り買い', r.name],
          ['元は変わらない', base.length === 2, base],
        ]);
      }),

    t('CH-06', '前後の空白（全角スペースも）は取り除いて追加。途中の空白は残す', "'　 前日高値 ブレイク　'", "名前 '前日高値 ブレイク'",
      () => {
        const r = addChoice([], '　 前日高値 ブレイク　');
        return verdict([['追加できた', r.ok === true && r.name === '前日高値 ブレイク', r]]);
      }),

    t('CH-07', '空白だけ・空は追加しない（error: empty。画面は文を出さず行を閉じる）', "''、'   '、'　'、undefined", 'すべて empty・配列は変わらない',
      () => verdict(['', '   ', '　', undefined].map((v) => {
        const r = addChoice(['a'], v);
        return [`${show(v)}→empty`, r.ok === false && r.error === 'empty', r];
      }))),

    t('CH-08', '20文字ちょうどは追加できる。21文字は too-long（「20文字以内で入力してください」）', "'あ'×20 ／ 'あ'×21", '追加できる ／ too-long',
      () => {
        const a = checkChoiceName('あ'.repeat(20), []);
        const b = checkChoiceName('あ'.repeat(21), []);
        return verdict([
          ['上限は20', CHOICE_NAME_MAX_LENGTH === 20, CHOICE_NAME_MAX_LENGTH],
          ['20文字', a.ok === true, a],
          ['21文字', b.ok === false && b.error === 'too-long', b],
          ['前後の空白は数えない', checkChoiceName(`  ${'あ'.repeat(20)}  `, []).ok === true, 'NG'],
        ]);
      }),

    t('CH-09', '文字数は人が数えるとおり（絵文字・𠮷 など2文字分の文字も1文字）', "'🙂'×20 ／ '🙂'×21 ／ '𠮷'×20", '追加できる ／ too-long ／ 追加できる',
      () => verdict([
        ['絵文字20', checkChoiceName(emoji20, []).ok === true, 'NG'],
        ['絵文字21', checkChoiceName(`${emoji20}🙂`, []).error === 'too-long', 'NG'],
        ['𠮷20', checkChoiceName('𠮷'.repeat(20), []).ok === true, 'NG'],
      ])),

    t('CH-10', '同じ名前は追加できない（duplicate。空白を取り除いてから比べる）。大文字小文字・全角半角は別の名前',
      "['ルール違反','FOMO'] に 'ルール違反'、' ルール違反 '、'fomo'", 'duplicate、duplicate、追加できる',
      () => {
        const base = ['ルール違反', 'FOMO'];
        return verdict([
          ['完全一致', addChoice(base, 'ルール違反').error === 'duplicate', 'NG'],
          ['前後の空白つき', addChoice(base, ' ルール違反 ').error === 'duplicate', 'NG'],
          ['大文字小文字は別', addChoice(base, 'fomo').ok === true, 'NG'],
        ]);
      }),

    t('CH-11', 'チェックの順は 空白だけ → 21文字以上 → 同じ名前（design 14.6.3 の表の順）', "21文字の名前がすでにある一覧に、同じ21文字／空白だけ",
      'too-long ／ empty',
      () => {
        const long21 = 'い'.repeat(21);
        return verdict([
          ['長さが先', checkChoiceName(long21, [long21]).error === 'too-long', 'NG'],
          ['空が先', checkChoiceName('  ', ['  ']).error === 'empty', 'NG'],
        ]);
      }),

    t('CH-12', '削除：その名前だけ消える。0件になってもよい。ない名前は何も変えない（根拠・感情・タグ）', "removeChoice(['a','b'], 'a') → 'b' を削除 → 'z'",
      "['b'] → [] → []", () => {
        const a = removeChoice(['a', 'b'], 'a');
        const b = removeChoice(a, 'b');
        return verdict([['a を削除', sameArray(a, ['b']), a], ['0件', b.length === 0, b], ['ない名前', removeChoice(b, 'z').length === 0, 'NG']]);
      }),

    /* ---------- 並び替え ---------- */
    t('CH-13', '並び替え：from 番目を to 番目へ。先頭→末尾・末尾→先頭・隣・同じ位置', "moveItem(['a','b','c','d'], …)",
      '0→2 = b,c,a,d ／ 3→0 = d,a,b,c ／ 1→2 = a,c,b,d ／ 2→2 = そのまま',
      () => {
        const base = ['a', 'b', 'c', 'd'];
        return verdict([
          ['0→2', sameArray(moveItem(base, 0, 2), ['b', 'c', 'a', 'd']), moveItem(base, 0, 2)],
          ['3→0', sameArray(moveItem(base, 3, 0), ['d', 'a', 'b', 'c']), moveItem(base, 3, 0)],
          ['1→2', sameArray(moveItem(base, 1, 2), ['a', 'c', 'b', 'd']), moveItem(base, 1, 2)],
          ['2→2', sameArray(moveItem(base, 2, 2), base), moveItem(base, 2, 2)],
          ['元は変わらない', sameArray(base, ['a', 'b', 'c', 'd']), base],
        ]);
      }),

    t('CH-14', '並び替え：範囲外は端にそろえる／動かす元の番号が範囲外なら何もしない', "moveItem(['a','b','c'], 0, 99) ／ (-5) ／ from=9",
      'b,c,a ／ そのまま ／ そのまま',
      () => {
        const base = ['a', 'b', 'c'];
        return verdict([
          ['行き先が大きすぎる', sameArray(moveItem(base, 0, 99), ['b', 'c', 'a']), moveItem(base, 0, 99)],
          ['行き先が小さすぎる', sameArray(moveItem(base, 2, -5), ['c', 'a', 'b']), moveItem(base, 2, -5)],
          ['元の番号が範囲外', sameArray(moveItem(base, 9, 0), base) && sameArray(moveItem(base, -1, 0), base), 'NG'],
        ]);
      }),

    t('CH-15', 'ドラッグの行き先：動かす行の真ん中が、ほかの行の真ん中を越えたところで入れ替わる', 'centers=[20,60,100,140]、1番目を動かす',
      'y=60→1、y=15→0、y=101→2、y=200→3、ちょうど真ん中（100）はまだ動かない',
      () => {
        const c = [20, 60, 100, 140];
        return verdict([
          ['動かさない', dropIndex(c, 1, 60) === 1, dropIndex(c, 1, 60)],
          ['先頭へ', dropIndex(c, 1, 15) === 0, dropIndex(c, 1, 15)],
          ['1つ下へ', dropIndex(c, 1, 101) === 2, dropIndex(c, 1, 101)],
          ['最下部へ', dropIndex(c, 1, 200) === 3, dropIndex(c, 1, 200)],
          ['境目ちょうど', dropIndex(c, 1, 100) === 1, dropIndex(c, 1, 100)],
          ['先頭の行を上へ', dropIndex(c, 0, -50) === 0, dropIndex(c, 0, -50)],
          ['末尾の行を下へ', dropIndex(c, 3, 999) === 3, dropIndex(c, 3, 999)],
        ]);
      }),

    /* ---------- 通貨ペアの追加（fx-rules 10.4） ---------- */
    t('CH-16', '通貨ペアの追加：正規化して末尾へ（小文字・全角・区切りなし・-・_）', "'sgd/jpy'、'ＥＵＲ／ＡＵＤ'、'usdsek'、'eur-chf'、'GBP_NZD'",
      'SGD/JPY・EUR/AUD・USD/SEK・EUR/CHF・GBP/NZD（どれも確認済み通貨なので警告なし）',
      () => verdict([['sgd/jpy', 'SGD/JPY'], ['ＥＵＲ／ＡＵＤ', 'EUR/AUD'], ['usdsek', 'USD/SEK'], ['eur-chf', 'EUR/CHF'], ['GBP_NZD', 'GBP/NZD']].map(([input, pair]) => {
        const r = addFavoritePair(FAVS, input);
        return [`${input}→${pair}`, r.ok === true && r.pair === pair && r.warn.length === 0
          && r.list.length === 7 && r.list[6] === pair && sameArray(r.list.slice(0, 6), FAVS), r];
      }))),

    t('CH-17', 'E-12：英字3文字＋英字3文字の形でない（追加しない）', "''、'USD'、'EUR/US'、'EURUSDX'、'1234'、'US/DJPY1'", 'すべて E-12・一覧は変わらない',
      () => verdict(['', 'USD', 'EUR/US', 'EURUSDX', '1234', 'US/DJPY1'].map((v) => {
        const r = addFavoritePair(FAVS, v);
        return [`${show(v)}→E-12`, r.ok === false && r.error === 'E-12' && r.list === undefined, r];
      }))),

    t('CH-18', 'E-13：貴金属・暗号資産（FX以外）。E-14：同じ通貨どうし。E-15：円が左側。E-16：登録済み',
      "'XAU/USD'、'BTCJPY'、'USD/USD'、'JPY/USD'、'usd-jpy'（登録済み）", 'E-13、E-13、E-14、E-15、E-16',
      () => verdict([['XAU/USD', 'E-13'], ['BTCJPY', 'E-13'], ['USD/USD', 'E-14'], ['JPY/USD', 'E-15'], ['usd-jpy', 'E-16']].map(([v, code]) => {
        const r = addFavoritePair(FAVS, v);
        return [`${v}→${code}`, r.ok === false && r.error === code, r];
      }))),

    t('CH-19', 'チェックの順：E-12 → E-13 → E-14 → E-15 → E-16（最初に当てはまったもので止まる）', "'XAU/XAU'、'JPY/JPY'、'XAU/JPY'", 'E-13、E-14、E-13',
      () => verdict([['XAU/XAU', 'E-13'], ['JPY/JPY', 'E-14'], ['XAU/JPY', 'E-13']].map(([v, code]) => {
        const r = addFavoritePair(FAVS, v);
        return [`${v}→${code}`, r.error === code, r.error];
      }))),

    t('CH-20', 'W-07：確認済みでない通貨を含むペアは、警告つきで追加できる（USD/HUF）。確認済み通貨どうしなら警告なし（AUD/NZD）',
      "'usd/huf'、'EUR/PLN'（確認済み）、'AUD/NZD'（マスタにないが確認済み）", 'HUF だけ W-07',
      () => {
        const huf = addFavoritePair(FAVS, 'usd/huf');
        const pln = addFavoritePair(FAVS, 'EUR/PLN');
        const nzd = addFavoritePair(FAVS, 'AUD/NZD');
        return verdict([
          ['USD/HUF は追加でき W-07', huf.ok === true && sameArray(huf.warn, ['W-07']) && huf.list[6] === 'USD/HUF', huf],
          ['EUR/PLN は警告なし', pln.ok === true && pln.warn.length === 0, pln],
          ['AUD/NZD は警告なし', nzd.ok === true && nzd.warn.length === 0, nzd],
        ]);
      }),

    t('CH-21', '追加したペアはマスタにも設定キーにも増やさない（pip単位は pair の文字列から毎回求まる：fx-rules 10.4）',
      "addFavoritePair(FAVS, 'SGD/JPY') のあと getPairSpec('SGD/JPY')", 'マスタは19ペアのまま。pip 0.01・3桁・日本語名は pair そのまま',
      () => {
        const before = PAIR_MASTER.length;
        addFavoritePair(FAVS, 'SGD/JPY');
        const s = getPairSpec('SGD/JPY');
        return verdict([
          ['マスタは増えない', PAIR_MASTER.length === before && before === 19, PAIR_MASTER.length],
          ['pip単位・桁数', s.pipSize === 0.01 && s.priceDecimals === 3 && s.inMaster === false && s.nameJa === 'SGD/JPY', s],
        ]);
      }),

    t('CH-22', '通貨ペアの削除：1つ減る。最後の1つは削除できない（last）。登録にないペアは何も変えない',
      "6つから1つ削除／1つだけの一覧から削除／登録にないペア", '5つ／{ok:false, error:last}／そのまま',
      () => {
        const five = removeFavoritePair(FAVS, 'EUR/USD');
        const last = removeFavoritePair(['USD/JPY'], 'USD/JPY');
        const none = removeFavoritePair(['USD/JPY'], 'EUR/USD');
        return verdict([
          ['1つ削除', five.ok === true && five.list.length === 5 && !five.list.includes('EUR/USD'), five],
          ['最後の1つ', last.ok === false && last.error === 'last', last],
          ['登録にない', none.ok === true && sameArray(none.list, ['USD/JPY']), none],
          ['元は変わらない', FAVS.length === 6, FAVS],
        ]);
      }),

    t('CH-23', '7つ目以降があるとき、並び替えで上から6つが入れ替わる（エントリー画面に並ぶのは先頭6つ）', '8つの一覧で 7番目（index 6）を先頭へ',
      '先頭6つに入り、元の6番目が7番目に押し出される',
      () => {
        const eight = [...FAVS, 'CHF/JPY', 'NZD/JPY'];
        const moved = moveItem(eight, 6, 0);
        return verdict([
          ['先頭', moved[0] === 'CHF/JPY', moved],
          ['上から6つ', sameArray(moved.slice(0, FAVORITE_GRID_COUNT), ['CHF/JPY', ...FAVS.slice(0, 5)]), moved.slice(0, 6)],
          ['6番目が押し出される', moved[6] === 'GBP/USD', moved[6]],
        ]);
      }),

    /* ---------- 「通貨ペアを追加」シートの絞り込み ---------- */
    t('CH-24', 'シート：検索欄が空なら、登録済みを除くマスタの13ペアがマスタの順で並ぶ', "searchPairCandidates(初期の6ペア, '')",
      '13ペア・先頭 AUD/USD・USD/JPY など登録済みは含まない・追加の行もエラーもなし',
      () => {
        const r = searchPairCandidates(FAVS, '');
        const pairs = r.hits.map((p) => p.pair);
        return verdict([
          ['13ペア', pairs.length === 13, pairs.length],
          ['先頭は AUD/USD', pairs[0] === 'AUD/USD', pairs[0]],
          ['登録済みは除く', FAVS.every((p) => !pairs.includes(p)), pairs],
          ['日本語名つき', r.hits[0].nameJa === '豪ドル/米ドル', r.hits[0]],
          ['追加の行・エラーなし', r.custom === null && r.error === null, r],
        ]);
      }),

    t('CH-25', 'シート：ペア名・日本語名で絞る（大文字小文字・全角半角・区切りは無視）', "'ユーロ'、'eur aud'、'ＥＵＲ／ＡＵＤ'、'chf'",
      'EUR/GBP・EUR/AUD ／ EUR/AUD ／ EUR/AUD ／ USD/CHF・CHF/JPY',
      () => {
        const p = (q) => searchPairCandidates(FAVS, q).hits.map((x) => x.pair);
        return verdict([
          ['ユーロ', sameArray(p('ユーロ'), ['EUR/GBP', 'EUR/AUD']), p('ユーロ')],
          ['eur aud', sameArray(p('eur aud'), ['EUR/AUD']), p('eur aud')],
          ['ＥＵＲ／ＡＵＤ', sameArray(p('ＥＵＲ／ＡＵＤ'), ['EUR/AUD']), p('ＥＵＲ／ＡＵＤ')],
          ['chf', sameArray(p('chf'), ['USD/CHF', 'CHF/JPY']), p('chf')],
        ]);
      }),

    t('CH-26', 'シート：マスタにないペアの形なら先頭に「追加」の行（custom）。W-07 のときは warn に入る。マスタにあるペアは行を出さない',
      "'sgd/jpy'、'USD/HUF'、'EURAUD'", 'SGD/JPY（警告なし）、USD/HUF（W-07）、custom なし（hits の EUR/AUD から選ぶ）',
      () => {
        const a = searchPairCandidates(FAVS, 'sgd/jpy');
        const b = searchPairCandidates(FAVS, 'USD/HUF');
        const c = searchPairCandidates(FAVS, 'EURAUD');
        return verdict([
          ['SGD/JPY', a.custom && a.custom.pair === 'SGD/JPY' && a.custom.warn.length === 0 && a.error === null, a],
          ['USD/HUF', b.custom && b.custom.pair === 'USD/HUF' && sameArray(b.custom.warn, ['W-07']), b],
          ['EURAUD', c.custom === null && c.hits.length === 1 && c.hits[0].pair === 'EUR/AUD', c],
        ]);
      }),

    t('CH-27', 'シート：E-13〜E-16 は検索欄の下の赤字（error）。「追加」の行は出さない', "'usd/jpy'（登録済み）、'xauusd'、'USD/USD'、'JPYUSD'",
      'E-16、E-13、E-14、E-15',
      () => verdict([['usd/jpy', 'E-16'], ['xauusd', 'E-13'], ['USD/USD', 'E-14'], ['JPYUSD', 'E-15']].map(([q, code]) => {
        const r = searchPairCandidates(FAVS, q);
        return [`${q}→${code}`, r.error === code && r.custom === null, r];
      }))),

    t('CH-28', 'シート：入力の途中では E-12 を出さない。6文字以上で候補もないときだけ出す',
      "'EUR'（候補あり）、'ZZ'、'USD/JP'（5文字）、'QWERTYU'、'スイスフラン'（6文字・候補あり）", 'エラーなし ×3 → E-12 → エラーなし',
      () => {
        const e = (q) => searchPairCandidates(FAVS, q).error;
        return verdict([
          ['EUR', e('EUR') === null, e('EUR')],
          ['ZZ', e('ZZ') === null, e('ZZ')],
          ['USD/JP', e('USD/JP') === null, e('USD/JP')],
          ['QWERTYU', e('QWERTYU') === 'E-12', e('QWERTYU')],
          ['スイスフラン（候補あり）', e('スイスフラン') === null && searchPairCandidates(FAVS, 'スイスフラン').hits.length === 2, e('スイスフラン')],
        ]);
      }),

    t('CH-29', 'シート：全ペアを登録済みなら一覧は空（シートは「追加できる通貨ペアはありません」を出す）', 'マスタ19ペアすべてが登録済み',
      'hits が0件',
      () => {
        const all = PAIR_MASTER.map((p) => p.pair);
        const r = searchPairCandidates(all, '');
        return verdict([['0件', r.hits.length === 0 && r.custom === null && r.error === null, r]]);
      }),

    /* ---------- 保存と読み直し・既存の記録の表示 ---------- */
    t('CH-30', '保存して読み直す：削除・追加・並び替えの結果がそのまま戻る。ほかの種類は巻き込まない',
      "choices のタグを削除・根拠を並び替えて保存 → 読み直し", 'タグ=[指標前]・根拠は先頭が入れ替わる・感情は初期値のまま',
      () => {
        const { store } = storeWith();
        const cur = store.get('choices');
        store.set('choices', { ...cur, tags: removeChoice(cur.tags, 'ルール違反'), entryReasons: moveItem(cur.entryReasons, 5, 0) });
        const back = store.get('choices');
        return verdict([
          ['タグ', sameArray(back.tags, ['指標前', '様子見すべきだった']), back.tags],
          ['根拠', back.entryReasons[0] === 'その他' && back.entryReasons.length === 6, back.entryReasons],
          ['感情は不変', sameArray(back.emotions, [...DEFAULT_CHOICES.emotions]), back.emotions],
        ]);
      }),

    t('CH-31', '選択肢を0件にして保存しても、読み直すと0件のまま（初期値に戻らない）。よく使う通貨ペアは0件を保存できない',
      "tags=[] を保存 ／ favoritePairs=[] を保存しようとする", 'タグ=[] ／ TypeError・保存されない',
      () => {
        const { store, storage } = storeWith();
        store.set('choices', { ...store.get('choices'), tags: [] });
        let err = null;
        try { store.set('favoritePairs', []); } catch (e) { err = e; }
        return verdict([
          ['0件のまま', store.get('choices').tags.length === 0, store.get('choices').tags],
          ['通貨ペア0件は保存しない', err instanceof TypeError && storage.map.get('fxnote:favoritePairs') === undefined, err && err.name],
        ]);
      }),

    t('CH-32', '保存値の名前も同じルールで確かめる：21文字以上・重複は読むときに除く。絵文字20個は残る（入力時と同じ数え方）',
      `tags=["${'あ'.repeat(21)}","指標前","指標前","${emoji20}"]`, '[指標前, 絵文字20個]',
      () => {
        const raw = JSON.stringify({ entryReasons: ['a'], emotions: ['b'], tags: ['あ'.repeat(21), '指標前', '指標前', emoji20] });
        const c = storeWith({ choices: raw }).store.get('choices');
        return verdict([['タグ', sameArray(c.tags, ['指標前', emoji20]), c.tags]]);
      }),

    t('CH-33', '保存できないとき（容量不足）は SETTINGS_WRITE。保存済みの値は変わらない', 'setItem が失敗する保存場所で set(\'choices\', …)',
      'AppError SETTINGS_WRITE・読み直しは初期値のまま',
      () => {
        const storage = fakeStorage({ failWrite: new Error('QuotaExceededError') });
        const store = createSettingsStore({ storage, prefix: 'fxnote:' });
        let err = null;
        try { store.set('choices', { ...store.get('choices'), tags: ['新しい'] }); } catch (e) { err = e; }
        return verdict([
          ['SETTINGS_WRITE', isAppError(err, 'SETTINGS_WRITE'), err && err.code],
          ['値は変わらない', sameArray(store.get('choices').tags, [...DEFAULT_CHOICES.tags]), store.get('choices').tags],
        ]);
      }),

    t('CH-34', '決済・編集の画面：設定から削除された選択済みの値も、選択肢の末尾に残る（選択済みのチップが消えない）',
      "withSelected(['指標前'], ['ルール違反','指標前','ルール違反'])", '[指標前, ルール違反]（重複なし）。選択肢そのものは変えない',
      () => {
        const options = ['指標前'];
        const r = withSelected(options, ['ルール違反', '指標前', 'ルール違反']);
        return verdict([
          ['末尾に足す', sameArray(r, ['指標前', 'ルール違反']), r],
          ['元は変わらない', sameArray(options, ['指標前']), options],
          ['選択済みがなければそのまま', sameArray(withSelected(options, []), ['指標前']), 'NG'],
        ]);
      }),

    t('CH-35', '詳細画面：設定から削除された根拠・タグ・感情も、記録の表示は変わらない（記録は名前を文字のまま持つ）',
      "設定には無い根拠『旧・根拠』・タグ『旧タグ』・感情『旧感情』を持つ記録", "根拠 '旧・根拠'、タグ '旧タグ'、感情 '旧感情' がそのまま出る",
      () => {
        const trade = {
          id: 'x1', accountType: 'demo', pair: 'USD/JPY', side: 'buy', entryPrice: 150.1, entryAt: '2026-10-15T21:30:00+09:00',
          lots: 1, lotUnitSize: 10000, status: 'open', entryReasons: ['旧・根拠'], emotion: '旧感情', tags: ['旧タグ'], imageIds: [],
          slPrice: null, tpPrice: null, riskReward: null, timeframe: null, session: null, memo: null,
          exitPrice: null, exitAt: null, exitReason: null, exitEmotion: null, pips: null, profitJpy: null, profitSource: null,
          quoteToJpyRate: null, createdAt: '2026-10-15T21:30:00+09:00', updatedAt: '2026-10-15T21:30:00+09:00', deletedAt: null,
        };
        const v = buildDetailView(trade, new Date('2026-10-15T23:30:00+09:00'));
        const rows = v.sections.flatMap((s) => s.rows);
        const val = (k) => (rows.find((r) => r.key === k) || {}).value;
        return verdict([
          ['根拠', val('entryReasons') === '旧・根拠', val('entryReasons')],
          ['感情', val('emotion') === '旧感情', val('emotion')],
          ['タグ', val('tags') === '旧タグ', val('tags')],
        ]);
      }),
  ];
}
