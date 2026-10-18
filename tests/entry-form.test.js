/* =========================================================
   tests/entry-form.test.js
   エントリー記録画面②（任意項目）の「画面に依存しない部分」のテスト（T-18。design.md 14.1、fx-rules.md 5・8・11章）。
     ・js/entry-form.js … セッションの自動判定と手動の優先・下書きの読み直し（T-17 の古い下書きも）・「変更あり」の判定・
                          リスクリワードの表示（design 14.1.7 の表）・警告（W-01・W-03・W-06）・エラー（E-01〜E-04）・保存する任意項目の組み立て
     ・js/calc.js の calcSlTpPips … 損切り幅・利確幅（pips）。fx-rules 9.2 の列は tests/calc.test.js（R-01〜R-09）で確かめる。ここは境界・空の値
     ・js/trades.js の recompute … 任意項目から riskReward・session を決め直す（SL/TP が空なら RR を保存しない）
     ・js/choice-list.js の planTagAdd … 入力画面の「＋追加」でタグを足すときの判断（名前のチェックは T-16 と共通）
     ・T-33：ロット欄の見本が数字でないこと（U-01）、記録0件のときの「1lot＝1万通貨で計算します」の文（U-02）、
       価格・ロットの上限のエラー文（R-01：E-17・E-18）、2000〜2099 年の外の日時（R-09）
   画面（document）も IndexedDB も localStorage も使わないので、Node.js でもブラウザでも実行する。
   「＋追加」の設定への保存・チップの増減は画面の部品（ui/tag-picker.js）なので、ブラウザで目で確かめる。

   ID：EF-xx（エントリー画面の任意項目）
   ========================================================= */
import {
  autoSession, nextSession, sessionNote, defaultOptionalFields, cloneFields, fieldsFromEntryDraft, isEntryChanged,
  entryDetailsSummary, ENTRY_DETAILS_LIST, evaluateLevels, visibleIssues, buildOptionalInput, RR_HINT, TIMEFRAMES, SESSIONS,
  LOTS_PLACEHOLDER, lotUnitHint, checkRequiredFields,
} from '../js/entry-form.js';
import { calcSlTpPips } from '../js/calc.js';
import { recompute, normalizeTrade } from '../js/trades.js';
import { TRADE_KEYS } from '../js/db.js';
import { planTagAdd, CHOICE_NAME_ERROR_TEXTS } from '../js/choice-list.js';
import { CHOICE_NAME_MAX_LENGTH } from '../js/config.js';
import { sameArray, show } from './helpers.js';

const CATEGORY = 'エントリー画面';

const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run });

/** 確認項目を1つずつ照らし、1つでも違えば不合格にして違った項目を示す（他のテストファイルと同じ形） */
function verdict(checks) {
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) return { actual: `確認${checks.length}項目すべて一致`, pass: true };
  return { actual: failed.map(([label, , detail]) => `×${label}（実際：${show(detail)}）`).join('／'), pass: false };
}

/** 2026-10-15（木）21:30（日本時間）。夏時間の期間で、ニューヨークは 8:30＝セッション newyork */
const AT_NY = '2026-10-15T21:30';
/** 2026-10-15（木）10:00（日本時間）＝ tokyo */
const AT_TOKYO = '2026-10-15T10:00';

/** 入力欄の値（USD/JPY 買い 150.000・1lot）。over で上書き */
function fieldsOf(over = {}) {
  return {
    accountType: 'real', pair: 'USD/JPY', side: 'buy', entryPrice: '150.000', lots: '1', entryAt: AT_NY,
    ...defaultOptionalFields(AT_NY),
    ...over,
  };
}

const texts = (lv, type) => lv.issues.filter((i) => !type || i.type === type).map((i) => `${i.field}/${i.type}/${i.text}`);

export function collectEntryFormTests() {
  return [
    /* ---------- セッション（fx-rules 11.7 の再判定のタイミング） ---------- */
    t('EF-01', 'セッションは日時欄の値（日本時間）から自動判定する。空・読めない日時は未選択', `autoSession('${AT_NY}') など`,
      "'newyork'・10:00 は 'tokyo'・'' と 'abc' は ''",
      () => verdict([
        ['21:30 は newyork', autoSession(AT_NY) === 'newyork', autoSession(AT_NY)],
        ['10:00 は tokyo', autoSession(AT_TOKYO) === 'tokyo', autoSession(AT_TOKYO)],
        ['空は未選択', autoSession('') === '', autoSession('')],
        ['読めない値は未選択', autoSession('abc') === '', autoSession('abc')],
      ])),

    t('EF-02', '日時を変えたとき、セッションが自動のままなら判定し直す', `nextSession('${AT_NY}', '${AT_TOKYO}', 'newyork')`, "'tokyo'",
      () => {
        const r = nextSession(AT_NY, AT_TOKYO, 'newyork');
        return verdict([['自動のまま追従', r === 'tokyo', r]]);
      }),

    t('EF-03', '手で選んだセッションは、日時を変えても上書きしない', `nextSession('${AT_NY}', '${AT_TOKYO}', 'london')`, "'london'（手動を優先）",
      () => {
        const r = nextSession(AT_NY, AT_TOKYO, 'london');
        return verdict([
          ['手動のまま', r === 'london', r],
          ['続けて日時を変えても手動のまま', nextSession(AT_TOKYO, AT_NY, r) === 'london', nextSession(AT_TOKYO, AT_NY, r)],
        ]);
      }),

    t('EF-04', '日時を空にして入れ直すと、自動のセッションは未選択を経て判定し直す', "nextSession(AT_NY, '', 'newyork') → '' → nextSession('', AT_TOKYO, '')", "'' のあと 'tokyo'",
      () => {
        const cleared = nextSession(AT_NY, '', 'newyork');
        const back = nextSession('', AT_TOKYO, cleared);
        return verdict([['空にすると未選択', cleared === '', cleared], ['入れ直すと判定', back === 'tokyo', back]]);
      }),

    t('EF-05', 'セッション欄の下の説明：自動／手動／日時が空', 'sessionNote(fields)',
      '「エントリー日時から自動で判定しました。」「手動で選択しました。」「エントリー日時を入れると自動で判定します。」',
      () => verdict([
        ['自動', sessionNote(fieldsOf()) === 'エントリー日時から自動で判定しました。', sessionNote(fieldsOf())],
        ['手動', sessionNote(fieldsOf({ session: 'tokyo' })) === '手動で選択しました。', sessionNote(fieldsOf({ session: 'tokyo' }))],
        ['日時が空', sessionNote(fieldsOf({ entryAt: '', session: '' })) === 'エントリー日時を入れると自動で判定します。', sessionNote(fieldsOf({ entryAt: '', session: '' }))],
      ])),

    /* ---------- 初期値・下書きの読み直し（T-17 の下書きの形の拡張・後方互換） ---------- */
    t('EF-06', '任意項目の初期値は空。セッションだけ日時から自動判定', `defaultOptionalFields('${AT_NY}')`,
      "SL・TP・時間足・感情・メモは ''、根拠・タグは []、セッションは 'newyork'",
      () => {
        const d = defaultOptionalFields(AT_NY);
        return verdict([
          ['文字の項目は空', ['slPrice', 'tpPrice', 'timeframe', 'emotion', 'memo'].every((k) => d[k] === ''), d],
          ['配列は空', d.entryReasons.length === 0 && d.tags.length === 0, d],
          ['セッション', d.session === 'newyork', d.session],
        ]);
      }),

    t('EF-07', 'T-17 の古い下書き（任意項目のキーなし）も復元できる。セッションは下書きの日時から判定する',
      '下書き fields に必須6項目だけ（日時は 10:00）', '任意項目は初期値（空）、セッションは tokyo（今の時刻の判定を持ち込まない）',
      () => {
        const defaults = fieldsOf({ entryAt: AT_NY });
        const old = { fields: { accountType: 'demo', pair: 'EUR/USD', side: 'sell', entryPrice: '1.08500', lots: '0.5', entryAt: AT_TOKYO } };
        const r = fieldsFromEntryDraft(old, defaults);
        return verdict([
          ['必須は下書きの値', r.accountType === 'demo' && r.pair === 'EUR/USD' && r.side === 'sell' && r.entryPrice === '1.08500' && r.lots === '0.5' && r.entryAt === AT_TOKYO, r],
          ['任意は空', r.slPrice === '' && r.tpPrice === '' && r.memo === '' && r.entryReasons.length === 0 && r.tags.length === 0, r],
          ['セッションは下書きの日時で判定', r.session === 'tokyo', r.session],
        ]);
      }),

    t('EF-08', '任意項目を含む下書きは、そのまま復元できる（手で選んだセッションも）', '下書き fields に SL・TP・根拠・時間足・セッション・感情・タグ・メモ',
      '同じ値に戻る。配列は元の下書きと別のコピー',
      () => {
        const defaults = fieldsOf();
        const saved = {
          ...fieldsOf({ slPrice: '149.800', tpPrice: '150.400', entryReasons: ['ブレイクアウト', 'その他'], timeframe: 'M15', session: 'london', emotion: '冷静', tags: ['指標前'], memo: '上抜け\n2行目' }),
        };
        const r = fieldsFromEntryDraft({ fields: saved }, defaults);
        return verdict([
          ['SL・TP', r.slPrice === '149.800' && r.tpPrice === '150.400', [r.slPrice, r.tpPrice]],
          ['根拠', sameArray(r.entryReasons, ['ブレイクアウト', 'その他']), r.entryReasons],
          ['時間足・セッション・感情', r.timeframe === 'M15' && r.session === 'london' && r.emotion === '冷静', [r.timeframe, r.session, r.emotion]],
          ['タグ・メモ', sameArray(r.tags, ['指標前']) && r.memo === '上抜け\n2行目', [r.tags, r.memo]],
          ['配列はコピー', r.entryReasons !== saved.entryReasons && r.tags !== saved.tags, 'NG'],
        ]);
      }),

    t('EF-09', '壊れた下書きでも止まらない：知らない時間足・セッション、文字でない値、重複を取り除く',
      "timeframe 'X1'・session 'zzz'・entryReasons ['a', 1, 'a']・tags 'x'・slPrice 5", '時間足は未選択、セッションは日時から判定、根拠は [a]、タグは []、SL は空',
      () => {
        const defaults = fieldsOf();
        const r = fieldsFromEntryDraft({ fields: { timeframe: 'X1', session: 'zzz', entryReasons: ['a', 1, 'a'], tags: 'x', slPrice: 5, side: 'up' } }, defaults);
        return verdict([
          ['時間足', r.timeframe === '', r.timeframe],
          ['セッション', r.session === autoSession(r.entryAt), r.session],
          ['根拠', sameArray(r.entryReasons, ['a']), r.entryReasons],
          ['タグ', sameArray(r.tags, []), r.tags],
          ['SL', r.slPrice === '', r.slPrice],
          ['売買方向', r.side === '', r.side],
          ['null の下書き', fieldsFromEntryDraft(null, defaults).pair === 'USD/JPY', 'NG'],
        ]);
      }),

    t('EF-10', '下書きの読み直しで、初期値の配列を書き換えない（次に開く画面の初期値が汚れない）', 'cloneFields と fieldsFromEntryDraft の結果に push', '元の初期値の配列は空のまま',
      () => {
        const defaults = fieldsOf();
        const a = cloneFields(defaults);
        const b = fieldsFromEntryDraft({ fields: {} }, defaults);
        a.tags.push('x');
        b.entryReasons.push('y');
        return verdict([['初期値は空のまま', defaults.tags.length === 0 && defaults.entryReasons.length === 0, defaults]]);
      }),

    t('EF-11', '「変更あり」の判定：開いただけでは変更なし。任意項目の変更も変更あり。選んだ順・外して付け直しは変更なし', 'isEntryChanged(initial, fields)',
      '変更なし／SL・時間足・セッション・感情・メモ・根拠・タグの変更は変更あり',
      () => {
        const initial = fieldsOf();
        const same = cloneFields(initial);
        const changed = (over) => isEntryChanged(initial, fieldsOf(over));
        const tagsAB = fieldsOf({ tags: ['a', 'b'] });
        const tagsBA = fieldsOf({ tags: ['b', 'a'] });
        return verdict([
          ['開いただけ', !isEntryChanged(initial, same), 'NG'],
          ['SL', changed({ slPrice: '149.8' }), 'NG'],
          ['TP', changed({ tpPrice: '150.4' }), 'NG'],
          ['時間足', changed({ timeframe: 'H1' }), 'NG'],
          ['セッション', changed({ session: 'tokyo' }), 'NG'],
          ['感情', changed({ emotion: '冷静' }), 'NG'],
          ['メモ', changed({ memo: 'a' }), 'NG'],
          ['根拠', changed({ entryReasons: ['その他'] }), 'NG'],
          ['タグ', changed({ tags: ['指標前'] }), 'NG'],
          ['必須（価格）', changed({ entryPrice: '150.1' }), 'NG'],
          ['タグの順番だけ違う', !isEntryChanged(tagsAB, tagsBA), 'NG'],
        ]);
      }),

    t('EF-12', '詳細を閉じているときの2行目：入力済みの項目名（セッションは自動のままなら数えない）', 'entryDetailsSummary(fields)',
      `何もなければ「${ENTRY_DETAILS_LIST}」、あれば「SL・TP、メモ 入力済み」のように`,
      () => verdict([
        ['何もなし', entryDetailsSummary(fieldsOf()) === ENTRY_DETAILS_LIST, entryDetailsSummary(fieldsOf())],
        ['SL・TP とメモ', entryDetailsSummary(fieldsOf({ slPrice: '149.8', memo: 'x' })) === 'SL・TP、メモ 入力済み', entryDetailsSummary(fieldsOf({ slPrice: '149.8', memo: 'x' }))],
        ['画像だけ（T-24：枚数は fields の外から渡す）', entryDetailsSummary(fieldsOf(), 1) === '画像 入力済み' && entryDetailsSummary(fieldsOf({ memo: 'x' }), 2) === 'メモ、画像 入力済み', entryDetailsSummary(fieldsOf(), 1)],
        ['TP だけでも SL・TP', entryDetailsSummary(fieldsOf({ tpPrice: '150.4' })) === 'SL・TP 入力済み', entryDetailsSummary(fieldsOf({ tpPrice: '150.4' }))],
        ['全部', entryDetailsSummary(fieldsOf({ slPrice: '1', entryReasons: ['a'], timeframe: 'M5', session: 'tokyo', emotion: 'b', tags: ['c'], memo: 'd' })) === 'SL・TP、根拠、時間足、セッション、感情、タグ、メモ 入力済み',
          entryDetailsSummary(fieldsOf({ slPrice: '1', entryReasons: ['a'], timeframe: 'M5', session: 'tokyo', emotion: 'b', tags: ['c'], memo: 'd' }))],
        ['選択肢の並び', TIMEFRAMES.join() === 'M1,M5,M15,M30,H1,H4,D1,W1' && SESSIONS.join() === 'tokyo,london,newyork,other', 'NG'],
      ])),

    /* ---------- リスクリワードの表示（design 14.1.7 の表） ---------- */
    t('EF-13', 'RR：買い・正しい並び（JPY）', 'USD/JPY 買い 150.000／SL 149.800／TP 150.400', "RR '2.00'・2行目『損切り 20.0 pips・利確 40.0 pips』・エラー警告なし",
      () => {
        const lv = evaluateLevels(fieldsOf({ slPrice: '149.800', tpPrice: '150.400' }));
        return verdict([
          ['値', lv.rr.value === '2.00', lv.rr.value],
          ['2行目', lv.rr.sub === '損切り 20.0 pips・利確 40.0 pips', lv.rr.sub],
          ['警告なし', lv.issues.length === 0, texts(lv)],
          ['保存する値', lv.slPrice === 149.8 && lv.tpPrice === 150.4, [lv.slPrice, lv.tpPrice]],
        ]);
      }),

    t('EF-14', 'RR：売り・非JPY・割り切れない（R-02 と同じ）', 'EUR/USD 売り 1.08500／SL 1.08650／TP 1.08100', "RR '2.67'・『損切り 15.0 pips・利確 40.0 pips』",
      () => {
        const lv = evaluateLevels(fieldsOf({ pair: 'EUR/USD', side: 'sell', entryPrice: '1.08500', slPrice: '1.08650', tpPrice: '1.08100' }));
        return verdict([['値', lv.rr.value === '2.67', lv.rr.value], ['2行目', lv.rr.sub === '損切り 15.0 pips・利確 40.0 pips', lv.rr.sub], ['警告なし', lv.issues.length === 0, texts(lv)]]);
      }),

    t('EF-15', '全角で入力しても計算できる（8.1 の正規化）', "SL '１４９．８００'・TP '１５０．４００'", "RR '2.00'",
      () => {
        const lv = evaluateLevels(fieldsOf({ slPrice: '１４９．８００', tpPrice: '１５０．４００' }));
        return verdict([['値', lv.rr.value === '2.00', lv.rr.value]]);
      }),

    t('EF-16', 'RR：SL・TP のどちらかが空 → 「—」＋「SLとTPの両方を入れると計算します」', 'SL だけ／TP だけ／両方空', 'どれも —・案内・警告なし',
      () => {
        const a = evaluateLevels(fieldsOf({ slPrice: '149.800' }));
        const b = evaluateLevels(fieldsOf({ tpPrice: '150.400' }));
        const c = evaluateLevels(fieldsOf());
        return verdict([
          ['SL だけ', a.rr.value === '—' && a.rr.sub === RR_HINT.needBoth && a.issues.length === 0, [a.rr, texts(a)]],
          ['TP だけ', b.rr.value === '—' && b.rr.sub === RR_HINT.needBoth && b.issues.length === 0, [b.rr, texts(b)]],
          ['両方空', c.rr.value === '—' && c.rr.sub === RR_HINT.needBoth, c.rr],
        ]);
      }),

    t('EF-17', 'SL だけ・TP だけを（方向と矛盾する値で）先に入れた途中に、誤った警告 W-01 を出さない', '買い・SL 150.200（利益側）だけ／売り・TP 150.100（損失側）だけ', '警告なし（fx-rules 5.1・5.3）',
      () => {
        const a = evaluateLevels(fieldsOf({ slPrice: '150.200' }));
        const b = evaluateLevels(fieldsOf({ side: 'sell', tpPrice: '150.100' }));
        return verdict([['SL だけ', a.issues.length === 0, texts(a)], ['TP だけ', b.issues.length === 0, texts(b)]]);
      }),

    t('EF-18', 'RR：エントリー価格が空（SL・TP を先に入れた）→ 「—」＋案内、誤った警告 W-01 を出さない（Y-08・Y-09 の画面側）', '買い・エントリー価格 空・SL 149.800・TP 150.400／売り・SL 150.200・TP 149.600',
      '案内『エントリー価格と売買方向を入れると計算します』・警告なし',
      () => {
        const a = evaluateLevels(fieldsOf({ entryPrice: '', slPrice: '149.800', tpPrice: '150.400' }));
        const b = evaluateLevels(fieldsOf({ side: 'sell', entryPrice: '', slPrice: '150.200', tpPrice: '149.600' }));
        return verdict([
          ['買い', a.rr.value === '—' && a.rr.sub === RR_HINT.needEntry && a.issues.length === 0, [a.rr, texts(a)]],
          ['売り', b.rr.value === '—' && b.rr.sub === RR_HINT.needEntry && b.issues.length === 0, [b.rr, texts(b)]],
        ]);
      }),

    t('EF-19', 'RR：売買方向が未選択（毎回未選択から始まる）→ 「—」＋案内、警告なし（Y-10・Y-11 の画面側）', '方向 空・エントリー 150.000・SL 150.200・TP 149.600（売りの並び）', '案内・RR を出さない・警告なし',
      () => {
        const lv = evaluateLevels(fieldsOf({ side: '', slPrice: '150.200', tpPrice: '149.600' }));
        return verdict([['案内', lv.rr.value === '—' && lv.rr.sub === RR_HINT.needEntry, lv.rr], ['警告なし', lv.issues.length === 0, texts(lv)]]);
      }),

    t('EF-20', 'RR：通貨ペアが未選択 → 「—」＋『通貨ペアを選ぶと計算します』（例外にしない・Y-13 の画面側）', '通貨ペア 空・SL・TP あり', '案内・警告なし・例外なし',
      () => {
        const lv = evaluateLevels(fieldsOf({ pair: '', slPrice: '149.800', tpPrice: '150.400' }));
        return verdict([['案内', lv.rr.value === '—' && lv.rr.sub === RR_HINT.needPair, lv.rr], ['警告なし', lv.issues.length === 0, texts(lv)]]);
      }),

    t('EF-21', 'W-01：買いで SL ≧ エントリー（設計どおりの文言）。RR は「—」で2行目なし。保存する値は入力どおり', '買い・SL 150.200・TP 150.400', 'SL の警告のみ・RR —',
      () => {
        const lv = evaluateLevels(fieldsOf({ slPrice: '150.200', tpPrice: '150.400' }));
        return verdict([
          ['警告', sameArray(texts(lv), ['slPrice/warning/買いなのにSLがエントリー価格以上です。SLを建値以上に動かした場合はこのままで問題ありません。']), texts(lv)],
          ['RR', lv.rr.value === '—' && lv.rr.sub === null, lv.rr],
          ['入力どおり保存', lv.slPrice === 150.2 && lv.tpPrice === 150.4, [lv.slPrice, lv.tpPrice]],
        ]);
      }),

    t('EF-22', 'W-01：買いで TP ≦ エントリー／売りで SL ≦ エントリー／売りで TP ≧ エントリー（設計どおりの文言）', '4通りの文言のうち残りの3つ', 'それぞれの文言',
      () => {
        const a = evaluateLevels(fieldsOf({ slPrice: '149.800', tpPrice: '149.900' }));
        const b = evaluateLevels(fieldsOf({ side: 'sell', slPrice: '149.900', tpPrice: '149.500' }));
        const c = evaluateLevels(fieldsOf({ side: 'sell', slPrice: '150.300', tpPrice: '150.100' }));
        return verdict([
          ['買い TP', sameArray(texts(a), ['tpPrice/warning/買いなのにTPがエントリー価格以下です。入力内容を確認してください。']), texts(a)],
          ['売り SL', sameArray(texts(b), ['slPrice/warning/売りなのにSLがエントリー価格以下です。SLを建値以下に動かした場合はこのままで問題ありません。']), texts(b)],
          ['売り TP', sameArray(texts(c), ['tpPrice/warning/売りなのにTPがエントリー価格以上です。入力内容を確認してください。']), texts(c)],
        ]);
      }),

    t('EF-23', 'W-01：SL・TP が両方逆なら2行（SL → TP の順）', '買い・SL 150.100・TP 149.900（Y-02 と同じ）', '2つの警告',
      () => {
        const lv = evaluateLevels(fieldsOf({ slPrice: '150.100', tpPrice: '149.900' }));
        return verdict([['2行', lv.issues.length === 2 && lv.issues[0].field === 'slPrice' && lv.issues[1].field === 'tpPrice', texts(lv)]]);
      }),

    t('EF-24', 'W-03：エントリー価格と SL/TP の差が10%以上（SL・TP の両方でも文は1つ）。W-06：価格帯の目安から外れた SL', '150.000 に対して SL 15.000・TP 1.500', 'W-03 が1つ。SL/TP それぞれの W-06',
      () => {
        const lv = evaluateLevels(fieldsOf({ slPrice: '15.000', tpPrice: '1.500' }));
        const shown = new Set(['slPrice', 'tpPrice']);
        const vis = visibleIssues(lv.issues, shown);
        const w03 = vis.filter((i) => i.text.startsWith('損切り/利確ラインがエントリー価格から大きく離れています'));
        const w06 = vis.filter((i) => i.text.includes('の価格としては大きく外れています'));
        return verdict([
          ['W-03 は1つ', w03.length === 1, w03.length],
          ['W-06 は SL と TP の2つ（欄名つき）', w06.length === 2 && w06[0].text.startsWith('SL（損切り）：USD/JPY の価格としては') && w06[1].text.startsWith('TP（利確）：'), w06.map((i) => i.text)],
        ]);
      }),

    t('EF-25', 'エラー：SL の E-01〜E-03、TP の E-04（欄名つき）。通貨ペア未選択のときは桁数のエラーを出さない', "SL 'abc'・'0'・'149.8001'（JPY）、TP '1.080001'（EUR/USD）、通貨ペア空で '1.2345678'", '設計どおりの文言',
      () => {
        const e1 = evaluateLevels(fieldsOf({ slPrice: 'abc' }));
        const e2 = evaluateLevels(fieldsOf({ slPrice: '0' }));
        const e3 = evaluateLevels(fieldsOf({ slPrice: '149.8001' }));
        const e4 = evaluateLevels(fieldsOf({ pair: 'EUR/USD', side: 'buy', entryPrice: '1.08500', tpPrice: '1.080001' }));
        const e5 = evaluateLevels(fieldsOf({ pair: '', slPrice: '1.2345678' }));
        const e6 = evaluateLevels(fieldsOf({ pair: '', slPrice: 'abc' }));
        return verdict([
          ['E-01', sameArray(texts(e1, 'error'), ['slPrice/error/SL（損切り）：数値で入力してください']), texts(e1)],
          ['E-02', sameArray(texts(e2, 'error'), ['slPrice/error/SL（損切り）：0より大きい値を入力してください']), texts(e2)],
          ['E-03', sameArray(texts(e3, 'error'), ['slPrice/error/SL（損切り）：価格は小数第3位までで入力してください']), texts(e3)],
          ['E-04', sameArray(texts(e4, 'error'), ['tpPrice/error/TP（利確）：価格は小数第5位までで入力してください']), texts(e4)],
          ['ペア未選択は桁数のエラーなし', texts(e5, 'error').length === 0, texts(e5)],
          ['ペア未選択でも数値でなければ E-01', texts(e6, 'error').length === 1, texts(e6)],
          ['エラーの値は保存しない', e1.slPrice === null && e3.slPrice === null, [e1.slPrice, e3.slPrice]],
        ]);
      }),

    t('EF-26', '出してよい欄の分だけ取り出す（欄から離れた・保存を押した欄）。同じ文は1つにまとめる', 'visibleIssues(issues, shown)', 'shown にない欄の文は出ない',
      () => {
        const lv = evaluateLevels(fieldsOf({ slPrice: '150.200', tpPrice: '149.900' }));
        return verdict([
          ['何も離れていない', visibleIssues(lv.issues, new Set()).length === 0, 'NG'],
          ['SL だけ', visibleIssues(lv.issues, new Set(['slPrice'])).length === 1, 'NG'],
          ['両方', visibleIssues(lv.issues, new Set(['slPrice', 'tpPrice'])).length === 2, 'NG'],
          ['同じ文は1つ', visibleIssues([{ field: 'slPrice', type: 'warning', text: 'x' }, { field: 'tpPrice', type: 'warning', text: 'x' }], new Set(['slPrice', 'tpPrice'])).length === 1, 'NG'],
        ]);
      }),

    /* ---------- 保存する任意項目の組み立て ---------- */
    t('EF-27', '保存する任意項目：空の欄は null（根拠・タグは空の配列）。riskReward は渡さない', 'buildOptionalInput(初期値)', 'SL・TP・時間足・感情・メモは null、session は自動の値',
      () => {
        const o = buildOptionalInput(fieldsOf());
        return verdict([
          ['null の項目', o.slPrice === null && o.tpPrice === null && o.timeframe === null && o.emotion === null && o.memo === null, o],
          ['配列', sameArray(o.entryReasons, []) && sameArray(o.tags, []), o],
          ['セッション', o.session === 'newyork', o.session],
          ['riskReward は含めない', !('riskReward' in o), Object.keys(o)],
        ]);
      }),

    t('EF-28', '保存する任意項目：入力した値はそのまま。メモの改行は残し、空白だけのメモは null。キー名は requirements 6.1', 'buildOptionalInput(全項目)', '値が入る・キーがすべて 6.1 にある',
      () => {
        const o = buildOptionalInput(fieldsOf({
          slPrice: '149.800', tpPrice: '150.400', entryReasons: ['ブレイクアウト'], timeframe: 'M15', session: 'london', emotion: '冷静', tags: ['指標前'], memo: '1行目\n2行目',
        }));
        const blank = buildOptionalInput(fieldsOf({ memo: '  \n ' }));
        return verdict([
          ['値', o.slPrice === 149.8 && o.tpPrice === 150.4 && o.timeframe === 'M15' && o.session === 'london' && o.emotion === '冷静', o],
          ['配列', sameArray(o.entryReasons, ['ブレイクアウト']) && sameArray(o.tags, ['指標前']), o],
          ['メモ', o.memo === '1行目\n2行目', o.memo],
          ['空白だけのメモは null', blank.memo === null, blank.memo],
          ['キーは 6.1 のもの', Object.keys(o).every((k) => TRADE_KEYS.includes(k)), Object.keys(o)],
        ]);
      }),

    /* ---------- 損切り幅・利確幅（calc.js） ---------- */
    t('EF-29', '損切り幅・利確幅：買い・売り、JPY・非JPY、最小の 0.1pip（Y-05）', 'calcSlTpPips', 'pips（小数第1位）',
      () => {
        const w = (o) => calcSlTpPips({ pair: 'USD/JPY', side: 'buy', entryPrice: 150, slPrice: 149.8, tpPrice: 150.4, ...o });
        const buy = w({});
        const sell = w({ side: 'sell', slPrice: 150.2, tpPrice: 149.6 });
        const eur = w({ pair: 'EUR/USD', entryPrice: 1.085, slPrice: 1.084, tpPrice: 1.0865 });
        const tiny = w({ slPrice: 149.999, tpPrice: 151 });
        return verdict([
          ['買い', buy.riskPips === 20 && buy.rewardPips === 40, buy],
          ['売り', sell.riskPips === 20 && sell.rewardPips === 40, sell],
          ['非JPY', eur.riskPips === 10 && eur.rewardPips === 15, eur],
          ['0.1pip と 100pips（Y-05：RR 1000）', tiny.riskPips === 0.1 && tiny.rewardPips === 100, tiny],
        ]);
      }),

    t('EF-30', '損切り幅・利確幅：空の値と方向と矛盾する値（W-01）は両方 null。例外にしない', 'calcSlTpPips', '{ riskPips: null, rewardPips: null }',
      () => {
        const none = (o) => {
          const r = calcSlTpPips({ pair: 'USD/JPY', side: 'buy', entryPrice: 150, slPrice: 149.8, tpPrice: 150.4, ...o });
          return r.riskPips === null && r.rewardPips === null;
        };
        return verdict([
          ['SL が空', none({ slPrice: null }), 'NG'],
          ['TP が undefined', none({ tpPrice: undefined }), 'NG'],
          ['エントリー価格が空', none({ entryPrice: null }), 'NG'],
          ['売買方向が空', none({ side: null }), 'NG'],
          ['通貨ペアが空', none({ pair: null }), 'NG'],
          ['SL が利益側', none({ slPrice: 150.2 }), 'NG'],
          ['TP が損失側', none({ tpPrice: 149.9 }), 'NG'],
          ['SL がエントリーと同値', none({ slPrice: 150 }), 'NG'],
        ]);
      }),

    /* ---------- 保存時の再計算（trades.js の recompute） ---------- */
    t('EF-31', '保存時の再計算：SL・TP から riskReward を決める。どちらかが空なら保存しない（null）', 'recompute({SL・TP あり／SL だけ／なし})', '2／null／null',
      () => {
        const base = { pair: 'USD/JPY', side: 'buy', entryPrice: 150, entryAt: '2026-10-15T21:30:00+09:00', exitPrice: null, exitAt: null };
        return verdict([
          ['SL・TP あり', recompute({ ...base, slPrice: 149.8, tpPrice: 150.4 }).riskReward === 2, recompute({ ...base, slPrice: 149.8, tpPrice: 150.4 }).riskReward],
          ['SL だけ', recompute({ ...base, slPrice: 149.8, tpPrice: null }).riskReward === null, 'NG'],
          ['どちらもなし', recompute({ ...base, slPrice: null, tpPrice: null }).riskReward === null, 'NG'],
          ['項目がない記録（undefined）', recompute({ ...base }).riskReward === null, 'NG'],
          ['方向と矛盾（W-01）は null で SL/TP は残す', (() => { const r = recompute({ ...base, slPrice: 150.2, tpPrice: 150.4 }); return r.riskReward === null && r.slPrice === 150.2 && r.tpPrice === 150.4; })(), 'NG'],
          ['エントリー価格が空でも例外にしない', recompute({ ...base, entryPrice: null, slPrice: 149.8, tpPrice: 150.4 }).riskReward === null, 'NG'],
          ['status は決済情報から（open のまま）', recompute({ ...base, status: 'closed', slPrice: 149.8, tpPrice: 150.4 }).status === 'open', 'NG'],
        ]);
      }),

    t('EF-32', '保存時の再計算：セッション。画面で選んだ値は書き換えず、空や知らない値のときだけ日時から判定', 'recompute({session: london/null/zzz})', 'london／newyork／newyork',
      () => {
        const base = { pair: 'USD/JPY', side: 'buy', entryPrice: 150, entryAt: '2026-10-15T21:30:00+09:00', slPrice: null, tpPrice: null };
        return verdict([
          ['手で選んだ値は残る', recompute({ ...base, session: 'london' }).session === 'london', recompute({ ...base, session: 'london' }).session],
          ['空は判定', recompute({ ...base, session: null }).session === 'newyork', recompute({ ...base, session: null }).session],
          ['項目がない記録（undefined）は判定', recompute({ ...base }).session === 'newyork', 'NG'],
          ['知らない値は判定', recompute({ ...base, session: 'zzz' }).session === 'newyork', 'NG'],
        ]);
      }),

    t('EF-33', '保存する記録の組み立て：エントリー画面の入力（必須＋任意）が 6.1 の32項目にそろい、RR・セッションが入る', 'normalizeTrade(recompute(必須6項目 + buildOptionalInput))', 'RR 2・セッション london・根拠/タグは配列・status open',
      () => {
        const f = fieldsOf({ slPrice: '149.800', tpPrice: '150.400', entryReasons: ['ブレイクアウト'], session: 'london', tags: ['指標前'], memo: 'メモ' });
        const input = {
          id: 'e1', accountType: 'real', pair: 'USD/JPY', side: 'buy', entryPrice: 150, lots: 1, entryAt: '2026-10-15T21:30:00+09:00', lotUnitSize: 10000,
          syncStatus: 'pending', syncedAt: null, deletedAt: null, createdAt: '2026-10-15T21:31:00+09:00', updatedAt: '2026-10-15T21:31:00+09:00',
          ...buildOptionalInput(f),
        };
        const r = normalizeTrade(recompute(input));
        return verdict([
          ['32項目', Object.keys(r).length === TRADE_KEYS.length, Object.keys(r).length],
          ['RR・セッション', r.riskReward === 2 && r.session === 'london', [r.riskReward, r.session]],
          ['SL・TP・メモ', r.slPrice === 149.8 && r.tpPrice === 150.4 && r.memo === 'メモ', r],
          ['配列', sameArray(r.entryReasons, ['ブレイクアウト']) && sameArray(r.tags, ['指標前']), r],
          ['status', r.status === 'open', r.status],
          ['必須だけ（任意なし）でも保存できる形', (() => { const x = normalizeTrade(recompute({ ...input, ...buildOptionalInput(fieldsOf()) })); return x.riskReward === null && x.session === 'newyork' && x.slPrice === null; })(), 'NG'],
        ]);
      }),

    /* ---------- タグの「＋追加」（choice-list.js の planTagAdd。名前のチェックは T-16 と共通） ---------- */
    t('EF-34', 'タグの追加：新しい名前は設定の末尾に加わり、チップも増える', "planTagAdd(['ルール違反','指標前'], ['ルール違反','指標前'], ' 逆指値 ')", "list は末尾に『逆指値』（前後の空白は取る）・チップは増やす",
      () => {
        const settings = ['ルール違反', '指標前'];
        const r = planTagAdd(settings, ['ルール違反', '指標前'], ' 逆指値 ');
        return verdict([
          ['ok', r.ok === true && r.name === '逆指値', r],
          ['設定の一覧', r.ok && sameArray(r.list, ['ルール違反', '指標前', '逆指値']), r.list],
          ['チップは増える', r.ok && r.isNewChip === true, 'NG'],
          ['元の配列は変えない', sameArray(settings, ['ルール違反', '指標前']), settings],
        ]);
      }),

    t('EF-35', 'タグの追加：空白だけ（何もしない）・20文字超・同じ名前（設定のタグ）はエラー。文言は設定画面と共通', "planTagAdd(settings, visible, ' ' / 21文字 / '指標前')", "empty / too-long / duplicate",
      () => {
        const settings = ['ルール違反', '指標前'];
        const longName = 'あ'.repeat(CHOICE_NAME_MAX_LENGTH + 1);
        const e1 = planTagAdd(settings, settings, '  　 ');
        const e2 = planTagAdd(settings, settings, longName);
        const e3 = planTagAdd(settings, settings, '指標前');
        const ok20 = planTagAdd(settings, settings, 'あ'.repeat(CHOICE_NAME_MAX_LENGTH));
        return verdict([
          ['空白だけ', e1.ok === false && e1.error === 'empty', e1],
          ['21文字', e2.ok === false && e2.error === 'too-long', e2],
          ['重複', e3.ok === false && e3.error === 'duplicate', e3],
          ['20文字ちょうどは追加できる', ok20.ok === true, ok20],
          ['文言（設定画面と共通）', CHOICE_NAME_ERROR_TEXTS.duplicate === '同じ名前がすでにあります' && CHOICE_NAME_ERROR_TEXTS['too-long'] === '20文字以内で入力してください', CHOICE_NAME_ERROR_TEXTS],
        ]);
      }),

    t('EF-36', 'タグの追加：記録が持っていて設定からは消されたタグを入れ直すと、設定に加えるだけでチップは増やさない', "planTagAdd(['指標前'], ['指標前','旧タグ'], '旧タグ')", 'isNewChip が false・list に加わる',
      () => {
        const r = planTagAdd(['指標前'], ['指標前', '旧タグ'], '旧タグ');
        return verdict([['isNewChip', r.ok && r.isNewChip === false, r], ['設定に加わる', r.ok && sameArray(r.list, ['指標前', '旧タグ']), r.list]]);
      }),

    t('EF-37', 'ロット欄の見本は数字にしない（T-33 U-01：入力済みの値に見えないように）', 'LOTS_PLACEHOLDER',
      "'必須'（数字・小数点を含まない）",
      () => ({ actual: show(LOTS_PLACEHOLDER), pass: LOTS_PLACEHOLDER === '必須' && !/[0-9０-９.．]/.test(LOTS_PLACEHOLDER) })),

    t('EF-38', '記録0件のときの「1lot＝○通貨で計算します（設定で変更）」（T-33 U-02）：選んだ口座の今の設定値', "lotUnitHint('real'／'demo'／''（未選択）, { demo, real })",
      "本番1万・デモ10万：'real'→1万／'demo'→10万／未選択→両方。両方同じなら未選択でもその値。値が壊れていれば ''",
      () => {
        const sizes = { demo: 100000, real: 10000 };
        const real = lotUnitHint('real', sizes);
        const demo = lotUnitHint('demo', sizes);
        const both = lotUnitHint('', sizes);
        const same = lotUnitHint('', { demo: 10000, real: 10000 });
        const broken = lotUnitHint('real', { demo: 10000, real: null });
        return verdict([
          ['本番', real === '1lot＝1万通貨で計算します（設定で変更）', real],
          ['デモ', demo === '1lot＝10万通貨で計算します（設定で変更）', demo],
          ['未選択・値が違う', both === '1lot＝本番1万・デモ10万通貨で計算します（設定で変更）', both],
          ['未選択・値が同じ', same === '1lot＝1万通貨で計算します（設定で変更）', same],
          ['値が読めない', broken === '', broken],
        ]);
      }),

    t('EF-39', '価格・ロット・SL の上限のエラー文（T-33 R-01）：価格は通貨ペアを選ぶ前でも出す', "エントリー価格 '1000000'（通貨ペア未選択）・ロット '20000000'・SL '5000000'",
      "'エントリー価格：1,000,000未満の値で入力してください'・'ロット：10,000,000以下で入力してください'・'SL（損切り）：1,000,000未満の値で入力してください'",
      () => {
        const f = { accountType: 'real', pair: '', side: 'buy', entryPrice: '1000000', lots: '20000000', entryAt: '2026-10-15T21:30', ...defaultOptionalFields('2026-10-15T21:30'), slPrice: '5000000' };
        const issues = checkRequiredFields(f);
        const text = (field) => (issues.find((i) => i.field === field) || {}).text;
        const sl = evaluateLevels({ ...f, pair: 'USD/JPY', entryPrice: '150' }).issues.find((i) => i.field === 'slPrice');
        return verdict([
          ['価格', text('entryPrice') === 'エントリー価格：1,000,000未満の値で入力してください', text('entryPrice')],
          ['ロット', text('lots') === 'ロット：10,000,000以下で入力してください', text('lots')],
          ['SL', sl && sl.text === 'SL（損切り）：1,000,000未満の値で入力してください', sl && sl.text],
        ]);
      }),

    t('EF-40', '2000〜2099 年の外の日時は「日時を入力してください」（T-33 R-09）', "entryAt '0500-01-01T10:00'／'2100-01-01T00:00'",
      'どちらもエラー「日時を入力してください」',
      () => {
        const base = { accountType: 'real', pair: 'USD/JPY', side: 'buy', entryPrice: '150', lots: '0.1' };
        const a = checkRequiredFields({ ...base, entryAt: '0500-01-01T10:00' }).find((i) => i.field === 'entryAt');
        const b = checkRequiredFields({ ...base, entryAt: '2100-01-01T00:00' }).find((i) => i.field === 'entryAt');
        return verdict([
          ['0500年', a && a.text === '日時を入力してください', a && a.text],
          ['2100年', b && b.text === '日時を入力してください', b && b.text],
        ]);
      }),
  ];
}
